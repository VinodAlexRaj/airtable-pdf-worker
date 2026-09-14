const DEFAULT_VIEWPORT = Object.freeze({
    width: 1200,
    height: 1600,
});

async function generatePdf(options = {}) {
    const {
        htmlContent,
        getBrowser,
        viewport = DEFAULT_VIEWPORT,
        prepareHtml,
        preparePage,
        setContentOptions = {
            waitUntil: "domcontentloaded",
            timeout: 30000,
        },
        blockGoogleFonts = false,
        waitForImagesTimeoutMs = 0,
        waitForFonts = true,
        styleContent = "",
        pdfOptions,
        logPrefix = "[PATRIOLLY][SHARED_PDF_RENDERER]",
        formatErrorDetail: formatErrorDetailOption,
        retries = 1,
    } = options;

    const formatError =
        typeof formatErrorDetailOption === "function"
            ? formatErrorDetailOption
            : formatErrorDetail;

    let page = null;

    try {
        const browser = await getBrowser();
        page = await browser.newPage();

        await page.setViewport({
            ...DEFAULT_VIEWPORT,
            ...viewport,
        });
        await page.emulateMediaType("print");

        const preparedHtml =
            typeof prepareHtml === "function"
                ? await prepareHtml(htmlContent)
                : htmlContent;

        if (blockGoogleFonts) {
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
        }

        await page.setContent(preparedHtml, setContentOptions);

        if (styleContent) {
            await page.addStyleTag({ content: styleContent });
        }

        if (typeof preparePage === "function") {
            await preparePage(page, { htmlContent: preparedHtml });
        }

        if (waitForImagesTimeoutMs > 0) {
            await waitForImages(page, waitForImagesTimeoutMs);
        }

        if (waitForFonts) {
            await page.evaluate(async () => {
                if (document.fonts?.ready) {
                    await document.fonts.ready;
                }
            });
        }

        const resolvedPdfOptions =
            typeof pdfOptions === "function"
                ? await pdfOptions({ page, htmlContent: preparedHtml })
                : pdfOptions;

        return await page.pdf(resolvedPdfOptions);
    } catch (error) {
        const message = formatError(error);

        if (
            retries > 0 &&
            (message.includes("detached") ||
                message.includes("Connection closed") ||
                message.includes("Target closed"))
        ) {
            return generatePdf({ ...options, retries: retries - 1 });
        }

        throw new Error(`PDF generation failed: ${message}`);
    } finally {
        if (page) {
            try {
                await page.close();
            } catch (error) {
                if (logPrefix) {
                    console.error(
                        `${logPrefix}[PAGE_CLOSE_ERROR] ` +
                        formatError(error)
                    );
                }
            }
        }
    }
}

async function waitForImages(page, timeoutMs) {
    await page.evaluate(async (imageTimeoutMs) => {
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
                    setTimeout(done, imageTimeoutMs);
                });
            })
        );
    }, timeoutMs);
}

function formatErrorDetail(value) {
    return String(value?.message || value || "Unknown error");
}

module.exports = {
    generatePdf,
};
