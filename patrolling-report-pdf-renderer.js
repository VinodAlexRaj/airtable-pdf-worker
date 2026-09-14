/*
PATRIOLLY — PATROLLING REPORT PDF RENDERER

Worker-side renderer for the existing /generate-pdf Patrolling Report route.
It keeps Patrolling-specific rendering separate while reusing the shared footer
and footer-safe page margins.

Expected server.js integration:

const generatePatrollingReportPdf = require('./patrolling-report-pdf-renderer');

const pdfBuffer = await generatePatrollingReportPdf({
    htmlContent,
    getBrowser,
    inlineImages,
});
*/

const {
    buildReportPdfOptions,
    fetchReportFooterImageDataUrl,
} = require("./shared-report-footer");

const CONFIG = {
    viewportWidth: 1200,
    viewportHeight: 1600,
    pdfTimeoutMs: 30000,
};

async function generatePatrollingReportPdf({
    htmlContent,
    getBrowser,
    inlineImages,
    retries = 1,
}) {
    if (!String(htmlContent || "").trim()) {
        throw new Error("INPUT ERROR: htmlContent is required.");
    }

    if (typeof getBrowser !== "function") {
        throw new Error("CONFIGURATION ERROR: getBrowser must be a function.");
    }

    if (typeof inlineImages !== "function") {
        throw new Error("CONFIGURATION ERROR: inlineImages must be a function.");
    }

    let page = null;

    try {
        const browser = await getBrowser();
        page = await browser.newPage();

        await page.setViewport({
            width: CONFIG.viewportWidth,
            height: CONFIG.viewportHeight,
        });
        await page.emulateMediaType("print");

        const preparedHtml = await inlineImages(htmlContent);

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

        await page.setContent(preparedHtml, {
            waitUntil: "domcontentloaded",
            timeout: CONFIG.pdfTimeoutMs,
        });

        await waitForImages(page);
        await page.evaluate(async () => {
            if (document.fonts?.ready) {
                await document.fonts.ready;
            }
        });

        const footerImageDataUrl = await fetchReportFooterImageDataUrl({
            logPrefix: "[PATRIOLLY][PATROLLING_REPORT_PDF_WORKER]",
        });

        return await page.pdf(
            buildReportPdfOptions({
                footerImageDataUrl,
                format: "A4",
                landscape: false,
                timeout: CONFIG.pdfTimeoutMs,
            })
        );
    } catch (error) {
        const message = String(error?.message || error || "Unknown error");
        const isTransientBrowserFailure =
            message.includes("detached") ||
            message.includes("Connection closed") ||
            message.includes("Target closed");

        if (retries > 0 && isTransientBrowserFailure) {
            return generatePatrollingReportPdf({
                htmlContent,
                getBrowser,
                inlineImages,
                retries: retries - 1,
            });
        }

        throw new Error(`PDF generation failed: ${message}`);
    } finally {
        if (page) {
            try {
                await page.close();
            } catch (error) {
                console.error(
                    `[PATRIOLLY][PATROLLING_REPORT_PDF_WORKER][PAGE_CLOSE_ERROR] ` +
                    String(error?.message || error || "Unknown error")
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
                if (img.complete) {
                    return Promise.resolve();
                }

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

module.exports = generatePatrollingReportPdf;