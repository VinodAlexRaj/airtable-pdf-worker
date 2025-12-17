const express = require('express');
const puppeteer = require('puppeteer');
const app = express();
const port = process.env.PORT || 3000; // Use port 3000 locally, or DigitalOcean's port
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE_NAME = 'Patrolling Report';
const ATTACHMENT_FIELD = 'Approval Attachment';

// Middleware to parse JSON requests from Airtable
app.use(express.json());
app.use(express.static(__dirname));

// --- The POST endpoint Airtable will call ---
app.post('/generate-pdf', async (req, res) => {
    // 1. Get the data passed from the Airtable Automation script
    const { htmlContent, recordId } = req.body;

    if (!htmlContent || !recordId) {
        return res.status(400).json({ error: 'Missing htmlContent or recordId' });
    }

    try {
        // 2. Generate the PDF (Function defined in Step 5)
        const pdfBuffer = await generatePDFFromHTML(htmlContent);
        
        // 3. Upload the PDF back to Airtable (Function defined in Step 6)
        const success = await uploadPDFToAirtable(pdfBuffer, recordId, tableName, apiKey);

        if (success) {
            res.status(200).send({ message: 'PDF generated and attached successfully.' });
        } else {
            res.status(500).send({ error: 'Failed to upload PDF to Airtable.' });
        }
        
    } catch (error) {
        console.error('Processing error:', error);
        res.status(500).send({ error: 'Internal server error during PDF generation or upload.' });
    }
});


// Start the server
app.listen(port, () => {
    console.log(`PDF Worker running on port ${port}`);
});

// Define functions below (Steps 5 and 6)
async function generatePDFFromHTML(html) {
    // Puppeteer requires a browser instance to render the HTML
    const browser = await puppeteer.launch({ 
        // This argument is necessary for Puppeteer to run reliably on Linux/server environments
        args: ['--no-sandbox']
    });
    
    const page = await browser.newPage();
    
    // Set the HTML content provided by Airtable
    await page.setContent(html, { waitUntil: 'networkidle0' });
    
    // Generate the PDF buffer
    const pdfBuffer = await page.pdf({ 
        format: 'A4',
        printBackground: true
    });

    await browser.close();
    return pdfBuffer; // Returns the raw file data
}
// --- Airtable Upload Function (Step 6) ---
// This requires the 'axios' library or a native 'fetch' implementation in Node.js
// If using Node.js v18+, you can use native fetch. If older, use 'npm install axios'.

async function uploadPDFToAirtable(pdfBuffer, recordId) {
    const fileName = `Report_${recordId}.pdf`;

    // Save file temporarily
    const fs = require('fs');
    const path = require('path');
    const filePath = path.join(__dirname, fileName);
    fs.writeFileSync(filePath, pdfBuffer);

    // Serve it publicly (temporary)
    const publicUrl = `${process.env.PUBLIC_BASE_URL}/${fileName}`;

    // Update Airtable
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

    return response.ok;
}