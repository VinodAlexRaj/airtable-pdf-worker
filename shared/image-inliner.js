const sharp = require("sharp");

const DEFAULTS = Object.freeze({
    imageHeadTimeoutMs: 5000,
    imageFetchTimeoutMs: 15000,
    imageBatchSize: 3,
    maxFinalImageBytes: 5 * 1024 * 1024,
});

async function inlineImages(html, options = {}) {
    const {
        logPrefix = "[PATRIOLLY][SHARED_IMAGE_INLINER]",
        imageHeadTimeoutMs = DEFAULTS.imageHeadTimeoutMs,
        imageFetchTimeoutMs = DEFAULTS.imageFetchTimeoutMs,
        imageBatchSize = DEFAULTS.imageBatchSize,
        maxFinalImageBytes = DEFAULTS.maxFinalImageBytes,
    } = options;

    const imageUrls = extractImageUrls(html);
    const total = imageUrls.length;

    if (total === 0) {
        console.log(`${logPrefix}[IMAGES] Count=0`);
        return html;
    }

    const totalBytes = await estimateTotalImageBytes(
        imageUrls,
        imageHeadTimeoutMs
    );
    const { maxDimension, quality, strategy } = chooseImageStrategy(
        total,
        totalBytes
    );

    console.log(
        `${logPrefix}[IMAGES] ` +
        `Count=${total} EstimatedMB=${(totalBytes / 1024 / 1024).toFixed(2)} ` +
        `Strategy=${strategy} MaxDimension=${maxDimension} Quality=${quality}`
    );

    for (let i = 0; i < imageUrls.length; i += imageBatchSize) {
        const batch = imageUrls.slice(i, i + imageBatchSize);

        await Promise.all(
            batch.map(async (url) => {
                try {
                    const response = await fetchWithAbort(
                        url,
                        { method: "GET" },
                        imageFetchTimeoutMs
                    );

                    if (!response.ok) {
                        console.warn(
                            `${logPrefix}[IMAGE_SKIP] HTTP=${response.status} URL=${url}`
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
                        logPrefix,
                    });

                    if (processed.buffer.length > maxFinalImageBytes) {
                        console.warn(
                            `${logPrefix}[IMAGE_SKIP] Reason=TOO_LARGE ` +
                            `Bytes=${processed.buffer.length} URL=${url}`
                        );
                        return;
                    }

                    const dataUrl =
                        `data:${processed.mimeType};base64,` +
                        processed.buffer.toString("base64");
                    html = html.replaceAll(url, dataUrl);

                    console.log(
                        `${logPrefix}[IMAGE_INLINE] Bytes=${processed.buffer.length} ` +
                        `URL=${url}`
                    );
                } catch (error) {
                    console.warn(
                        `${logPrefix}[IMAGE_SKIP] Reason=${formatErrorDetail(error)} ` +
                        `URL=${url}`
                    );
                }
            })
        );

        if (i + imageBatchSize < imageUrls.length) {
            await sleep(300);
        }
    }

    const inlinedCount = (html.match(/data:image\//g) || []).length;
    console.log(
        `${logPrefix}[IMAGES_DONE] Inlined=${inlinedCount}/${total}`
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

async function estimateTotalImageBytes(imageUrls, timeoutMs) {
    let totalBytes = 0;
    let successCount = 0;

    await Promise.all(
        imageUrls.map(async (url) => {
            try {
                const response = await fetchWithAbort(
                    url,
                    { method: "HEAD" },
                    timeoutMs
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

async function optimizeImage({
    sourceBuffer,
    response,
    maxDimension,
    quality,
    logPrefix,
}) {
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
            `${logPrefix}[SHARP_FALLBACK] ${formatErrorDetail(error)}`
        );
        return {
            buffer: sourceBuffer,
            mimeType: response.headers.get("content-type") || "image/jpeg",
        };
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

module.exports = {
    inlineImages,
};
