/*
PATRIOLLY — SHARED REPORT PDF FOOTER

Single source of truth for the standard Black Gold Security PDF footer and the
page margin reserved for it. Report-specific workers should keep their own
orientation/content logic and reuse this module for footer presentation.
*/

const DEFAULT_REPORT_FOOTER = Object.freeze({
    companyLine: "Black Gold Security Sdn Bhd (930044-M | 201101001907)",
    addressLine: "No. 9-01 & 02, Jalan Kencana Mas 1/1, Tebrau Business Park, 81100 Johor Bahru",
    contactLine: "07 - 355 4949 | contact@blackgoldsecurity.my | www.blackgoldsecurity.my",
    imageUrl: "https://media.blackgoldsecurity.com.my/report-logo/260102_SME%20%26%20ISO.png",
});

const DEFAULT_REPORT_PDF_MARGINS = Object.freeze({
    top: "14mm",
    bottom: "34mm",
    left: "12mm",
    right: "12mm",
});

const COMPACT_FOOTER_LEFT_INSET = "8mm";
const COMPACT_FOOTER_RIGHT_INSET = "8mm";

function getReportPdfMargins(overrides = {}) {
    return {
        ...DEFAULT_REPORT_PDF_MARGINS,
        ...overrides,
    };
}

function buildReportFooterTemplate({
    footerImageDataUrl = "",
    footer = DEFAULT_REPORT_FOOTER,
    layout = "stacked",
} = {}) {
    const certificateImage = footerImageDataUrl
        ? `<img class="pdf-footer-cert-logo" src="${footerImageDataUrl}" alt="SME &amp; ISO">`
        : "";

    if (layout === "compact") {
        return `<style>.pdf-footer{position:relative;width:100%;height:28mm;box-sizing:border-box;overflow:hidden;background:#ffffff;font-family:Arial,sans-serif;font-size:10px;line-height:1.1;color:#536273;}.pdf-footer-inner{position:absolute;top:0;right:${COMPACT_FOOTER_RIGHT_INSET};bottom:0;left:${COMPACT_FOOTER_LEFT_INSET};box-sizing:border-box;padding-top:3mm;overflow:hidden;}.pdf-footer-row{display:flex;width:100%;height:100%;box-sizing:border-box;align-items:center;justify-content:space-between;gap:8px;overflow:hidden;}.pdf-footer-info{flex:1 1 auto;min-width:0;overflow:hidden;}.pdf-footer-info-line{display:block;min-width:0;overflow:hidden;white-space:nowrap;line-height:1.1;}.pdf-footer-logos{flex:0 0 36%;min-width:0;display:flex;align-items:center;justify-content:flex-end;overflow:hidden;white-space:nowrap;}.pdf-footer-cert-logo{display:block;width:250px;max-width:100%;height:auto;max-height:86px;object-fit:contain;border:0;}</style><div class="pdf-footer"><div class="pdf-footer-inner"><div class="pdf-footer-row"><div class="pdf-footer-info"><div class="pdf-footer-info-line">${footer.companyLine}</div><div class="pdf-footer-info-line">${footer.addressLine}</div><div class="pdf-footer-info-line">${footer.contactLine}</div></div><div class="pdf-footer-logos">${certificateImage}</div></div></div></div>`;
    }

    return `<style>.pdf-footer{width:100%;height:28mm;box-sizing:border-box;background:#ffffff;font-family:Arial,sans-serif;font-size:12px;line-height:1.25;color:#536273;}.pdf-footer-inner{width:100%;height:100%;box-sizing:border-box;padding:5px 8mm 0;}.pdf-footer-table{width:100%;height:100%;table-layout:fixed;border-collapse:collapse;}.pdf-footer-text-cell{width:62%;padding:0;vertical-align:middle;text-align:left;}.pdf-footer-cert-cell{width:38%;padding:0 2mm 0 8px;vertical-align:middle;text-align:right;}.pdf-footer-cert-logo{display:inline-block;width:280px;max-width:100%;height:auto;max-height:90px;object-fit:contain;border:0;}</style><div class="pdf-footer"><div class="pdf-footer-inner"><table role="presentation" class="pdf-footer-table"><tr><td class="pdf-footer-text-cell">${footer.companyLine}<br>${footer.addressLine}<br>${footer.contactLine}</td><td class="pdf-footer-cert-cell">${certificateImage}</td></tr></table></div></div>`;
}

async function fetchReportFooterImageDataUrl({
    imageUrl = DEFAULT_REPORT_FOOTER.imageUrl,
    timeoutMs = 15000,
    logPrefix = "[PATRIOLLY][SHARED_REPORT_FOOTER]",
} = {}) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(imageUrl, {
            method: "GET",
            signal: controller.signal,
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        const mimeType = String(
            response.headers.get("content-type") || "image/png"
        )
            .split(";", 1)[0]
            .trim();

        console.log(
            `${logPrefix}[FOOTER_IMAGE] Status=READY Bytes=${buffer.length}`
        );

        return `data:${mimeType};base64,${buffer.toString("base64")}`;
    } catch (error) {
        const message = String(error?.message || error || "Unknown error");

        console.warn(
            `${logPrefix}[FOOTER_IMAGE] Status=SKIPPED Reason=${message}`
        );

        return "";
    } finally {
        clearTimeout(timeoutId);
    }
}

function buildReportPdfOptions({
    footerImageDataUrl = "",
    format = "A4",
    landscape = false,
    timeout = 30000,
    marginOverrides = {},
    footerLayout = "stacked",
} = {}) {
    return {
        format,
        landscape,
        printBackground: true,
        displayHeaderFooter: true,
        headerTemplate: "<div></div>",
        footerTemplate: buildReportFooterTemplate({
            footerImageDataUrl,
            layout: footerLayout,
        }),
        margin: getReportPdfMargins(marginOverrides),
        timeout,
    };
}

module.exports = {
    DEFAULT_REPORT_FOOTER,
    DEFAULT_REPORT_PDF_MARGINS,
    getReportPdfMargins,
    buildReportFooterTemplate,
    fetchReportFooterImageDataUrl,
    buildReportPdfOptions,
};
