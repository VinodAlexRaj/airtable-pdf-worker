const sharp = require("sharp");

const {
    buildReportPdfOptions,
    fetchReportFooterImageDataUrl,
} = require("../shared/report-footer");
const { attachPdfToAirtable } = require("../shared/airtable-pdf-attachment");
const { generatePdf: renderPdf } = require("../shared/pdf-renderer");

const CONFIG = {
    route: "/generate-pdf",
    airtableTableName: "Patrolling Report",
    attachmentField: "Approval Attachment",
    cleanupDelayMs: 60000,
    airtableRequestTimeoutMs: 15000,
    pdfTimeoutMs: 30000,
    viewportWidth: 1200,
    viewportHeight: 1600,
};

const LOG = "[PATRIOLLY][PATROLLING_REPORT_PDF_WORKER]";

module.exports = function registerPatrollingReportPdfExtension(context) {
    const {
        app,
        getBrowser,
        scheduleIdleClose,
        publicBaseUrl,
        internalAuthToken,
        reportPdfAuthToken,
        airtableApiKey,
        airtableBaseId,
    } = context || {};

    const jobQueue = [];
    let isProcessing = false;
    const isPatrollingBusy = () => jobQueue.length > 0 || isProcessing;

    if (typeof scheduleIdleClose === "function") {
        scheduleIdleClose(isPatrollingBusy);
    }

    async function processQueue() {
        if (isProcessing || jobQueue.length === 0) return;
        isProcessing = true;

        const { htmlContent, recordId, location } = jobQueue.shift();
        console.log(
            `Processing job for record ${recordId}. Queue remaining: ${jobQueue.length}`
        );

        try {
            const pdfBuffer = await generatePatrollingReportPdf({
                htmlContent,
                getBrowser,
            });

            const fileName = generateFileName(location);
            try {
                await attachPdfToAirtable({
                    pdfBuffer,
                    recordId,
                    filename: fileName,
                    publicBaseUrl,
                    airtableApiKey,
                    airtableBaseId,
                    airtableTableName: CONFIG.airtableTableName,
                    attachmentField: CONFIG.attachmentField,
                    tempFilename: fileName,
                    encodePublicFilename: false,
                    cleanupDelayMs: CONFIG.cleanupDelayMs,
                    requestTimeoutMs: CONFIG.airtableRequestTimeoutMs,
                    responseErrorPrefix: "Airtable API returned",
                    verifyAttachment: false,
                    onFileSaved: (filename) => {
                        console.log(`File saved: ${filename}`);
                    },
                    cleanupCallbacks: {
                        onDeleted: (filename) => {
                            console.log(`Cleanup success: Deleted ${filename}`);
                        },
                        onMissing: (filename) => {
                            console.log(
                                `Cleanup skip: File ${filename} already removed`
                            );
                        },
                        onError: (filename, error) => {
                            console.error(
                                `Cleanup error for ${filename}:`,
                                error.message
                            );
                        },
                    },
                });
            } catch (error) {
                console.error(
                    `Airtable upload error for ${fileName}:`,
                    error.message
                );
                throw error;
            }
            console.log(`PDF successfully attached to record ${recordId}`);
        } catch (error) {
            console.error(
                `PDF generation failed for record ${recordId}:`,
                error.message
            );
        } finally {
            isProcessing = false;

            if (jobQueue.length > 0) {
                console.log(
                    `Cooling down before next job... (${jobQueue.length} remaining)`
                );
                setTimeout(processQueue, 2000);
            } else {
                console.log("Queue empty. Starting browser idle timer.");
                scheduleIdleClose(isPatrollingBusy);
            }
        }
    }

    app.post(CONFIG.route, async (req, res) => {
        const secret = req.headers["x-auth-token"];

        const isAuthorized =
            secret === internalAuthToken || secret === reportPdfAuthToken;

        if (!secret || !isAuthorized) {
            return res.status(401).json({ error: "Unauthorized" });
        }

        const { htmlContent, recordId, location } = req.body;
        if (!htmlContent || !recordId || !location) {
            return res.status(400).json({
                error: "Missing required fields: htmlContent, recordId, and location",
            });
        }

        jobQueue.push({ htmlContent, recordId, location });
        console.log(
            `Job queued for record ${recordId}. Queue length: ${jobQueue.length}`
        );

        res.status(202).json({
            message:
                "PDF generation queued. It will be attached to the record shortly.",
            queuePosition: jobQueue.length,
        });

        processQueue();
    });
};

async function generatePatrollingReportPdf(
    { htmlContent, getBrowser },
    retries = 1
) {
    if (!String(htmlContent || "").trim()) {
        throw new Error("INPUT ERROR: htmlContent is required.");
    }

    if (typeof getBrowser !== "function") {
        throw new Error("CONFIGURATION ERROR: getBrowser must be a function.");
    }

    return renderPdf({
        htmlContent,
        getBrowser,
        retries,
        prepareHtml: inlineImages,
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
            const footerImageDataUrl =
                await fetchReportFooterImageDataUrl({ logPrefix: LOG });

            return buildReportPdfOptions({
                footerImageDataUrl,
                format: "A4",
                landscape: false,
                timeout: CONFIG.pdfTimeoutMs,
                footerLayout: "compact",
            });
        },
        logPrefix: LOG,
    });
}

// Patrolling retains its historical image behavior because its URL parsing,
// HEAD fallback, and Sharp orientation handling differ from other reports.
async function inlineImages(html) {
    const MAX_DIMENSION_FEW = 1600;
    const MAX_DIMENSION_MANY = 1200;
    const MAX_DIMENSION_LOTS = 800;
    const QUALITY_FEW = 90;
    const QUALITY_MANY = 80;
    const QUALITY_LOTS = 70;
    const MAX_FINAL_SIZE_BYTES = 5 * 1024 * 1024;
    const BATCH_SIZE = 3;

    const imageUrls = [];
    const regex = /<img[^>]+src="(https?:\/\/[^\"]+)"/g;
    let match;
    while ((match = regex.exec(html)) !== null) {
        if (!imageUrls.includes(match[1])) {
            imageUrls.push(match[1]);
        }
    }

    const total = imageUrls.length;
    console.log(`Found ${total} unique image(s) in HTML`);

    console.log("Pre-checking image sizes via HEAD requests...");
    let totalBytes = 0;
    let headSuccessCount = 0;

    await Promise.all(
        imageUrls.map(async (url) => {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 5000);
                const response = await fetch(url, {
                    method: "HEAD",
                    signal: controller.signal,
                });
                clearTimeout(timeoutId);

                const contentLength = response.headers.get("content-length");
                if (contentLength) {
                    totalBytes += parseInt(contentLength);
                    headSuccessCount++;
                }
            } catch {
                // HEAD not supported, skip — we'll estimate below
            }
        })
    );

    if (headSuccessCount < total / 2) {
        totalBytes = total * 3 * 1024 * 1024;
        console.log(
            `HEAD checks unreliable, estimating total: ${(totalBytes / 1024 / 1024).toFixed(2)}MB`
        );
    } else {
        console.log(
            `Estimated total size: ${(totalBytes / 1024 / 1024).toFixed(2)}MB ` +
            `from ${headSuccessCount}/${total} HEAD checks`
        );
    }

    let maxDimension;
    let quality;
    let strategy;
    if (total <= 6 && totalBytes < 20 * 1024 * 1024) {
        maxDimension = MAX_DIMENSION_FEW;
        quality = QUALITY_FEW;
        strategy = "high quality (≤6 images)";
    } else if (total <= 12 && totalBytes < 40 * 1024 * 1024) {
        maxDimension = MAX_DIMENSION_MANY;
        quality = QUALITY_MANY;
        strategy = "balanced (7–12 images)";
    } else {
        maxDimension = MAX_DIMENSION_LOTS;
        quality = QUALITY_LOTS;
        strategy = "aggressive (13+ images or large total size)";
    }
    console.log(
        `Using strategy: ${strategy} — maxDimension: ${maxDimension}px, quality: ${quality}%`
    );

    for (let i = 0; i < imageUrls.length; i += BATCH_SIZE) {
        const batch = imageUrls.slice(i, i + BATCH_SIZE);
        console.log(
            `Processing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(total / BATCH_SIZE)}`
        );

        await Promise.all(
            batch.map(async (url) => {
                try {
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 15000);
                    const response = await fetch(url, {
                        signal: controller.signal,
                    });
                    clearTimeout(timeoutId);

                    if (!response.ok) {
                        console.warn(
                            `Skipping image (fetch failed ${response.status}): ${url}`
                        );
                        return;
                    }

                    const buffer = Buffer.from(await response.arrayBuffer());
                    let finalBuffer;
                    let mimeType = "image/jpeg";

                    try {
                        const image = sharp(buffer);
                        const metadata = await image.metadata();
                        const needsResize =
                            metadata.width > maxDimension ||
                            metadata.height > maxDimension;

                        console.log(
                            `Processing ${metadata.width}x${metadata.height} ` +
                            `(${Math.round(buffer.byteLength / 1024)}KB): ${url}`
                        );

                        if (needsResize) {
                            finalBuffer = await image
                                .resize(maxDimension, maxDimension, {
                                    fit: "inside",
                                    withoutEnlargement: true,
                                })
                                .jpeg({ quality })
                                .toBuffer();
                        } else if (
                            metadata.format !== "png" ||
                            !metadata.hasAlpha
                        ) {
                            finalBuffer = await image.jpeg({ quality }).toBuffer();
                        } else {
                            finalBuffer = buffer;
                            mimeType = "image/png";
                        }

                        if (finalBuffer.byteLength > MAX_FINAL_SIZE_BYTES) {
                            console.warn(
                                `Skipping — still too large after resize ` +
                                `(${Math.round(finalBuffer.byteLength / 1024)}KB): ${url}`
                            );
                            return;
                        }
                    } catch (sharpError) {
                        console.warn(
                            `Sharp failed, using original: ${sharpError.message}`
                        );
                        finalBuffer = buffer;
                        mimeType =
                            response.headers.get("content-type") || "image/jpeg";
                    }

                    const base64 = finalBuffer.toString("base64");
                    const dataUrl = `data:${mimeType};base64,${base64}`;
                    html = html.replaceAll(url, dataUrl);
                    console.log(
                        `Inlined → ${Math.round(finalBuffer.byteLength / 1024)}KB: ${url}`
                    );
                } catch (error) {
                    console.warn(
                        `Failed to inline, leaving original URL: ${url} — ${error.message}`
                    );
                }
            })
        );

        if (i + BATCH_SIZE < imageUrls.length) {
            await new Promise((resolve) => setTimeout(resolve, 300));
        }
    }

    const finalCount = (html.match(/data:image\//g) || []).length;
    console.log(`Inlining complete — ${finalCount}/${total} image(s) inlined`);
    return html;
}

function generateFileName(location) {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    const dateStr = `${year}${month}${day}`;
    const timestamp = Date.now();

    return `Report-${dateStr}-${location}-${timestamp}.pdf`;
}
