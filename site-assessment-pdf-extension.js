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

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

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
    pdfFooter: {
        companyLine: "Black Gold Security Sdn Bhd 930044-M | 201101001907",
        addressLine: "No. 9-01 & 02, Jalan Kencana Mas 1/1, Tebrau Business Park, 81100 Johor Bahru",
        contactLine: "07 - 355 4949 | contact@blackgoldsecurity.my | www.blackgoldsecurity.my",
        imageUrl: "https://media.blackgoldsecurity.com.my/report-logo/260102_SME%20%26%20ISO.png",
    },
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

async function inlineImages(html) {
    const imageUrls = extractImageUrls(html);
    const total = imageUrls.length;

    if (total === 0) {
        console.log("[PATRIOLLY][SITE_ASSESSMENT_PDF_WORKER][IMAGES] Count=0");
        return html;
    }

    const totalBytes = await estimateTotalImageBytes(imageUrls);
    const { maxDimension, quality, strategy } = chooseImageStrategy(
        total,
        totalBytes
    );

    console.log(
        `[PATRIOLLY][SITE_ASSESSMENT_PDF_WORKER][IMAGES] ` +
        `Count=${total} EstimatedMB=${(totalBytes / 1024 / 1024).toFixed(2)} ` +
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
                            `[PATRIOLLY][SITE_ASSESSMENT_PDF_WORKER][IMAGE_SKIP] ` +
                            `HTTP=${response.status} URL=${url}`
                        );
                        return;
                    }

                    const sourceBuffer = Buffer.from(await response.arrayBuffer());
                    const processed = await optimizeImage({
                        sourceBuffer,
                        response,
                        maxDimension,
                        quality,
                    });

                    if (processed.buffer.length > CONFIG.maxFinalImageBytes) {
                        console.warn(
                            `[PATRIOLLY][SITE_ASSESSMENT_PDF_WORKER][IMAGE_SKIP] ` +
                            `Reason=TOO_LARGE Bytes=${processed.buffer.length} URL=${url}`
                        );
                        return;
                    }

                    const dataUrl =
                        `data:${processed.mimeType};base64,` +
                        processed.buffer.toString("base64");
                    html = html.replaceAll(url, dataUrl);

                    console.log(
                        `[PATRIOLLY][SITE_ASSESSMENT_PDF_WORKER][IMAGE_INLINE] ` +
                        `Bytes=${processed.buffer.length} URL=${url}`
                    );
                } catch (error) {
                    console.warn(
                        `[PATRIOLLY][SITE_ASSESSMENT_PDF_WORKER][IMAGE_SKIP] ` +
                        `Reason=${formatErrorDetail(error)} URL=${url}`
                    );
                }
            })
        );

        if (i + CONFIG.imageBatchSize < imageUrls.length) {
            await sleep(300);
        }
    }

    const inlinedCount = (html.match(/data:image\//g) || []).length;
    console.log(
        `[PATRIOLLY][SITE_ASSESSMENT_PDF_WORKER][IMAGES_DONE] ` +
        `Inlined=${inlinedCount}/${total}`
    );

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
                if (response.ok && Number.isFinite(contentLength) && contentLength > 0) {
                    totalBytes += contentLength;
                    successCount += 1;
                }
            } catch {
                // Fall back to estimate below.
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
        console.warn(
            `[PATRIOLLY][SITE_ASSESSMENT_PDF_WORKER][SHARP_FALLBACK] ` +
            formatErrorDetail(error)
        );
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
            footerTemplate: buildPdfFooterTemplate(),
            margin: { top: "10px", bottom: "52px", left: "8px", right: "8px" },
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
                    `[PATRIOLLY][SITE_ASSESSMENT_PDF_WORKER][PAGE_CLOSE_ERROR] ` +
                    formatErrorDetail(error)
                );
            }
        }
    }
}

function buildPdfFooterTemplate() {
    const footer = CONFIG.pdfFooter;
    return `<div style="width:100%;box-sizing:border-box;padding:0 8px;font-family:Arial,sans-serif;font-size:7px;line-height:1.25;color:#536273;"><table role="presentation" style="width:100%;table-layout:fixed;border-collapse:collapse;"><tr><td style="width:80%;padding:0;vertical-align:middle;text-align:left;">${footer.companyLine}<br>${footer.addressLine}<br>${footer.contactLine}</td><td style="width:20%;padding:0 0 0 8px;vertical-align:middle;text-align:right;"><img src="${footer.imageUrl}" alt="SME &amp; ISO" style="display:inline-block;width:78px;max-width:100%;height:auto;max-height:28px;object-fit:contain;border:0;"></td></tr></table></div>`;
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
        `${encodeURIComponent(CONFIG.siteAssessmentReportTableName)}/${recordId}`;
    const response = await fetchWithTimeout(url, {
        headers: { Authorization: `Bearer ${airtableApiKey}` },
    });
    const body = await response.text();

    if (!response.ok) {
        throw new Error(`Airtable preflight returned ${response.status}: ${body}`);
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
        `site-assessment-${Date.now()}-` +
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
            encodeURIComponent(CONFIG.siteAssessmentReportTableName);

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
            throw new Error("Airtable attachment write returned invalid JSON.");
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
        return await fetchWithAbort(url, options, CONFIG.airtableRequestTimeoutMs);
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
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timerId));
}

function buildAttachmentFilename(assessmentId) {
    const safe = String(assessmentId)
        .trim()
        .replace(/[\\/:*?"<>|]+/g, "-")
        .replace(/\s+/g, " ");
    return `${safe || "Site Assessment Report"}.pdf`;
}

function scheduleCleanup(filePath, filename) {
    setTimeout(() => cleanupFile(filePath, filename), CONFIG.cleanupDelayMs);
}

async function cleanupFile(filePath, filename) {
    try {
        if (fs.existsSync(filePath)) {
            await fs.promises.unlink(filePath);
            console.log(
                `[PATRIOLLY][SITE_ASSESSMENT_PDF_WORKER][CLEANUP] ` +
                `Deleted ${filename}`
            );
        }
    } catch (error) {
        console.error(
            `[PATRIOLLY][SITE_ASSESSMENT_PDF_WORKER][CLEANUP_ERROR] ` +
            `${filename}: ${formatErrorDetail(error)}`
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

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}