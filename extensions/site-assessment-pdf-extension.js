/*
PATRIOLLY — SITE ASSESSMENT PDF WORKER EXTENSION
Additive extension for VinodAlexRaj/airtable-pdf-worker.

POST /generate-site-assessment-pdf
- Auth: x-auth-token = REPORT_PDF_AUTH_TOKEN
- Input: htmlContent, recordId, assessmentId
- Queues the job and returns HTTP 202 immediately
- Background job inlines/resizes images before Puppeteer rendering
- Refuses to overwrite the existing Site Assessment PDF attachment
- Writes the PDF attachment to Airtable Site Assessment Report.
*/

const {
    assertAttachmentFieldEmpty,
    attachPdfToAirtable,
} = require("../shared/airtable-pdf-attachment");
const { inlineImages: inlineSharedImages } = require("../shared/image-inliner");
const { generatePdf: renderPdf } = require("../shared/pdf-renderer");
const {
    buildReportPdfOptions,
    fetchReportFooterImageDataUrl,
} = require("../shared/report-footer");

const CONFIG = {
    route: "/generate-site-assessment-pdf",
    siteAssessmentReportTableName: "Site Assessment Report",
    attachmentField: "Site Assessment PDF",
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

const LOG = "[PATRIOLLY][SITE_ASSESSMENT_PDF_WORKER]";

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

    const queue = [];
    const queuedRecordIds = new Set();
    let isProcessing = false;

    app.post(CONFIG.route, (req, res) => {
        if (req.headers["x-auth-token"] !== reportPdfAuthToken) {
            return res.status(401).json({ error: "Unauthorized" });
        }

        const htmlContent = String(req.body?.htmlContent || "").trim();
        const recordId = String(req.body?.recordId || "").trim();
        const assessmentId = String(req.body?.assessmentId || "").trim();

        if (!htmlContent || !recordId || !assessmentId) {
            return res.status(400).json({
                error: "Missing required fields: htmlContent, recordId, assessmentId",
            });
        }

        if (queuedRecordIds.has(recordId)) {
            return res.status(202).json({
                status: "QUEUED",
                duplicate: true,
                recordId,
                assessmentId,
                queuePosition: queue.findIndex((job) => job.recordId === recordId) + 1,
            });
        }

        queue.push({ htmlContent, recordId, assessmentId });
        queuedRecordIds.add(recordId);

        console.log(
            `[PATRIOLLY][SITE_ASSESSMENT_PDF_WORKER][QUEUED] ` +
            `recordId=${recordId} assessmentId=${assessmentId} QueueLength=${queue.length}`
        );

        res.status(202).json({
            status: "QUEUED",
            recordId,
            assessmentId,
            queuePosition: queue.length,
        });

        setImmediate(processQueue);
    });

    async function processQueue() {
        if (isProcessing || queue.length === 0) return;
        isProcessing = true;

        const job = queue.shift();
        const { htmlContent, recordId, assessmentId } = job;
        const filename = buildAttachmentFilename(assessmentId);

        console.log(
            `[PATRIOLLY][SITE_ASSESSMENT_PDF_WORKER][START] ` +
            `recordId=${recordId} assessmentId=${assessmentId} QueueRemaining=${queue.length}`
        );

        try {
            await assertAttachmentFieldEmpty({
                recordId,
                airtableApiKey,
                airtableBaseId,
                airtableTableName: CONFIG.siteAssessmentReportTableName,
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
                airtableTableName: CONFIG.siteAssessmentReportTableName,
                attachmentField: CONFIG.attachmentField,
                tempFilenamePrefix: "site-assessment",
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
                `[PATRIOLLY][SITE_ASSESSMENT_PDF_WORKER][RESULT] ` +
                `recordId=${recordId} Status=SUCCESS ` +
                `Filename=${attachment.filename || filename} Bytes=${pdfBuffer.length}`
            );
        } catch (error) {
            console.error(
                `[PATRIOLLY][SITE_ASSESSMENT_PDF_WORKER][ERROR] ` +
                `recordId=${recordId} ${formatErrorDetail(error)}`
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
        pdfOptions: async () => {
            const footerImageDataUrl = await fetchReportFooterImageDataUrl({
                timeoutMs: CONFIG.imageFetchTimeoutMs,
                logPrefix: LOG,
            });

            return buildReportPdfOptions({
                footerImageDataUrl,
                format: "A4",
                landscape: false,
                timeout: CONFIG.pdfTimeoutMs,
                marginOverrides: {
                    top: "10px",
                    left: "8px",
                    right: "8px",
                },
            });
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
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timerId));
}

function buildAttachmentFilename(assessmentId) {
    const safe = String(assessmentId)
        .trim()
        .replace(/[\\/:*?"<>|]+/g, "-")
        .replace(/\s+/g, " ");
    return `${safe || "Site Assessment Report"}.pdf`;
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
            `Site Assessment PDF extension missing context: ${missing.join(", ")}`
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
