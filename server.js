const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const app = express();
const port = process.env.PORT || 3000;

// Validate environment variables
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE_NAME = 'Patrolling Report';
const ATTACHMENT_FIELD = 'Approval Attachment';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL;
const INTERNAL_AUTH_TOKEN = process.env.INTERNAL_AUTH_TOKEN;

// Validate required environment variables on startup
if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID || !PUBLIC_BASE_URL || !INTERNAL_AUTH_TOKEN) {
    console.error('Missing required environment variables');
    process.exit(1);
}

app.use(express.json());
app.use('/public', express.static(path.join(__dirname, 'public')));

// Track active browser instances for cleanup
const activeBrowsers = new Set();

app.post('/generate-pdf', async (req, res) => {
    const secret = req.headers['x-auth-token'];
    if (secret !== INTERNAL_AUTH_TOKEN) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { htmlContent, recordId } = req.body;
    if (!htmlContent || !recordId) {
        return res.status(400).json({ error: 'Missing htmlContent or recordId' });
    }

    if (typeof htmlContent !== 'string' || typeof recordId !== 'string') {
        return res.status(400).json({ error: 'Invalid data types' });
    }

    let filePath = null;
    try {
        const pdfBuffer = await generatePDFFromHTML(htmlContent);
        filePath = path.join(__dirname, 'public', `Report_${recordId}.pdf`);
        
        const success = await uploadPDFToAirtable(pdfBuffer, recordId, filePath);
        
        if (success) {
            res.status(200).json({ message: 'PDF generated and attached successfully', recordId });
        } else {
            res.status(500).json({ error: 'Airtable upload failed' });
        }
    } catch (error) {
        console.error('PDF generation error:', error.message);
        
        // Attempt immediate cleanup on error
        if (filePath) {
            await cleanupFile(filePath);
        }
        
        res.status(500).json({ 
            error: error.message || 'Internal server error',
            recordId 
        });
    }
});

async function generatePDFFromHTML(html) {
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });
        
        activeBrowsers.add(browser);
        
        const page = await browser.newPage();
        
        // Add timeout to prevent hanging pages
        page.setDefaultNavigationTimeout(30000);
        page.setDefaultTimeout(30000);
        
        await page.setContent(html, { waitUntil: 'networkidle0' });
        const pdfBuffer = await page.pdf({ 
            format: 'A4', 
            printBackground: true,
            timeout: 30000
        });
        
        await page.close();
        return pdfBuffer;
        
    } catch (error) {
        throw new Error(`PDF generation failed: ${error.message}`);
    } finally {
        if (browser) {
            try {
                await browser.close();
                activeBrowsers.delete(browser);
            } catch (err) {
                console.error('Error closing browser:', err.message);
                activeBrowsers.delete(browser);
            }
        }
    }
}

async function uploadPDFToAirtable(pdfBuffer, recordId, filePath) {
    try {
        // Ensure public directory exists
        const publicDir = path.dirname(filePath);
        if (!fs.existsSync(publicDir)) {
            fs.mkdirSync(publicDir, { recursive: true });
        }

        // Validate buffer
        if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.length === 0) {
            throw new Error('Invalid PDF buffer');
        }

        // Write file synchronously to ensure it exists before upload
        fs.writeFileSync(filePath, pdfBuffer);

        const fileName = path.basename(filePath);
        const base = PUBLIC_BASE_URL.replace(/\/$/, '');
        const publicUrl = `${base}/public/${fileName}`;

        const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE_NAME)}`;
        
        const response = await fetch(url, {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                records: [{
                    id: recordId,
                    fields: {
                        [ATTACHMENT_FIELD]: [{
                            url: publicUrl,
                            filename: fileName
                        }]
                    }
                }]
            }),
            timeout: 15000
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Airtable API error: ${response.status} - ${errorText}`);
        }

        // Schedule cleanup after successful upload (1 minute delay)
        scheduleFileCleanup(filePath, fileName);

        return true;

    } catch (error) {
        console.error('Airtable upload error:', error.message);
        
        // Attempt immediate cleanup on failure
        await cleanupFile(filePath);
        
        throw error;
    }
}

async function cleanupFile(filePath) {
    try {
        if (!filePath) return;
        
        if (fs.existsSync(filePath)) {
            await fs.promises.unlink(filePath);
            console.log(`Cleanup success: Deleted ${path.basename(filePath)}`);
        }
    } catch (err) {
        console.error(`Cleanup error for ${path.basename(filePath)}:`, err.message);
    }
}

function scheduleFileCleanup(filePath, fileName) {
    setTimeout(async () => {
        await cleanupFile(filePath);
    }, 60000); // 60 seconds
}

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('Shutting down gracefully...');
    
    // Close active browsers
    for (const browser of activeBrowsers) {
        try {
            await browser.close();
        } catch (err) {
            console.error('Error closing browser during shutdown:', err.message);
        }
    }
    
    process.exit(0);
});

app.listen(port, () => {
    console.log(`Worker running on port ${port}`);
});
