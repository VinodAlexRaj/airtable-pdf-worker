/*
PATRIOLLY — INCIDENT REPORT PDF WORKER EXTENSION
Additive extension for VinodAlexRaj/airtable-pdf-worker.

POST /generate-incident-report-pdf
- Auth: x-auth-token = REPORT_PDF_AUTH_TOKEN
- Input: htmlContent, recordId, incidentId
- Queues the job and returns HTTP 202 immediately
- Refuses to overwrite Incident Report PDF
- Writes attachment to Airtable Incident Report.Incident Report PDF
*/

const {
    assertAttachmentFieldEmpty,
    attachPdfToAirtable,
} = require("../shared/airtable-pdf-attachment");
const { generatePdf: renderPdf } = require("../shared/pdf-renderer");

const CONFIG = {
    route: "/generate-incident-report-pdf",
    airtableTableName: "Incident Report",
    attachmentField: "Incident Report PDF",
    cleanupDelayMs: 60000,
    requestTimeoutMs: 15000,
    generationDeadlineMs: 90000,
    pdfTimeoutMs: 30000,
    viewportWidth: 1200,
    viewportHeight: 1600,
};

const LOG = "[PATRIOLLY][INCIDENT_REPORT_PDF_WORKER]";

module.exports = function registerIncidentReportPdfExtension(context) {
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
        const incidentId = String(req.body?.incidentId || "").trim();

        if (!htmlContent || !recordId || !incidentId) {
            return res.status(400).json({
                error:
                    "Missing required fields: htmlContent, recordId, incidentId",
            });
        }

        if (queuedRecordIds.has(recordId)) {
            return res.status(202).json({
                status: "QUEUED",
                duplicate: true,
                recordId,
                incidentId,
                queuePosition:
                    queue.findIndex((job) => job.recordId === recordId) + 1,
            });
        }

        queue.push({ htmlContent, recordId, incidentId });
        queuedRecordIds.add(recordId);

        console.log(
            `${LOG}[QUEUED] recordId=${recordId} ` +
            `incidentId=${incidentId} QueueLength=${queue.length}`
        );

        res.status(202).json({
            status: "QUEUED",
            recordId,
            incidentId,
            queuePosition: queue.length,
        });

        setImmediate(processQueue);
    });

    async function processQueue() {
        if (isProcessing || queue.length === 0) return;
        isProcessing = true;

        const job = queue.shift();
        const { htmlContent, recordId, incidentId } = job;
        const filename = buildAttachmentFilename(incidentId);

        console.log(
            `${LOG}[START] recordId=${recordId} ` +
            `incidentId=${incidentId} QueueRemaining=${queue.length}`
        );

        try {
            await assertAttachmentFieldEmpty({
                recordId,
                airtableApiKey,
                airtableBaseId,
                airtableTableName: CONFIG.airtableTableName,
                attachmentField: CONFIG.attachmentField,
                requestTimeoutMs: CONFIG.requestTimeoutMs,
                responseParser: "text-json",
                invalidJsonMessage: "Airtable preflight returned invalid JSON.",
                conflictMessage:
                    `CONFLICT ERROR: ${CONFIG.attachmentField} already exists on ` +
                    `record "${recordId}". Automatic replacement is not allowed.`,
            });

            const pdfBuffer = await withDeadline(
                generatePdf({ htmlContent, getBrowser }),
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
                tempFilenamePrefix: "incident-report",
                cleanupDelayMs: CONFIG.cleanupDelayMs,
                requestTimeoutMs: CONFIG.requestTimeoutMs,
                responseErrorPrefix: "Airtable PDF write returned",
                invalidJsonMessage: "Airtable PDF write returned invalid JSON.",
                missingAttachmentMessage:
                    `Airtable response did not contain ${CONFIG.attachmentField}.`,
                requireTruthyAttachment: true,
            });

            console.log(
                `${LOG}[RESULT] recordId=${recordId} Status=SUCCESS ` +
                `Filename=${attachment.filename || filename} ` +
                `Bytes=${pdfBuffer.length}`
            );
        } catch (error) {
            console.error(
                `${LOG}[ERROR] recordId=${recordId} ${formatErrorDetail(error)}`
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
        waitForImagesTimeoutMs: 10000,
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

function buildAttachmentFilename(incidentId) {
    const safe = String(incidentId || "incident-report")
        .trim()
        .replace(/[^A-Za-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "") || "incident-report";
    return `${safe}.pdf`;
}

function validateContext(values) {
    for (const [key, value] of Object.entries(values)) {
        if (!value) {
            throw new Error(
                `${LOG}[CONFIGURATION_ERROR] Missing extension context: ${key}`
            );
        }
    }
}

async function withDeadline(promise, timeoutMs, message) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(message)), timeoutMs);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

function formatErrorDetail(error) {
    return String(error?.stack || error?.message || error || "Unknown error")
        .replace(/\s+/g, " ")
        .trim();
}
