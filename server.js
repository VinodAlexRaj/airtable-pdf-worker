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

app.use(express.json());

// FIXED: Specifically serve the public folder for PDF downloads
app.use('/public', express.static(path.join(__dirname, 'public')));

app.post('/generate-pdf', async (req, res) => {
    const secret = req.headers['x-auth-token'];
    if (secret !== INTERNAL_AUTH_TOKEN) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { htmlContent, recordId } = req.body;
    if (!htmlContent || !recordId) {
        return res.status(400).json({ error: 'Missing data' });
    }

    try {
        const pdfBuffer = await generatePDFFromHTML(htmlContent);
        const success = await uploadPDFToAirtable(pdfBuffer, recordId);

        if (success) {
            res.status(200).send({ message: 'PDF generated and attached.' });
        } else {
            res.status(500).send({ error: 'Airtable upload failed.' });
        }
    } catch (error) {
        console.error('Server Error:', error);
        res.status(500).send({ error: error.message });
    }
});

async function generatePDFFromHTML(html) {
    const browser = await puppeteer.launch({ 
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] 
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });
    await browser.close();
    return pdfBuffer;
}

async function uploadPDFToAirtable(pdfBuffer, recordId) {
    const fileName = `Report_${recordId}.pdf`;
    const publicDir = path.join(__dirname, 'public');
    
    if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir);
    const filePath = path.join(publicDir, fileName);
    fs.writeFileSync(filePath, pdfBuffer);

    const base = PUBLIC_BASE_URL.replace(/\/$/, ""); 
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
                        filename: fileName // CRITICAL FIX: Tells Airtable (and Softr) the real name
                    }]
                }
            }]
        })
    });

    // Auto-cleanup after 60 seconds
    setTimeout(() => {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }, 60000);

    return response.ok;
}

app.listen(port, () => console.log(`Worker running on port ${port}`));