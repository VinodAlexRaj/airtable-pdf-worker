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
    const MAX_DIMENSION_FEW = 1600;    // ≤ 6 images: higher quality
    const MAX_DIMENSION_MANY = 1200;   // 7–12 images: balanced
    const MAX_DIMENSION_LOTS = 800;    // 13+ images: aggressive downscale
    const QUALITY_FEW = 90;
    const QUALITY_MANY = 80;
    const QUALITY_LOTS = 70;
    const MAX_FINAL_SIZE_BYTES = 5 * 1024 * 1024; // Skip if still >5MB after resize

    // Step 1: Extract unique URLs
    const imageUrls = [];
    const regex = /<img[^>]+src="(https?:\/\/[^"]+)"/g;
    let match;
    while ((match = regex.exec(html)) !== null) {
        if (!imageUrls.includes(match[1])) {
            imageUrls.push(match[1]);
        }
    }

    console.log(`Found ${imageUrls.length} unique image(s) in HTML`);

    // Step 2: Pre-fetch all images in parallel and measure total size
    console.log('Pre-checking image sizes...');
    const imageDataMap = new Map(); // url -> Buffer
    let totalBytes = 0;

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
            imageDataMap.set(url, buffer);
            totalBytes += buffer.byteLength;

        } catch (err) {
            console.warn(`Failed to fetch image, leaving original URL: ${url} — ${err.message}`);
        }
    }));

    const totalMB = (totalBytes / 1024 / 1024).toFixed(2);
    const fetchedCount = imageDataMap.size;
    console.log(`Successfully fetched ${fetchedCount}/${imageUrls.length} image(s) — Total size: ${totalMB}MB`);

    // Step 3: Decide strategy based on count and total size
    let maxDimension, quality, strategy;

    if (fetchedCount <= 6 && totalBytes < 20 * 1024 * 1024) {
        maxDimension = MAX_DIMENSION_FEW;
        quality = QUALITY_FEW;
        strategy = 'high quality (≤6 images)';
    } else if (fetchedCount <= 12 && totalBytes < 40 * 1024 * 1024) {
        maxDimension = MAX_DIMENSION_MANY;
        quality = QUALITY_MANY;
        strategy = 'balanced (7–12 images)';
    } else {
        maxDimension = MAX_DIMENSION_LOTS;
        quality = QUALITY_LOTS;
        strategy = 'aggressive (13+ images or large total size)';
    }

    console.log(`Using strategy: ${strategy} — maxDimension: ${maxDimension}px, quality: ${quality}%`);

    // Step 4: Process and inline each image
    await Promise.all(imageUrls.map(async (url) => {
        const buffer = imageDataMap.get(url);
        if (!buffer) return; // Fetch failed earlier, leave original URL

        try {
            const image = sharp(buffer);
            const metadata = await image.metadata();

            console.log(`Processing image ${metadata.width}x${metadata.height} (${Math.round(buffer.byteLength / 1024)}KB): ${url}`);

            const needsResize = metadata.width > maxDimension || metadata.height > maxDimension;
            let finalBuffer;
            let mimeType = 'image/jpeg';

            if (needsResize) {
                finalBuffer = await image
                    .resize(maxDimension, maxDimension, {
                        fit: 'inside',
                        withoutEnlargement: true
                    })
                    .jpeg({ quality })
                    .toBuffer();
            } else {
                if (metadata.format !== 'png' || !metadata.hasAlpha) {
                    finalBuffer = await image.jpeg({ quality }).toBuffer();
                } else {
                    finalBuffer = buffer;
                    mimeType = 'image/png';
                }
            }

            if (finalBuffer.byteLength > MAX_FINAL_SIZE_BYTES) {
                console.warn(`Skipping image even after resize (${Math.round(finalBuffer.byteLength / 1024)}KB): ${url}`);
                return; // Leave original URL
            }

            const base64 = finalBuffer.toString('base64');
            const dataUrl = `data:${mimeType};base64,${base64}`;
            html = html.replaceAll(url, dataUrl);

            console.log(`Inlined image → ${Math.round(finalBuffer.byteLength / 1024)}KB: ${url}`);

        } catch (sharpErr) {
            console.warn(`Sharp processing failed, using original: ${sharpErr.message}`);
            // Leave original URL in HTML
        }
    }));

    const finalCount = (html.match(/data:image\//g) || []).length;
    console.log(`Inlining complete — ${finalCount}/${imageUrls.length} image(s) inlined`);

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
