const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

for (const reportType of ['Weekly', 'Monthly']) {
test(`the ${reportType} attachment URL serves the generated PDF through the server public route`, async () => {
    const projectRoot = path.resolve(__dirname, '..');
    const app = express();
    app.use('/public', express.static(path.join(projectRoot, 'public')));
    const server = await new Promise(resolve => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    const publicBaseUrl = `http://127.0.0.1:${server.address().port}`;
    const pdfBytes = Buffer.from(`%PDF-1.4\nMock ${reportType} report\n%%EOF`);
    const periodStart = reportType === 'Weekly' ? '2026-10-21' : '2026-09-30';
    const originalFetch = global.fetch;
    const originalSetTimeout = global.setTimeout;
    let attachment;
    let handler;
    global.setTimeout = (...args) => {
        const timer = originalSetTimeout(...args);
        timer.unref();
        return timer;
    };
    global.fetch = async (url, options) => {
        if (!String(url).startsWith('https://api.airtable.com/')) return originalFetch(url, options);
        if (options.method === 'GET') {
            return new Response(JSON.stringify({id:'rec-target', fields:{
                Type:reportType, 'Start Period':periodStart, 'End Period':'2026-10-27', 'PDF attachment':[],
            }}));
        }
        const request = JSON.parse(options.body);
        assert.match(String(url), /\/tbl02SSiR3rfuUPtQ$/);
        const fields = request.records[0].fields;
        attachment = (fields['PDF attachment'] || fields.fldCOfkMDOsyDRCgE)[0];
        return new Response(JSON.stringify({records:[{fields:{'PDF attachment':[attachment]}}]}));
    };
    try {
        require(`../extensions/${reportType.toLowerCase()}-report-pdf-extension`)({
            app:{post(_route, callback) {handler=callback;}},
            publicBaseUrl, reportPdfAuthToken:'test-token', airtableApiKey:'test-key', airtableBaseId:'test-base',
            getBrowser:async () => ({newPage:async () => ({
                async setViewport() {}, async emulateMediaType() {}, async setContent() {},
                async addStyleTag() {}, async evaluate() {}, async pdf() {return pdfBytes;}, async close() {},
            })}),
        });
        let status;
        let result;
        const response = {status(value) {status=value;return this;},json(value) {result=value;return this;}};
        await handler({headers:{'x-auth-token':'test-token'},body:{
            htmlContent:`<html>${reportType} report</html>`,recordId:'rec-target',periodStart,periodEnd:'2026-10-27',
        }},response);
        assert.equal(status,200,JSON.stringify(result));
        const download = await originalFetch(attachment.url);
        assert.equal(download.status,200,`Worker returned SUCCESS but Airtable's PDF download returns ${download.status}`);
        assert.deepEqual(Buffer.from(await download.arrayBuffer()),pdfBytes);
        assert.match(download.headers.get('content-type'),/application\/pdf/);
    } finally {
        global.fetch = originalFetch;
        global.setTimeout = originalSetTimeout;
        await new Promise(resolve => server.close(resolve));
        if (attachment) {
            const filename = path.basename(new URL(attachment.url).pathname);
            for (const folder of ['public','extensions/public']) {
                const target = path.join(projectRoot,folder,filename);
                if (fs.existsSync(target)) fs.unlinkSync(target);
            }
        }
    }
});
}
