/*
PATRIOLLY — SITE ASSESSMENT PDF WORKER EXTENSION
Additive extension for VinodAlexRaj/airtable-pdf-worker.

POST /generate-site-assessment-pdf
- Auth: x-auth-token = REPORT_PDF_AUTH_TOKEN
- Input: htmlContent, recordId, assessmentId
- Generates A4 PDF with Puppeteer
- Refuses to overwrite Site Assessment PDF
- Writes attachment to Airtable Site Assessment.Site Assessment PDF
- Returns SUCCESS only after Airtable accepts the attachment write
*/

const fs = require('fs');
const path = require('path');

const CONFIG = {
    route: '/generate-site-assessment-pdf',
    airtableTableName: 'Site Assessment',
    attachmentField: 'Site Assessment PDF',
    cleanupDelayMs: 60000,
    airtableRequestTimeoutMs: 6000,
    generationDeadlineMs: 22000,
    pdfTimeoutMs: 18000,
    viewportWidth: 1200,
    viewportHeight: 1600,
};

module.exports = function registerSiteAssessmentPdfExtension(context) {
    const {
        app,
        getBrowser,
        scheduleIdleClose,
        publicBaseUrl,
        reportPdfAuthToken,
        airtableApiKey,
        airtableBaseId,
    } = context || {};

    validateContext({
        app,
        getBrowser,
        publicBaseUrl,
        reportPdfAuthToken,
        airtableApiKey,
        airtableBaseId,
    });

    app.post(CONFIG.route, async (req, res) => {
        if (req.headers['x-auth-token'] !== reportPdfAuthToken) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const htmlContent = String(req.body?.htmlContent || '').trim();
        const recordId = String(req.body?.recordId || '').trim();
        const assessmentId = String(req.body?.assessmentId || '').trim();
        if (!htmlContent || !recordId || !assessmentId) {
            return res.status(400).json({
                error: 'Missing required fields: htmlContent, recordId, assessmentId',
            });
        }

        const filename = buildAttachmentFilename(assessmentId);
        console.log(`[PATRIOLLY][SITE_ASSESSMENT_PDF_WORKER][START] recordId=${recordId} assessmentId=${assessmentId}`);

        try {
            await assertAttachmentFieldEmpty({ recordId, airtableApiKey, airtableBaseId });
            const pdfBuffer = await withDeadline(
                generatePdf({ htmlContent, getBrowser }),
                CONFIG.generationDeadlineMs,
                'PDF generation deadline exceeded'
            );
            const attachment = await attachPdfToAirtable({
                pdfBuffer,
                recordId,
                filename,
                publicBaseUrl,
                airtableApiKey,
                airtableBaseId,
            });

            console.log(`[PATRIOLLY][SITE_ASSESSMENT_PDF_WORKER][RESULT] recordId=${recordId} Status=SUCCESS`);
            return res.status(200).json({
                status: 'SUCCESS',
                recordId,
                assessmentId,
                attachmentField: CONFIG.attachmentField,
                filename: attachment.filename || filename,
                pdfBytes: pdfBuffer.length,
            });
        } catch (error) {
            const message = String(error?.message || error || 'Unknown error');
            const statusCode = message.startsWith('CONFLICT ERROR:') ? 409 : 500;
            console.error(`[PATRIOLLY][SITE_ASSESSMENT_PDF_WORKER][ERROR] recordId=${recordId} ${message}`);
            return res.status(statusCode).json({ status: 'FAILED', error: message });
        } finally {
            if (typeof scheduleIdleClose === 'function') scheduleIdleClose();
        }
    });
};

async function generatePdf({ htmlContent, getBrowser }, retries = 1) {
    let page = null;
    try {
        const browser = await getBrowser();
        page = await browser.newPage();
        await page.setViewport({ width: CONFIG.viewportWidth, height: CONFIG.viewportHeight });
        await page.emulateMediaType('print');
        await page.setContent(htmlContent, {
            waitUntil: 'domcontentloaded',
            timeout: CONFIG.pdfTimeoutMs,
        });
        await waitForImages(page);
        await page.evaluate(async () => {
            if (document.fonts?.ready) await document.fonts.ready;
        });
        return await page.pdf({
            format: 'A4',
            landscape: false,
            printBackground: true,
            displayHeaderFooter: true,
            headerTemplate: '<div></div>',
            footerTemplate: '<div style="width:100%;font-size:8px;color:#666;text-align:right;padding-right:10px;font-family:Arial,sans-serif;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>',
            margin: { top: '10px', bottom: '26px', left: '8px', right: '8px' },
            timeout: CONFIG.pdfTimeoutMs,
        });
    } catch (error) {
        const message = String(error?.message || error || 'Unknown error');
        if (retries > 0 && (
            message.includes('detached') ||
            message.includes('Connection closed') ||
            message.includes('Target closed')
        )) {
            return generatePdf({ htmlContent, getBrowser }, retries - 1);
        }
        throw new Error(`PDF generation failed: ${message}`);
    } finally {
        if (page) {
            try {
                await page.close();
            } catch (error) {
                console.error(`[PATRIOLLY][SITE_ASSESSMENT_PDF_WORKER][PAGE_CLOSE_ERROR] ${error.message}`);
            }
        }
    }
}

async function waitForImages(page) {
    await page.evaluate(async () => {
        const images = Array.from(document.images || []);
        await Promise.all(images.map((img) => {
            if (img.complete) return Promise.resolve();
            return new Promise((resolve) => {
                const done = () => resolve();
                img.addEventListener('load', done, { once: true });
                img.addEventListener('error', done, { once: true });
                setTimeout(done, 8000);
            });
        }));
    });
}

async function assertAttachmentFieldEmpty({ recordId, airtableApiKey, airtableBaseId }) {
    const record = await fetchAirtableRecord(recordId, airtableApiKey, airtableBaseId);
    const attachments = record?.fields?.[CONFIG.attachmentField] || [];
    if (Array.isArray(attachments) && attachments.length) {
        throw new Error(`CONFLICT ERROR: ${CONFIG.attachmentField} already exists on record "${recordId}". Automatic replacement is not allowed.`);
    }
}

async function fetchAirtableRecord(recordId, airtableApiKey, airtableBaseId) {
    const url = `https://api.airtable.com/v0/${airtableBaseId}/${encodeURIComponent(CONFIG.airtableTableName)}/${recordId}`;
    const response = await fetchWithTimeout(url, {
        headers: { Authorization: `Bearer ${airtableApiKey}` },
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`Airtable preflight returned ${response.status}: ${body}`);
    try {
        return JSON.parse(body);
    } catch {
        throw new Error('Airtable preflight returned invalid JSON.');
    }
}

async function attachPdfToAirtable({
    pdfBuffer,
    recordId,
    filename,
    publicBaseUrl,
    airtableApiKey,
    airtableBaseId,
}) {
    const publicDir = path.join(__dirname, 'public');
    const tempFilename = `site-assessment-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.pdf`;
    const filePath = path.join(publicDir, tempFilename);

    try {
        if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });
        await fs.promises.writeFile(filePath, pdfBuffer);
        const publicUrl = `${String(publicBaseUrl).replace(/\/$/, '')}/public/${encodeURIComponent(tempFilename)}`;
        const airtableUrl = `https://api.airtable.com/v0/${airtableBaseId}/${encodeURIComponent(CONFIG.airtableTableName)}`;
        const response = await fetchWithTimeout(airtableUrl, {
            method: 'PATCH',
            headers: {
                Authorization: `Bearer ${airtableApiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                records: [{
                    id: recordId,
                    fields: {
                        [CONFIG.attachmentField]: [{ url: publicUrl, filename }],
                    },
                }],
            }),
        });
        const responseText = await response.text();
        if (!response.ok) throw new Error(`Airtable attachment write returned ${response.status}: ${responseText}`);
        let data;
        try {
            data = JSON.parse(responseText);
        } catch {
            throw new Error('Airtable attachment write returned invalid JSON.');
        }
        const attachments = data?.records?.[0]?.fields?.[CONFIG.attachmentField] || [];
        if (!Array.isArray(attachments) || !attachments.length) {
            throw new Error(`Airtable attachment write succeeded but ${CONFIG.attachmentField} was not returned.`);
        }
        scheduleCleanup(filePath, tempFilename);
        return attachments[0];
    } catch (error) {
        await cleanupFile(filePath, tempFilename);
        throw error;
    }
}

async function fetchWithTimeout(url, options) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONFIG.airtableRequestTimeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
        if (error?.name === 'AbortError') {
            throw new Error(`HTTP request timed out after ${CONFIG.airtableRequestTimeoutMs / 1000} seconds.`);
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }
}

function withDeadline(promise, timeoutMs, message) {
    let id;
    const timeout = new Promise((_, reject) => {
        id = setTimeout(() => reject(new Error(message)), timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(id));
}

function buildAttachmentFilename(assessmentId) {
    const safe = String(assessmentId).trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ');
    return `${safe || 'Site Assessment'}.pdf`;
}

function scheduleCleanup(filePath, filename) {
    setTimeout(() => cleanupFile(filePath, filename), CONFIG.cleanupDelayMs);
}

async function cleanupFile(filePath, filename) {
    try {
        if (fs.existsSync(filePath)) {
            await fs.promises.unlink(filePath);
            console.log(`[PATRIOLLY][SITE_ASSESSMENT_PDF_WORKER][CLEANUP] Deleted ${filename}`);
        }
    } catch (error) {
        console.error(`[PATRIOLLY][SITE_ASSESSMENT_PDF_WORKER][CLEANUP_ERROR] ${filename}: ${error.message}`);
    }
}

function validateContext(v) {
    const missing = [];
    if (!v.app) missing.push('app');
    if (typeof v.getBrowser !== 'function') missing.push('getBrowser');
    if (!v.publicBaseUrl) missing.push('publicBaseUrl');
    if (!v.reportPdfAuthToken) missing.push('reportPdfAuthToken');
    if (!v.airtableApiKey) missing.push('airtableApiKey');
    if (!v.airtableBaseId) missing.push('airtableBaseId');
    if (missing.length) throw new Error(`Site Assessment PDF extension missing context: ${missing.join(', ')}`);
}
