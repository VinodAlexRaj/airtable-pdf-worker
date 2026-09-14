const express = require('express');
const puppeteer = require('puppeteer');
const path = require('path');
const app = express();
const port = process.env.PORT || 3000;
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL;
const INTERNAL_AUTH_TOKEN = process.env.INTERNAL_AUTH_TOKEN;
const REPORT_PDF_AUTH_TOKEN = process.env.REPORT_PDF_AUTH_TOKEN;

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb' }));
app.use('/public', express.static(path.join(__dirname, 'public')));

// Browser pool for faster PDF generation
let browserInstance = null;
let browserIdleTimer = null;
let browserBusyCheck = () => false;
const BROWSER_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

async function getBrowser() {
    // Reset idle timer every time browser is requested
    if (browserIdleTimer) {
        clearTimeout(browserIdleTimer);
        browserIdleTimer = null;
    }

    if (browserInstance) {
        try {
            await browserInstance.version();
        } catch {
            console.log('Browser crashed, restarting...');
            browserInstance = null;
        }
    }

    if (!browserInstance) {
        console.log('Launching new browser instance...');
        browserInstance = await puppeteer.launch({
            headless: "new",
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--no-first-run',
                '--no-default-browser-check'
            ],
            timeout: 30000
        });
        console.log('Browser instance launched.');
    }

    return browserInstance;
}

function scheduleIdleClose(isBusy) {
    if (typeof isBusy === "function") {
        browserBusyCheck = isBusy;
    }
    const busyCheck = browserBusyCheck;

    if (browserIdleTimer) {
        clearTimeout(browserIdleTimer);
    }

    browserIdleTimer = setTimeout(async () => {
        const isBusyNow = busyCheck();

        if (browserInstance && !isBusyNow) {
            console.log('Browser idle for 5 minutes with no queued jobs — closing to free memory.');
            try {
                await browserInstance.close();
                console.log('Browser closed. Memory should return to baseline.');
            } catch (err) {
                console.error('Error closing idle browser:', err.message);
            } finally {
                browserInstance = null;
                browserIdleTimer = null;
            }
        } else if (isBusyNow) {
            console.log('Idle timer fired but jobs still pending — rescheduling close.');
            scheduleIdleClose(busyCheck); // Reschedule if queue got new jobs
        }
    }, BROWSER_IDLE_TIMEOUT_MS);
}

process.on('SIGTERM', async () => {
    console.error('Process received signal: SIGTERM');
    if (browserIdleTimer) {
        clearTimeout(browserIdleTimer);
    }
    if (browserInstance) {
        await browserInstance.close();
    }
    process.exit(0);
});

process.on('SIGINT', () => {
    console.error('Process received signal: SIGINT');
    process.exit(0);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err.message, err.stack);
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Rejection:', reason);
});

const registerPatrollingReportPdfExtension =
    require('./extensions/patrolling-report-pdf-extension');

registerPatrollingReportPdfExtension({
    app,
    getBrowser,
    scheduleIdleClose,
    publicBaseUrl: PUBLIC_BASE_URL,
    internalAuthToken: INTERNAL_AUTH_TOKEN,
    reportPdfAuthToken: REPORT_PDF_AUTH_TOKEN,
    airtableApiKey: AIRTABLE_API_KEY,
    airtableBaseId: AIRTABLE_BASE_ID,
});

const registerWeeklyReportPdfExtension =
    require('./extensions/weekly-report-pdf-extension');

registerWeeklyReportPdfExtension({
    app,
    getBrowser,
    scheduleIdleClose,
    publicBaseUrl: PUBLIC_BASE_URL,
    reportPdfAuthToken: REPORT_PDF_AUTH_TOKEN,
    airtableApiKey: AIRTABLE_API_KEY,
    airtableBaseId: AIRTABLE_BASE_ID,
});

// ADD — Monthly KPI PDF
const registerMonthlyReportPdfExtension =
    require('./extensions/monthly-report-pdf-extension');

registerMonthlyReportPdfExtension({
    app,
    getBrowser,
    scheduleIdleClose,
    publicBaseUrl: PUBLIC_BASE_URL,
    reportPdfAuthToken: REPORT_PDF_AUTH_TOKEN,
    airtableApiKey: AIRTABLE_API_KEY,
    airtableBaseId: AIRTABLE_BASE_ID,
});

const registerSiteAssessmentPdfExtension =
    require('./extensions/site-assessment-pdf-extension');

registerSiteAssessmentPdfExtension({
    app,
    getBrowser,
    scheduleIdleClose,
    publicBaseUrl: PUBLIC_BASE_URL,
    reportPdfAuthToken: REPORT_PDF_AUTH_TOKEN,
    airtableApiKey: AIRTABLE_API_KEY,
    airtableBaseId: AIRTABLE_BASE_ID,
});

const registerBriefingNotePdfExtension =
    require('./extensions/briefing-note-pdf-extension');

registerBriefingNotePdfExtension({
    app,
    getBrowser,
    scheduleIdleClose,
    publicBaseUrl: PUBLIC_BASE_URL,
    reportPdfAuthToken: REPORT_PDF_AUTH_TOKEN,
    airtableApiKey: AIRTABLE_API_KEY,
    airtableBaseId: AIRTABLE_BASE_ID,
});

const registerIncidentReportPdfExtension =
    require('./extensions/incident-report-pdf-extension');

registerIncidentReportPdfExtension({
    app,
    getBrowser,
    scheduleIdleClose,
    publicBaseUrl: PUBLIC_BASE_URL,
    reportPdfAuthToken: REPORT_PDF_AUTH_TOKEN,
    airtableApiKey: AIRTABLE_API_KEY,
    airtableBaseId: AIRTABLE_BASE_ID,
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
    console.log(`Public base URL: ${PUBLIC_BASE_URL}`);
});
