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

const fs = require("fs");
const path = require("path");

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
    let page = null;

    try {
        const browser = await getBrowser();
        page = await browser.newPage();
        await page.setViewport({
            width: CONFIG.viewportWidth,
            height: CONFIG.viewportHeight,
        });
        await page.emulateMediaType("print");

        await page.setRequestInterception(true);
        page.on("request", (request) => {
            const url = request.url();
            if (
                url.includes("fonts.googleapis.com") ||
                url.includes("fonts.gstatic.com")
            ) {
                request.abort();
            } else {
                request.continue();
            }
        });

        await page.setContent(htmlContent, {
            waitUntil: "domcontentloaded",
            timeout: CONFIG.pdfTimeoutMs,
        });
        await waitForImages(page);
        await page.evaluate(async () => {
            if (document.fonts?.ready) await document.fonts.ready;
        });

        return await page.pdf({
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
        });
    } catch (error) {
        const message = formatErrorDetail(error);

        if (
            retries > 0 &&
            (message.includes("detached") ||
                message.includes("Connection closed") ||
                message.includes("Target closed"))
        ) {
            return generatePdf({ htmlContent, getBrowser }, retries - 1);
        }

        throw new Error(`PDF generation failed: ${message}`);
    } finally {
        if (page) {
            try {
                await page.close();
            } catch (error) {
                console.error(
                    `${LOG}[PAGE_CLOSE_ERROR] ${formatErrorDetail(error)}`
                );
            }
        }
    }
}

async function waitForImages(page) {
    await page.evaluate(async () => {
        const images = Array.from(document.images || []);
        await Promise.all(
            images.map((img) => {
                if (img.complete) return Promise.resolve();
                return new Promise((resolve) => {
                    const done = () => resolve();
                    img.addEventListener("load", done, { once: true });
                    img.addEventListener("error", done, { once: true });
                    setTimeout(done, 10000);
                });
            })
        );
    });
}

async function assertAttachmentFieldEmpty({
    recordId,
    airtableApiKey,
    airtableBaseId,
}) {
    const record = await fetchAirtableRecord(
        recordId,
        airtableApiKey,
        airtableBaseId
    );
    const attachments = record?.fields?.[CONFIG.attachmentField] || [];

    if (Array.isArray(attachments) && attachments.length) {
        throw new Error(
            `CONFLICT ERROR: ${CONFIG.attachmentField} already exists on ` +
            `record "${recordId}". Automatic replacement is not allowed.`
        );
    }
}

async function fetchAirtableRecord(recordId, airtableApiKey, airtableBaseId) {
    const url =
        `https://api.airtable.com/v0/${airtableBaseId}/` +
        `${encodeURIComponent(CONFIG.airtableTableName)}/${recordId}`;
    const response = await fetchWithTimeout(url, {
        headers: { Authorization: `Bearer ${airtableApiKey}` },
    });
    const body = await response.text();

    if (!response.ok) {
        throw new Error(
            `Airtable preflight returned ${response.status}: ${body}`
        );
    }

    try {
        return JSON.parse(body);
    } catch {
        throw new Error("Airtable preflight returned invalid JSON.");
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
    const publicDir = path.join(__dirname, "public");
    const tempFilename =
        `incident-report-${Date.now()}-` +
        `${Math.random().toString(36).slice(2, 10)}.pdf`;
    const filePath = path.join(publicDir, tempFilename);

    try {
        if (!fs.existsSync(publicDir)) {
            fs.mkdirSync(publicDir, { recursive: true });
        }

        await fs.promises.writeFile(filePath, pdfBuffer);

        const publicUrl =
            `${String(publicBaseUrl).replace(/\/$/, "")}/public/` +
            encodeURIComponent(tempFilename);
        const airtableUrl =
            `https://api.airtable.com/v0/${airtableBaseId}/` +
            encodeURIComponent(CONFIG.airtableTableName);

        const response = await fetchWithTimeout(airtableUrl, {
            method: "PATCH",
            headers: {
                Authorization: `Bearer ${airtableApiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                records: [
                    {
                        id: recordId,
                        fields: {
                            [CONFIG.attachmentField]: [
                                { url: publicUrl, filename },
                            ],
                        },
                    },
                ],
            }),
        });
        const body = await response.text();

        if (!response.ok) {
            throw new Error(
                `Airtable PDF write returned ${response.status}: ${body}`
            );
        }

        let data;
        try {
            data = JSON.parse(body);
        } catch {
            throw new Error("Airtable PDF write returned invalid JSON.");
        }

        const attachment =
            data?.records?.[0]?.fields?.[CONFIG.attachmentField]?.[0];

        if (!attachment) {
            throw new Error(
                `Airtable response did not contain ${CONFIG.attachmentField}.`
            );
        }

        setTimeout(() => {
            fs.promises.unlink(filePath).catch(() => {});
        }, CONFIG.cleanupDelayMs);

        return attachment;
    } catch (error) {
        fs.promises.unlink(filePath).catch(() => {});
        throw error;
    }
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

async function fetchWithTimeout(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.requestTimeoutMs);

    try {
        return await fetch(url, {
            ...options,
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timer);
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