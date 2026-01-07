const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs'); // Import fs
const path = require('path'); // Import path
const app = express();

const port = process.env.PORT || 3000;
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE_NAME = 'Patrolling Report'; 
const ATTACHMENT_FIELD = 'Approval Attachment';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL; // Required for Airtable to fetch the PDF

app.use(express.json());
// Create a folder named 'temp_pdfs' and only serve that
app.use('/public', express.static(path.join(__dirname, 'public')));

app.post('/generate-pdf', async (req, res) => {
    const secret = req.headers['x-auth-token'];
    if (secret !== process.env.INTERNAL_AUTH_TOKEN) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    // We only need htmlContent and recordId from Airtable
    const { htmlContent, recordId } = req.body;

    if (!htmlContent || !recordId) {
        return res.status(400).json({ error: 'Missing htmlContent or recordId' });
    }

    try {
        console.log(`Generating PDF for Record: ${recordId}`);
        const pdfBuffer = await generatePDFFromHTML(htmlContent);
        
        // Use the corrected function call (2 arguments)
        const success = await uploadPDFToAirtable(pdfBuffer, recordId);

        if (success) {
            res.status(200).send({ message: 'PDF generated and attached successfully.' });
        } else {
            res.status(500).send({ error: 'Failed to upload PDF to Airtable.' });
        }
        
    } catch (error) {
        console.error('Processing error:', error);
        res.status(500).send({ error: error.message });
    }
});

app.listen(port, () => {
    console.log(`PDF Worker running on port ${port}`);
});

async function generatePDFFromHTML(html) {
    const browser = await puppeteer.launch({ 
        headless: "new",
        
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage', // Helps prevent 'Out of Memory' crashes
            '--single-process' // Added for better stability in small containers
        ] 
    });
    
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    
    const pdfBuffer = await page.pdf({ 
        format: 'A4', 
        printBackground: true 
    });

    await browser.close();
    return pdfBuffer;
}

async function uploadPDFToAirtable(pdfBuffer, recordId) {
    const fileName = `Report_${recordId}_${Date.now()}.pdf`;
    const publicDir = path.join(__dirname, 'public');

    // 1. Ensure public directory exists
    if (!fs.existsSync(publicDir)) {
        fs.mkdirSync(publicDir);
    }

    const filePath = path.join(publicDir, fileName);
    
    // 2. Write the file to disk
    fs.writeFileSync(filePath, pdfBuffer);

    // 3. Construct the clean URL
    const base = process.env.PUBLIC_BASE_URL.replace(/\/$/, ""); 
    const publicUrl = `${base}/public/${fileName}`;
    
    console.log(`File available for Airtable fetch at: ${publicUrl}`);

    // 4. Update Airtable
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
                    [ATTACHMENT_FIELD]: [{ url: publicUrl }]
                }
            }]
        })
    });

    // --- ADDED: CLEANUP FUNCTION ---
    // Wait 60 seconds, then delete the file to save space
    setTimeout(() => {
        fs.unlink(filePath, (err) => {
            if (err) {
                console.error(`Cleanup Error for ${fileName}:`, err);
            } else {
                console.log(`Cleanup Success: Deleted temporary file ${fileName}`);
            }
        });
    }, 60000); // 60,000ms = 60 seconds
    // -------------------------------

    return response.ok;
}
