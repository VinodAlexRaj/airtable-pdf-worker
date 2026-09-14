/*
PATRIOLLY — MONTHLY REPORT PDF WORKER EXTENSION

Additive extension for VinodAlexRaj/airtable-pdf-worker.

GUARANTEES
- Does not modify or replace POST /generate-pdf.
- Does not modify or replace POST /generate-weekly-pdf.
- Does not use Sharp or image inlining.
- POST /generate-monthly-pdf is synchronous: HTTP 200 is returned only after
  Puppeteer generated the PDF and Airtable accepted the attachment write.
- Refuses to overwrite an existing Record.Monthly Report PDF.
- PDF business/KPI calculation is not performed here.
*/

const {
    assertAttachmentFieldEmpty,
    attachPdfToAirtable,
} = require("../shared/airtable-pdf-attachment");
const { generatePdf: renderPdf } = require("../shared/pdf-renderer");

const CONFIG = {
    route: "/generate-monthly-pdf",
    airtableTableName: "Record",
    attachmentField: "Monthly Report PDF",
    cleanupDelayMs: 60000,
    airtableRequestTimeoutMs: 6000,
    generationDeadlineMs: 15000,
    pdfTimeoutMs: 12000,
    viewportWidth: 1200,
    viewportHeight: 1600,
};

module.exports = function registerMonthlyReportPdfExtension(context) {
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
        const secret = req.headers["x-auth-token"];
        if (secret !== reportPdfAuthToken) {
            return res.status(401).json({ error: "Unauthorized" });
        }

        const htmlContent = String(req.body?.htmlContent || "").trim();
        const recordId = String(req.body?.recordId || "").trim();
        const periodStart = String(req.body?.periodStart || "").trim();
        const periodEnd = String(req.body?.periodEnd || "").trim();

        if (!htmlContent || !recordId || !periodStart || !periodEnd) {
            return res.status(400).json({
                error:
                    "Missing required fields: htmlContent, recordId, periodStart, periodEnd",
            });
        }

        if (!isIsoDate(periodStart) || !isIsoDate(periodEnd)) {
            return res.status(400).json({
                error: "periodStart and periodEnd must use YYYY-MM-DD format",
            });
        }

        const expectedEnd = addDays(periodStart, 27);
        if (
            getWeekday(periodStart) !== 3 ||
            periodEnd !== expectedEnd ||
            getWeekday(periodEnd) !== 2
        ) {
            return res.status(400).json({
                error:
                    `Monthly period must be 28 days Wednesday through Tuesday; expected end ${expectedEnd}`,
            });
        }

        const attachmentFilename = buildAttachmentFilename(
            periodStart,
            periodEnd
        );

        console.log(
            `[PATRIOLLY][MONTHLY_PDF_WORKER][START] recordId=${recordId} ` +
            `period=${periodStart}~${periodEnd}`
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
                responseParser: "json",
                conflictMessage:
                    `CONFLICT ERROR: ${CONFIG.attachmentField} already exists on ` +
                    `Record "${recordId}". Automatic replacement is not allowed.`,
            });

            const pdfBuffer = await withDeadline(
                generateMonthlyPdf({
                    htmlContent,
                    getBrowser,
                }),
                CONFIG.generationDeadlineMs,
                "PDF generation deadline exceeded"
            );

            const uploadResult = await attachPdfToAirtable({
                pdfBuffer,
                recordId,
                filename: attachmentFilename,
                publicBaseUrl,
                airtableApiKey,
                airtableBaseId,
                airtableTableName: CONFIG.airtableTableName,
                attachmentField: CONFIG.attachmentField,
                tempFilenamePrefix: "monthly-kpi-review",
                cleanupDelayMs: CONFIG.cleanupDelayMs,
                requestTimeoutMs: CONFIG.airtableRequestTimeoutMs,
                timeoutErrorMessage:
                    `HTTP request timed out after ` +
                    `${CONFIG.airtableRequestTimeoutMs / 1000} seconds.`,
                cleanupCallbacks: {
                    onDeleted: (filename) => {
                        console.log(
                            `[PATRIOLLY][MONTHLY_PDF_WORKER][CLEANUP] Deleted ${filename}`
                        );
                    },
                    onError: (filename, error) => {
                        console.error(
                            `[PATRIOLLY][MONTHLY_PDF_WORKER][CLEANUP_ERROR] ` +
                            `${filename}: ${error.message}`
                        );
                    },
                },
            });

            console.log(
                `[PATRIOLLY][MONTHLY_PDF_WORKER][RESULT] recordId=${recordId} ` +
                `Status=SUCCESS`
            );

            return res.status(200).json({
                status: "SUCCESS",
                recordId,
                attachmentField: CONFIG.attachmentField,
                filename: uploadResult.filename || attachmentFilename,
                pdfBytes: pdfBuffer.length,
            });
        } catch (error) {
            const message = String(error?.message || error || "Unknown error");
            const statusCode = message.startsWith("CONFLICT ERROR:") ? 409 : 500;

            console.error(
                `[PATRIOLLY][MONTHLY_PDF_WORKER][ERROR] recordId=${recordId} ${message}`
            );

            return res.status(statusCode).json({
                status: "FAILED",
                error: message,
            });
        } finally {
            if (typeof scheduleIdleClose === "function") {
                scheduleIdleClose();
            }
        }
    });
};

async function generateMonthlyPdf({ htmlContent, getBrowser }, retries = 1) {
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
        styleContent: `
                html, body {
                    margin: 0 !important;
                    padding: 0 !important;
                }
                * {
                    -webkit-print-color-adjust: exact !important;
                    print-color-adjust: exact !important;
                }
            `,
        pdfOptions: {
            format: "A4",
            landscape: true,
            printBackground: true,
            displayHeaderFooter: true,
            headerTemplate: "<div></div>",
            footerTemplate:
                '<div style="width:100%;font-size:8px;color:#666666;' +
                'text-align:right;padding-right:10px;font-family:Arial,sans-serif;">' +
                'Page <span class="pageNumber"></span> of ' +
                '<span class="totalPages"></span></div>',
            margin: {
                top: "20px",
                bottom: "28px",
                left: "10px",
                right: "10px",
            },
            timeout: CONFIG.pdfTimeoutMs,
        },
        logPrefix: "[PATRIOLLY][MONTHLY_PDF_WORKER]",
    });
}

function withDeadline(promise, timeoutMs, message) {
    let timeoutId;

    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            reject(new Error(message));
        }, timeoutMs);
    });

    return Promise.race([promise, timeoutPromise]).finally(() => {
        clearTimeout(timeoutId);
    });
}

function buildAttachmentFilename(periodStart, periodEnd) {
    return (
        `Monthly KPI Review ( ${formatFilenameDate(periodStart)} ~ ` +
        `${formatFilenameDate(periodEnd)} ).pdf`
    );
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
            `Monthly PDF extension missing context: ${missing.join(", ")}`
        );
    }
}

function isIsoDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return (
        date.getUTCFullYear() === year &&
        date.getUTCMonth() + 1 === month &&
        date.getUTCDate() === day
    );
}

function addDays(value, days) {
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    date.setUTCDate(date.getUTCDate() + days);
    return (
        `${date.getUTCFullYear()}-` +
        `${String(date.getUTCMonth() + 1).padStart(2, "0")}-` +
        `${String(date.getUTCDate()).padStart(2, "0")}`
    );
}

function getWeekday(value) {
    const [year, month, day] = value.split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function formatFilenameDate(value) {
    const [year, month, day] = value.split("-");
    return `${day}-${month}-${year}`;
}
