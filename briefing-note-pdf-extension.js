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

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

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
            });

            const preparedHtml = await inlineImages(htmlContent);
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

async function inlineImages(html) {
    const imageUrls = extractImageUrls(html);
    const total = imageUrls.length;

    if (total === 0) {
        console.log(`${LOG}[IMAGES] Count=0`);
        return html;
    }

    const totalBytes = await estimateTotalImageBytes(imageUrls);
    const { maxDimension, quality, strategy } = chooseImageStrategy(
        total,
        totalBytes
    );

    console.log(
        `${LOG}[IMAGES] Count=${total} ` +
        `EstimatedMB=${(totalBytes / 1024 / 1024).toFixed(2)} ` +
        `Strategy=${strategy} MaxDimension=${maxDimension} Quality=${quality}`
    );

    for (let i = 0; i < imageUrls.length; i += CONFIG.imageBatchSize) {
        const batch = imageUrls.slice(i, i + CONFIG.imageBatchSize);

        await Promise.all(
            batch.map(async (url) => {
                try {
                    const response = await fetchWithAbort(
                        url,
                        { method: "GET" },
                        CONFIG.imageFetchTimeoutMs
                    );

                    if (!response.ok) {
                        console.warn(
                            `${LOG}[IMAGE_SKIP] HTTP=${response.status} URL=${url}`
                        );
                        return;
                    }

                    const sourceBuffer = Buffer.from(
                        await response.arrayBuffer()
                    );
                    const processed = await optimizeImage({
                        sourceBuffer,
                        response,
                        maxDimension,
                        quality,
                    });

                    if (processed.buffer.length > CONFIG.maxFinalImageBytes) {
                        console.warn(
                            `${LOG}[IMAGE_SKIP] Reason=TOO_LARGE ` +
                            `Bytes=${processed.buffer.length} URL=${url}`
                        );
                        return;
                    }

                    const dataUrl =
                        `data:${processed.mimeType};base64,` +
                        processed.buffer.toString("base64");
                    html = html.replaceAll(url, dataUrl);

                    console.log(
                        `${LOG}[IMAGE_INLINE] Bytes=${processed.buffer.length} ` +
                        `URL=${url}`
                    );
                } catch (error) {
                    console.warn(
                        `${LOG}[IMAGE_SKIP] Reason=${formatErrorDetail(error)} ` +
                        `URL=${url}`
                    );
                }
            })
        );

        if (i + CONFIG.imageBatchSize < imageUrls.length) {
            await sleep(300);
        }
    }

    const inlinedCount = (html.match(/data:image\//g) || []).length;
    console.log(`${LOG}[IMAGES_DONE] Inlined=${inlinedCount}/${total}`);

    return html;
}

function extractImageUrls(html) {
    const urls = [];
    const regex = /<img[^>]+src=["'](https?:\/\/[^"']+)["']/gi;
    let match;

    while ((match = regex.exec(html)) !== null) {
        if (!urls.includes(match[1])) urls.push(match[1]);
    }

    return urls;
}

async function estimateTotalImageBytes(imageUrls) {
    let totalBytes = 0;
    let successCount = 0;

    await Promise.all(
        imageUrls.map(async (url) => {
            try {
                const response = await fetchWithAbort(
                    url,
                    { method: "HEAD" },
                    CONFIG.imageHeadTimeoutMs
                );
                const contentLength = Number(
                    response.headers.get("content-length") || 0
                );

                if (
                    response.ok &&
                    Number.isFinite(contentLength) &&
                    contentLength > 0
                ) {
                    totalBytes += contentLength;
                    successCount += 1;
                }
            } catch {
                // Use fallback estimate below.
            }
        })
    );

    if (successCount < imageUrls.length / 2) {
        return imageUrls.length * 3 * 1024 * 1024;
    }

    return totalBytes;
}

function chooseImageStrategy(total, totalBytes) {
    if (total <= 6 && totalBytes < 20 * 1024 * 1024) {
        return { maxDimension: 1600, quality: 90, strategy: "HIGH" };
    }

    if (total <= 12 && totalBytes < 40 * 1024 * 1024) {
        return { maxDimension: 1200, quality: 80, strategy: "BALANCED" };
    }

    return { maxDimension: 800, quality: 70, strategy: "AGGRESSIVE" };
}

async function optimizeImage({ sourceBuffer, response, maxDimension, quality }) {
    try {
        const image = sharp(sourceBuffer);
        const metadata = await image.metadata();
        const needsResize =
            Number(metadata.width || 0) > maxDimension ||
            Number(metadata.height || 0) > maxDimension;

        if (metadata.format === "png" && metadata.hasAlpha && !needsResize) {
            return { buffer: sourceBuffer, mimeType: "image/png" };
        }

        let pipeline = image.rotate();
        if (needsResize) {
            pipeline = pipeline.resize(maxDimension, maxDimension, {
                fit: "inside",
                withoutEnlargement: true,
            });
        }

        return {
            buffer: await pipeline.jpeg({ quality }).toBuffer(),
            mimeType: "image/jpeg",
        };
    } catch (error) {
        console.warn(`${LOG}[SHARP_FALLBACK] ${formatErrorDetail(error)}`);
        return {
            buffer: sourceBuffer,
            mimeType: response.headers.get("content-type") || "image/jpeg",
        };
    }
}

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
                    setTimeout(done, 5000);
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
        `briefing-note-${Date.now()}-` +
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

        const responseText = await response.text();
        if (!response.ok) {
            throw new Error(
                `Airtable attachment write returned ${response.status}: ` +
                responseText
            );
        }

        let data;
        try {
            data = JSON.parse(responseText);
        } catch {
            throw new Error(
                "Airtable attachment write returned invalid JSON."
            );
        }

        const attachments =
            data?.records?.[0]?.fields?.[CONFIG.attachmentField] || [];

        if (!Array.isArray(attachments) || !attachments.length) {
            throw new Error(
                `Airtable attachment write succeeded but ` +
                `${CONFIG.attachmentField} was not returned.`
            );
        }

        scheduleCleanup(filePath, tempFilename);
        return attachments[0];
    } catch (error) {
        await cleanupFile(filePath, tempFilename);
        throw error;
    }
}

async function fetchWithTimeout(url, options) {
    try {
        return await fetchWithAbort(
            url,
            options,
            CONFIG.airtableRequestTimeoutMs
        );
    } catch (error) {
        if (String(error?.name || "") === "AbortError") {
            throw new Error(
                `HTTP request timed out after ` +
                `${CONFIG.airtableRequestTimeoutMs / 1000} seconds.`
            );
        }
        throw error;
    }
}

async function fetchWithAbort(url, options, timeoutMs) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timeoutId);
    }
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

function scheduleCleanup(filePath, filename) {
    setTimeout(
        () => cleanupFile(filePath, filename),
        CONFIG.cleanupDelayMs
    );
}

async function cleanupFile(filePath, filename) {
    try {
        if (fs.existsSync(filePath)) {
            await fs.promises.unlink(filePath);
            console.log(`${LOG}[CLEANUP] Deleted ${filename}`);
        }
    } catch (error) {
        console.error(
            `${LOG}[CLEANUP_ERROR] ${filename}: ${formatErrorDetail(error)}`
        );
    }
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

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
