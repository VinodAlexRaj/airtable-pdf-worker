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

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb' }));
app.use('/public', express.static(path.join(__dirname, 'public')));

// Browser pool for faster PDF generation
let browserInstance = null;

async function getBrowser() {
    if (!browserInstance) {
        browserInstance = await puppeteer.launch({ 
            headless: "new",
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--single-process', // Use with caution - can improve performance on constrained systems
                '--no-first-run',
                '--no-default-browser-check'
            ],
            timeout: 30000
        });
    }
    return browserInstance;
}

app.post('/generate-pdf', async (req, res) => {
    const secret = req.headers['x-auth-token'];
    if (secret !== INTERNAL_AUTH_TOKEN) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { htmlContent, recordId, location } = req.body;
    if (!htmlContent || !recordId || !location) {
        return res.status(400).json({ error: 'Missing required fields: htmlContent, recordId, and location' });
    }

    let timeoutId;
    try {
        // Set a timeout for the entire operation (45 seconds to stay under DigitalOcean's 60s limit)
        const timeoutPromise = new Promise((_, reject) => {
            timeoutId = setTimeout(() => {
                reject(new Error('PDF generation timeout: exceeded 45 seconds'));
            }, 45000);
        });

        const generatePromise = (async () => {
            const pdfBuffer = await generatePDFFromHTML(htmlContent);
            const success = await uploadPDFToAirtable(pdfBuffer, recordId, location);
            
            if (success) {
                return { status: 200, data: { message: 'PDF generated and attached successfully.' } };
            } else {
                return { status: 500, data: { error: 'Failed to upload PDF to Airtable.' } };
            }
        })();

        const result = await Promise.race([generatePromise, timeoutPromise]);
        clearTimeout(timeoutId);
        res.status(result.status).json(result.data);
    } catch (error) {
        clearTimeout(timeoutId);
        console.error('PDF generation error:', error.message);
        res.status(500).json({ error: error.message || 'Internal server error' });
    }
});

async function generatePDFFromHTML(html) {
    let page = null;
    try {
        const browser = await getBrowser();
        page = await browser.newPage();
        
        // Set viewport and other options for faster rendering
        await page.setViewport({ width: 1200, height: 1600 });
        
        // Set content with a shorter timeout for complex pages
        await page.setContent(html, { 
            waitUntil: 'networkidle2',
            timeout: 30000
        });

        // Remove external font loading to speed up rendering
        await page.evaluate(() => {
            const links = document.querySelectorAll('link[href*="googleapis"]');
            links.forEach(link => link.remove());
        });

        // Generate PDF with optimized settings
        const pdfBuffer = await page.pdf({ 
            format: 'A4',
            printBackground: true,
            margin: { top: 20, bottom: 20, left: 20, right: 20 },
            timeout: 30000
        });
        
        return pdfBuffer;
    } catch (error) {
        console.error('Puppeteer error:', error.message);
        throw new Error(`PDF generation failed: ${error.message}`);
    } finally {
        // Close page but keep browser alive for reuse
        if (page) {
            try {
                await page.close();
            } catch (err) {
                console.error('Error closing page:', err.message);
            }
        }
    }
}

function generateFileName(location) {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const dateStr = `${year}${month}${day}`;
    const timestamp = Date.now();
    
    return `Report-${dateStr}-${location}-${timestamp}.pdf`;
}

async function uploadPDFToAirtable(pdfBuffer, recordId, location) {
    const fileName = generateFileName(location);
    const publicDir = path.join(__dirname, 'public');
    const filePath = path.join(publicDir, fileName);

    try {
        // Ensure public directory exists
        if (!fs.existsSync(publicDir)) {
            fs.mkdirSync(publicDir, { recursive: true });
        }

        // Write PDF file with error handling
        await fs.promises.writeFile(filePath, pdfBuffer);
        console.log(`File saved: ${fileName}`);

        // Construct public URL
        const base = PUBLIC_BASE_URL.replace(/\/$/, ""); 
        const publicUrl = `${base}/public/${fileName}`;

        // Upload to Airtable with timeout
        const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE_NAME)}`;
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000); // 15 second timeout for Airtable

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
            signal: controller.signal
        });

        clearTimeout(timeoutId);

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
    // Cleanup after 1 minute
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

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('SIGTERM received, closing browser...');
    if (browserInstance) {
        await browserInstance.close();
    }
    process.exit(0);
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
    console.log(`Public base URL: ${PUBLIC_BASE_URL}`);
});
