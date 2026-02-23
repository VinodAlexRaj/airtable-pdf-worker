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
const sharp = require('sharp');

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb' }));
app.use('/public', express.static(path.join(__dirname, 'public')));

// Browser pool for faster PDF generation
let browserInstance = null;

async function getBrowser() {
    if (browserInstance) {
        try {
            // Check if browser is still alive
            await browserInstance.version();
        } catch {
            console.log('Browser crashed, restarting...');
            browserInstance = null;
        }
    }
    if (!browserInstance) {
        browserInstance = await puppeteer.launch({ 
            headless: "new",
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
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

    // Respond immediately — don't await
    res.status(202).json({ message: 'PDF generation started. It will be attached to the record shortly.' });

    // Process in background
    (async () => {
        try {
            const pdfBuffer = await generatePDFFromHTML(htmlContent);
            await uploadPDFToAirtable(pdfBuffer, recordId, location);
            console.log(`PDF successfully attached to record ${recordId}`);
        } catch (error) {
            console.error(`Background PDF generation failed for record ${recordId}:`, error.message);
        }
    })();
});

async function inlineImages(html) {
    const MAX_DIMENSION = 1200;      // Max width or height in pixels
    const MAX_SIZE_BYTES = 5 * 1024 * 1024; // Skip entirely if over 5MB even after resize attempt
    const imageUrls = [];
    const regex = /<img[^>]+src="(https?:\/\/[^"]+)"/g;
    let match;

    while ((match = regex.exec(html)) !== null) {
        if (!imageUrls.includes(match[1])) {
            imageUrls.push(match[1]); // Deduplicate
        }
    }

    console.log(`Inlining ${imageUrls.length} images...`);

    await Promise.all(imageUrls.map(async (url) => {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 15000);

            const response = await fetch(url, { signal: controller.signal });
            clearTimeout(timeoutId);

            if (!response.ok) {
                console.warn(`Skipping image (fetch failed ${response.status}): ${url}`);
                return;
            }

            const buffer = Buffer.from(await response.arrayBuffer());

            let finalBuffer;
            let mimeType = 'image/jpeg';

            try {
                // Get image metadata first
                const image = sharp(buffer);
                const metadata = await image.metadata();

                const needsResize = metadata.width > MAX_DIMENSION || metadata.height > MAX_DIMENSION;

                if (needsResize) {
                    console.log(`Resizing image ${metadata.width}x${metadata.height} → max ${MAX_DIMENSION}px: ${url}`);
                    finalBuffer = await image
                        .resize(MAX_DIMENSION, MAX_DIMENSION, {
                            fit: 'inside',       // Maintain aspect ratio
                            withoutEnlargement: true
                        })
                        .jpeg({ quality: 80 })   // Convert to JPEG to save memory
                        .toBuffer();
                    mimeType = 'image/jpeg';
                } else {
                    // Still convert to JPEG for memory consistency unless it's PNG with transparency
                    if (metadata.format !== 'png' || !metadata.hasAlpha) {
                        finalBuffer = await image
                            .jpeg({ quality: 85 })
                            .toBuffer();
                        mimeType = 'image/jpeg';
                    } else {
                        finalBuffer = buffer;
                        mimeType = 'image/png';
                    }
                }

                if (finalBuffer.byteLength > MAX_SIZE_BYTES) {
                    console.warn(`Skipping image even after resize (${Math.round(finalBuffer.byteLength / 1024)}KB): ${url}`);
                    return; // Leave original URL in HTML
                }

            } catch (sharpErr) {
                console.warn(`Sharp processing failed, using original: ${sharpErr.message}`);
                finalBuffer = buffer;
                mimeType = response.headers.get('content-type') || 'image/jpeg';
            }

            const base64 = finalBuffer.toString('base64');
            const dataUrl = `data:${mimeType};base64,${base64}`;
            html = html.replaceAll(url, dataUrl);

            console.log(`Inlined image (${Math.round(finalBuffer.byteLength / 1024)}KB): ${url}`);

        } catch (err) {
            console.warn(`Failed to inline image, leaving original URL: ${url} — ${err.message}`);
            // Original URL stays in HTML — Puppeteer will try to fetch it directly
        }
    }));

    return html;
}

async function generatePDFFromHTML(html, retries = 1) {
    let page = null;
    try {
        const browser = await getBrowser();
        page = await browser.newPage();

        await page.setViewport({ width: 1200, height: 1600 });

        // Pre-fetch all images as base64 so Puppeteer doesn't need to fetch anything
        html = await inlineImages(html);

        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const url = req.url();
            if (url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com')) {
                req.abort();
            } else {
                req.continue();
            }
        });

        await page.setContent(html, { 
            waitUntil: 'domcontentloaded', // Back to fast — no external images to wait for
            timeout: 30000
        });

        const pdfBuffer = await page.pdf({ 
            format: 'A4',
            printBackground: true,
            margin: { top: 20, bottom: 20, left: 20, right: 20 },
            timeout: 30000
        });
        
        return pdfBuffer;
    } catch (error) {
        console.error('Puppeteer error:', error.message);

        if (retries > 0 && (
            error.message.includes('detached') ||
            error.message.includes('Connection closed') ||
            error.message.includes('Target closed')
        )) {
            console.log(`Retrying PDF generation... (${retries} attempt(s) left)`);
            browserInstance = null;
            return generatePDFFromHTML(html, retries - 1);
        }

        throw new Error(`PDF generation failed: ${error.message}`);
    } finally {
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

process.on('SIGTERM', async () => {
    console.error('Process received signal: SIGTERM');
    if (browserInstance) {
        await browserInstance.close();
    }
    process.exit(0);
});

process.on('SIGINT', () => {
    console.error('Process received signal: SIGINT');
    process.exit(0);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err.message, err.stack);
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Rejection:', reason);
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
    console.log(`Public base URL: ${PUBLIC_BASE_URL}`);
});
