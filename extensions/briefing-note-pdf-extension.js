/*
PATRIOLLY — BRIEFING NOTE PDF WORKER EXTENSION
Additive extension for VinodAlexRaj/airtable-pdf-worker.

POST /generate-briefing-note-pdf
- Auth: x-auth-token = REPORT_PDF_AUTH_TOKEN
- Input: htmlContent, recordId, briefingNoteId
- Queues the job and returns HTTP 202 immediately
- Background job inlines/resizes images before Puppeteer rendering
- Refuses to overwrite Briefing Note PDF
- Writes attachment to Airtable Briefing Note.Briefing Note PDF
*/

const {
    assertAttachmentFieldEmpty,
    attachPdfToAirtable,
} = require("../shared/airtable-pdf-attachment");
const { inlineImages: inlineSharedImages } = require("../shared/image-inliner");
const { generatePdf: renderPdf } = require("../shared/pdf-renderer");

const CONFIG = {
    route: "/generate-briefing-note-pdf",
    airtableTableName: "Briefing Note",
    attachmentField: "Briefing Note PDF",
    cleanupDelayMs: 60000,
    airtableRequestTimeoutMs: 15000,
    generationDeadlineMs: 90000,
    pdfTimeoutMs: 30000,
    viewportWidth: 1200,
    viewportHeight: 1600,
    imageHeadTimeoutMs: 5000,
    imageFetchTimeoutMs: 15000,
    imageBatchSize: 3,
    maxFinalImageBytes: 5 * 1024 * 1024,
};

const LOG = "[PATRIOLLY][BRIEFING_NOTE_PDF_WORKER]";

module.exports = function registerBriefingNotePdfExtension(context) {
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

    const queue = [];
    const queuedRecordIds = new Set();
    let isProcessing = false;

    app.post(CONFIG.route, (req, res) => {
        if (req.headers["x-auth-token"] !== reportPdfAuthToken) {
            return res.status(401).json({ error: "Unauthorized" });
        }

        const htmlContent = String(req.body?.htmlContent || "").trim();
        const recordId = String(req.body?.recordId || "").trim();
        const briefingNoteId = String(req.body?.briefingNoteId || "").trim();

        if (!htmlContent || !recordId || !briefingNoteId) {
            return res.status(400).json({
                error:
                    "Missing required fields: htmlContent, recordId, briefingNoteId",
            });
        }

        if (queuedRecordIds.has(recordId)) {
            return res.status(202).json({
                status: "QUEUED",
                duplicate: true,
                recordId,
                briefingNoteId,
                queuePosition:
                    queue.findIndex((job) => job.recordId === recordId) + 1,
            });
        }

        queue.push({ htmlContent, recordId, briefingNoteId });
        queuedRecordIds.add(recordId);

        console.log(
            `${LOG}[QUEUED] recordId=${recordId} ` +
            `briefingNoteId=${briefingNoteId} QueueLength=${queue.length}`
        );

        res.status(202).json({
            status: "QUEUED",
            recordId,
            briefingNoteId,
            queuePosition: queue.length,
        });

        setImmediate(processQueue);
    });

    async function processQueue() {
        if (isProcessing || queue.length === 0) return;
        isProcessing = true;

        const job = queue.shift();
        const { htmlContent, recordId, briefingNoteId } = job;
        const filename = buildAttachmentFilename(briefingNoteId);

        console.log(
            `${LOG}[START] recordId=${recordId} ` +
            `briefingNoteId=${briefingNoteId} QueueRemaining=${queue.length}`
        );

        try {
            await assertAttachmentFieldEmpty({
                recordId,
                airtableApiKey,
                airtableBaseId,
                airtableTableName: CONFIG.airtableTableName,
                attachmentField: CONFIG.attachmentField,
                requestTimeoutMs: CONFIG.airtableRequestTimeoutMs,
                timeoutErrorMessage:
                    `HTTP request timed out after ` +
                    `${CONFIG.airtableRequestTimeoutMs / 1000} seconds.`,
                responseParser: "text-json",
                invalidJsonMessage: "Airtable preflight returned invalid JSON.",
                conflictMessage:
                    `CONFLICT ERROR: ${CONFIG.attachmentField} already exists on ` +
                    `record "${recordId}". Automatic replacement is not allowed.`,
            });

            const preparedHtml = await inlineSharedImages(htmlContent, {
                logPrefix: LOG,
                imageHeadTimeoutMs: CONFIG.imageHeadTimeoutMs,
                imageFetchTimeoutMs: CONFIG.imageFetchTimeoutMs,
                imageBatchSize: CONFIG.imageBatchSize,
                maxFinalImageBytes: CONFIG.maxFinalImageBytes,
            });
            const pdfBuffer = await withDeadline(
                generatePdf({ htmlContent: preparedHtml, getBrowser }),
                CONFIG.generationDeadlineMs,
                "PDF generation deadline exceeded"
            );

            const attachment = await attachPdfToAirtable({
                pdfBuffer,
                recordId,
                filename,
                publicBaseUrl,
                airtableApiKey,
                airtableBaseId,
                airtableTableName: CONFIG.airtableTableName,
                attachmentField: CONFIG.attachmentField,
                tempFilenamePrefix: "briefing-note",
                cleanupDelayMs: CONFIG.cleanupDelayMs,
                requestTimeoutMs: CONFIG.airtableRequestTimeoutMs,
                timeoutErrorMessage:
                    `HTTP request timed out after ` +
                    `${CONFIG.airtableRequestTimeoutMs / 1000} seconds.`,
                cleanupCallbacks: {
                    onDeleted: (cleanupFilename) => {
                        console.log(`${LOG}[CLEANUP] Deleted ${cleanupFilename}`);
                    },
                    onError: (cleanupFilename, error) => {
                        console.error(
                            `${LOG}[CLEANUP_ERROR] ${cleanupFilename}: ` +
                            formatErrorDetail(error)
                        );
                    },
                },
            });

            console.log(
                `${LOG}[RESULT] recordId=${recordId} Status=SUCCESS ` +
                `Filename=${attachment.filename || filename} ` +
                `Bytes=${pdfBuffer.length}`
            );
        } catch (error) {
            console.error(
                `${LOG}[ERROR] recordId=${recordId} ` +
                formatErrorDetail(error)
            );
        } finally {
            queuedRecordIds.delete(recordId);
            isProcessing = false;

            if (queue.length > 0) {
                setTimeout(processQueue, 250);
            } else if (typeof scheduleIdleClose === "function") {
                scheduleIdleClose();
            }
        }
    }
};

async function generatePdf({ htmlContent, getBrowser }, retries = 1) {
    return renderPdf({
        htmlContent,
        getBrowser,
        retries,
        viewport: {
            width: CONFIG.viewportWidth,
            height: CONFIG.viewportHeight,
        },
        setContentOptions: {
            waitUntil: "domcontentloaded",
            timeout: CONFIG.pdfTimeoutMs,
        },
        blockGoogleFonts: true,
        waitForImagesTimeoutMs: 5000,
        pdfOptions: {
            format: "A4",
            landscape: false,
            printBackground: true,
            displayHeaderFooter: true,
            headerTemplate: "<div></div>",
            footerTemplate:
                '<div style="width:100%;font-size:8px;color:#666;text-align:right;padding-right:10px;font-family:Arial,sans-serif;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>',
            margin: {
                top: "10px",
                bottom: "26px",
                left: "8px",
                right: "8px",
            },
            timeout: CONFIG.pdfTimeoutMs,
        },
        logPrefix: LOG,
        formatErrorDetail,
    });
}

function withDeadline(promise, timeoutMs, message) {
    let timerId;
    const timeout = new Promise((_, reject) => {
        timerId = setTimeout(() => reject(new Error(message)), timeoutMs);
    });

    return Promise.race([promise, timeout]).finally(() =>
        clearTimeout(timerId)
    );
}

function buildAttachmentFilename(briefingNoteId) {
    const safe = String(briefingNoteId)
        .trim()
        .replace(/[\\/:*?"<>|]+/g, "-")
        .replace(/\s+/g, " ");

    return `${safe || "Briefing Note"}.pdf`;
}

function validateContext(values) {
    const missing = [];

    if (!values.app) missing.push("app");
    if (typeof values.getBrowser !== "function") missing.push("getBrowser");
    if (!values.publicBaseUrl) missing.push("publicBaseUrl");
    if (!values.reportPdfAuthToken) missing.push("reportPdfAuthToken");
    if (!values.airtableApiKey) missing.push("airtableApiKey");
    if (!values.airtableBaseId) missing.push("airtableBaseId");

    if (missing.length) {
        throw new Error(
            `Briefing Note PDF extension missing context: ${missing.join(", ")}`
        );
    }
}

function formatErrorDetail(value) {
    if (value instanceof Error) return value.message || String(value);
    if (typeof value === "string") return value;

    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}
