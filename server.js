const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const app = express();
const port = process.env.PORT || 3000;
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE_NAME = 'Patrolling Report'; 
const ATTACHMENT_FIELD = 'Approval Attachment';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL;
const INTERNAL_AUTH_TOKEN = process.env.INTERNAL_AUTH_TOKEN;
const CLEANUP_DELAY_MS = 60000; // 1 minute

app.use(express.json());
app.use('/public', express.static(path.join(__dirname, 'public')));

app.post('/generate-pdf', async (req, res) => {
    const secret = req.headers['x-auth-token'];
    if (secret !== INTERNAL_AUTH_TOKEN) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { htmlContent, recordId, location } = req.body;
    if (!htmlContent || !recordId || !location) {
        return res.status(400).json({ error: 'Missing required fields: htmlContent, recordId, and location' });
    }

    try {
        const pdfBuffer = await generatePDFFromHTML(htmlContent);
        const success = await uploadPDFToAirtable(pdfBuffer, recordId, location);
        
        if (success) {
            res.status(200).json({ message: 'PDF generated and attached successfully.' });
        } else {
            res.status(500).json({ error: 'Failed to upload PDF to Airtable.' });
        }
    } catch (error) {
        console.error('PDF generation error:', error.message);
        res.status(500).json({ error: error.message || 'Internal server error' });
    }
});

async function generatePDFFromHTML(html) {
    let browser = null;
    try {
        browser = await puppeteer.launch({ 
            headless: "new",
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] 
        });
        
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle0' });
        const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });
        
        return pdfBuffer;
    } catch (error) {
        console.error('Puppeteer error:', error.message);
        throw new Error(`PDF generation failed: ${error.message}`);
    } finally {
        if (browser) {
            await browser.close().catch(err => 
                console.error('Error closing browser:', err.message)
            );
        }
    }
}

function generateFileName(recordId, location) {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const dateStr = `${year}${month}${day}`;
    
    return `Report-${dateStr}-${location}-${recordId}.pdf`;
}

async function uploadPDFToAirtable(pdfBuffer, recordId, location) {
    const fileName = generateFileName(recordId, location);
    const publicDir = path.join(__dirname, 'public');
    const filePath = path.join(publicDir, fileName);

    try {
        // Ensure public directory exists
        if (!fs.existsSync(publicDir)) {
            fs.mkdirSync(publicDir, { recursive: true });
        }

        // Write PDF file
        await fs.promises.writeFile(filePath, pdfBuffer);
        console.log(`File saved: ${fileName}`);

        // Construct public URL
        const base = PUBLIC_BASE_URL.replace(/\/$/, ""); 
        const publicUrl = `${base}/public/${fileName}`;

        // Upload to Airtable
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
            })
        });

        if (!response.ok) {
            const errorData = await response.text();
            throw new Error(`Airtable API returned ${response.status}: ${errorData}`);
        }

        // Schedule cleanup (fire and forget)
        scheduleFileCleanup(filePath, fileName);

        return true;
    } catch (error) {
        console.error(`Airtable upload error for ${fileName}:`, error.message);
        // Clean up file immediately on error
        await cleanupFile(filePath, fileName);
        throw error;
    }
}

function scheduleFileCleanup(filePath, fileName) {
    setTimeout(async () => {
        await cleanupFile(filePath, fileName);
    }, CLEANUP_DELAY_MS);
}

async function cleanupFile(filePath, fileName) {
    try {
        if (fs.existsSync(filePath)) {
            await fs.promises.unlink(filePath);
            console.log(`Cleanup success: Deleted ${fileName}`);
        } else {
            console.log(`Cleanup skip: File ${fileName} already removed`);
        }
    } catch (err) {
        console.error(`Cleanup error for ${fileName}:`, err.message);
    }
}

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
    console.log(`Public base URL: ${PUBLIC_BASE_URL}`);
});
