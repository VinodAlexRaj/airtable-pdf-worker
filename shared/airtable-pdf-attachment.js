const fs = require("fs");
const path = require("path");

const ROOT_PUBLIC_DIR = path.join(__dirname, "..", "public");

async function assertAttachmentFieldEmpty({
    recordId,
    airtableApiKey,
    airtableBaseId,
    airtableTableName,
    attachmentField,
    requestTimeoutMs = 15000,
    timeoutErrorMessage = null,
    responseParser = "text-json",
    invalidJsonMessage = "Airtable preflight returned invalid JSON.",
    conflictMessage,
}) {
    const url =
        `https://api.airtable.com/v0/${airtableBaseId}/` +
        `${encodeURIComponent(airtableTableName)}/${recordId}`;

    const response = await fetchWithTimeout(
        url,
        {
            method: "GET",
            headers: {
                Authorization: `Bearer ${airtableApiKey}`,
            },
        },
        { requestTimeoutMs, timeoutErrorMessage }
    );

    if (!response.ok) {
        const body = await response.text();
        throw new Error(
            `Airtable preflight returned ${response.status}: ${body}`
        );
    }

    const record = await parseJsonResponse(
        response,
        responseParser,
        invalidJsonMessage
    );
    const attachments = record?.fields?.[attachmentField] || [];

    if (Array.isArray(attachments) && attachments.length > 0) {
        throw new Error(
            conflictMessage ||
            `CONFLICT ERROR: ${attachmentField} already exists on ` +
            `record "${recordId}". Automatic replacement is not allowed.`
        );
    }
}

async function attachPdfToAirtable({
    pdfBuffer,
    recordId,
    filename,
    publicBaseUrl,
    airtableApiKey,
    airtableBaseId,
    airtableTableName,
    attachmentField,
    tempFilename,
    tempFilenamePrefix = "report",
    encodePublicFilename = true,
    cleanupDelayMs = 60000,
    requestTimeoutMs = 15000,
    timeoutErrorMessage = null,
    responseErrorPrefix = "Airtable attachment write returned",
    invalidJsonMessage = "Airtable attachment write returned invalid JSON.",
    missingAttachmentMessage =
        `Airtable attachment write succeeded but ${attachmentField} ` +
        "was not returned on the updated record.",
    verifyAttachment = true,
    requireTruthyAttachment = false,
    onFileSaved,
    cleanupCallbacks = {},
}) {
    const temporaryFilename =
        tempFilename || buildTemporaryFilename(tempFilenamePrefix);
    const filePath = path.join(ROOT_PUBLIC_DIR, temporaryFilename);

    try {
        if (!fs.existsSync(ROOT_PUBLIC_DIR)) {
            fs.mkdirSync(ROOT_PUBLIC_DIR, { recursive: true });
        }

        await fs.promises.writeFile(filePath, pdfBuffer);
        if (typeof onFileSaved === "function") {
            onFileSaved(temporaryFilename);
        }

        const base = String(publicBaseUrl).replace(/\/$/, "");
        const publicFilename = encodePublicFilename
            ? encodeURIComponent(temporaryFilename)
            : temporaryFilename;
        const publicUrl = `${base}/public/${publicFilename}`;
        const airtableUrl =
            `https://api.airtable.com/v0/${airtableBaseId}/` +
            encodeURIComponent(airtableTableName);

        const response = await fetchWithTimeout(
            airtableUrl,
            {
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
                                [attachmentField]: [
                                    { url: publicUrl, filename },
                                ],
                            },
                        },
                    ],
                }),
            },
            { requestTimeoutMs, timeoutErrorMessage }
        );

        if (!response.ok) {
            const responseText = await response.text();
            throw new Error(
                `${responseErrorPrefix} ${response.status}: ${responseText}`
            );
        }

        let result = true;
        if (verifyAttachment) {
            const responseData = await parseJsonResponse(
                response,
                "text-json",
                invalidJsonMessage
            );
            const attachments =
                responseData?.records?.[0]?.fields?.[attachmentField] || [];

            if (
                !Array.isArray(attachments) ||
                attachments.length === 0 ||
                (requireTruthyAttachment && !attachments[0])
            ) {
                throw new Error(missingAttachmentMessage);
            }

            result = attachments[0];
        }

        scheduleCleanup(
            filePath,
            temporaryFilename,
            cleanupDelayMs,
            cleanupCallbacks
        );

        return result;
    } catch (error) {
        await cleanupFile(filePath, temporaryFilename, cleanupCallbacks);
        throw error;
    }
}

async function fetchWithTimeout(
    url,
    options,
    { requestTimeoutMs = 15000, timeoutErrorMessage = null } = {}
) {
    const controller = new AbortController();
    const timeoutId = setTimeout(
        () => controller.abort(),
        requestTimeoutMs
    );

    try {
        return await fetch(url, {
            ...options,
            signal: controller.signal,
        });
    } catch (error) {
        if (error?.name === "AbortError" && timeoutErrorMessage) {
            throw new Error(
                typeof timeoutErrorMessage === "function"
                    ? timeoutErrorMessage(requestTimeoutMs)
                    : timeoutErrorMessage
            );
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }
}

async function parseJsonResponse(response, parser, invalidJsonMessage) {
    if (parser === "json") {
        return response.json();
    }

    const body = await response.text();
    try {
        return JSON.parse(body);
    } catch {
        throw new Error(invalidJsonMessage);
    }
}

function buildTemporaryFilename(prefix) {
    return `${prefix}-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 10)}.pdf`;
}

function scheduleCleanup(filePath, filename, delayMs, callbacks) {
    setTimeout(
        () => cleanupFile(filePath, filename, callbacks),
        delayMs
    );
}

async function cleanupFile(filePath, filename, callbacks = {}) {
    try {
        if (fs.existsSync(filePath)) {
            await fs.promises.unlink(filePath);
            if (typeof callbacks.onDeleted === "function") {
                callbacks.onDeleted(filename);
            }
        } else if (typeof callbacks.onMissing === "function") {
            callbacks.onMissing(filename);
        }
    } catch (error) {
        if (typeof callbacks.onError === "function") {
            callbacks.onError(filename, error);
        }
    }
}

module.exports = {
    assertAttachmentFieldEmpty,
    attachPdfToAirtable,
    fetchWithTimeout,
};
