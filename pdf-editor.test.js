const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, 'pdf-editor.js'), 'utf8');
const context = { window: {}, TextDecoder };
vm.createContext(context);
vm.runInContext(source, context);
const tools = context.window.DailyPdfTools;

test('export limits use decimal units and reject invalid sizes', () => {
    assert.equal(tools.exportSize('', 'KB'), null);
    assert.equal(tools.exportSize('80', 'KB'), 80000);
    assert.equal(tools.exportSize('.5', 'MB'), 500000);
    for (const value of [0, 127, -1, 'bad', 100000001, 128.5]) assert.throws(() => tools.exportSize(value, 'bytes'), /size limit/);
});

test('PDF compression preserves vector output when it already fits', async () => {
    const bytes = new Uint8Array(1000);
    const result = await tools.compressPdf(bytes, 1500, null, () => { throw new Error('Must not rasterize'); });
    assert.equal(result.bytes, bytes);
    assert.equal(result.rasterized, false);
});

test('PDF compression searches quality and verifies the complete PDF size', async () => {
    const result = await tools.compressPdf(new Uint8Array(20000), 8500, null,
        async (bytes, scale, quality) => new Uint8Array(Math.ceil(quality * 10000)));
    assert.ok(result.bytes.length <= 8500);
    assert.ok(result.quality > .849);
    assert.equal(result.rasterized, true);
    assert.equal(result.dpi, 144);
});

test('PDF compression lowers resolution only if quality search cannot meet the limit', async () => {
    const result = await tools.compressPdf(new Uint8Array(20000), 2000, null,
        async (bytes, scale, quality) => new Uint8Array(Math.ceil(scale * scale * quality * 10000 + 100)));
    assert.ok(result.bytes.length <= 2000);
    assert.ok(result.dpi < 144);
});

test('impossible PDF limits fail rather than download oversized output', async () => {
    await assert.rejects(() => tools.compressPdf(new Uint8Array(1000), 128, null,
        async () => new Uint8Array(500)), /too small/);
});

test('PDF image export applies edits and exports selected pages with matching extensions', () => {
    assert.ok(source.includes('return exportPdf(undefined, true)'));
    assert.ok(source.includes('await exportPageImages(bytes, indices, target)'));
    assert.ok(source.includes("['jpeg', 'JPEG images']"));
    assert.ok(source.includes("['webp', 'WebP images']"));
    assert.ok(source.includes("compression: 'STORE'"));
    assert.ok(source.includes('(indices[number - 1] + 1)'));
    assert.ok(source.includes('ZIP overhead is additional'));
});

test('signature validity requires integrity, full coverage, trust and revocation', () => {
    const passed = { integrity: true, coversWholeFile: true, chainTrusted: true, revocationChecked: true };
    assert.equal(tools.signatureOutcome(passed).status, 'valid');
    assert.equal(tools.signatureOutcome({ ...passed, integrity: false }).status, 'invalid');
    assert.equal(tools.signatureOutcome({ ...passed, coversWholeFile: false }).status, 'modified');
    assert.equal(tools.signatureOutcome({ ...passed, chainTrusted: false, chainMessage: 'Missing root' }).status, 'unknown');
    assert.equal(tools.signatureOutcome({ ...passed, revocationChecked: false, revocationMessage: 'Missing CRL' }).status, 'unknown');
    assert.equal(tools.signatureOutcome({ ...passed, certificateValidAtSigning: false }).status, 'invalid');
    assert.equal(tools.signatureOutcome({ ...passed, revoked: true }).status, 'invalid');
});

function fakePki(results) {
    const calls = [];
    class Certificate {}
    class CertificateChainValidationEngine {
        constructor(options) { this.options = options; }
        async verify(options) {
            calls.push({ engine: this.options, options });
            return results.shift();
        }
    }
    return { pki: { Certificate, CertificateChainValidationEngine }, calls, certificate: new Certificate() };
}

test('signature trust never auto-trusts an embedded signer', async () => {
    const { pki, certificate, calls } = fakePki([]);
    const result = await tools.verifyCertificateTrust(pki, { certificates: [certificate] }, certificate, { certificates: [], crls: [] });
    assert.equal(result.chainTrusted, false);
    assert.equal(result.revocationChecked, false);
    assert.equal(calls.length, 0);
});

test('a trusted certificate chain with no CRLs leaves revocation unknown', async () => {
    const { pki, certificate, calls } = fakePki([{ result: true, certificatePath: [{}, {}] }]);
    const root = new pki.Certificate();
    const result = await tools.verifyCertificateTrust(pki, { certificates: [certificate, root] }, certificate,
        { certificates: [{ value: root }], crls: [] });
    assert.equal(result.chainTrusted, true);
    assert.equal(result.revocationChecked, false);
    assert.equal(calls[0].engine.certs.at(-1), certificate);
    assert.equal(calls[0].engine.trustedCerts[0], root);
    assert.equal(calls[0].options.passedWhenNotRevValues, true);
    assert.ok(Math.abs(calls[0].engine.checkDate.getTime() - Date.now()) < 1000);
});

test('directly trusting a signer cannot bypass revocation', async () => {
    const { pki, certificate, calls } = fakePki([{ result: true, certificatePath: [{}] }]);
    const result = await tools.verifyCertificateTrust(pki, { certificates: [certificate] }, certificate,
        { certificates: [{ value: certificate }], crls: [{ value: {} }] });
    assert.equal(result.chainTrusted, true);
    assert.equal(result.revocationChecked, false);
    assert.equal(calls.length, 1);
});

test('stale, future, undated and partial CRLs cannot produce valid signatures', async () => {
    const now = Date.now();
    const crls = [
        { thisUpdate: { value: new Date(now - 2000) }, nextUpdate: { value: new Date(now - 1000) } },
        { thisUpdate: { value: new Date(now + 1000) }, nextUpdate: { value: new Date(now + 2000) } },
        { thisUpdate: { value: new Date(now - 2000) } },
        { thisUpdate: { value: new Date(now - 1000) }, nextUpdate: { value: new Date(now + 2000) },
            crlExtensions: { extensions: [{ extnID: '2.5.29.27' }] } }
    ];
    const { pki, certificate, calls } = fakePki([{ result: true, certificatePath: [{}, {}] }]);
    const result = await tools.verifyCertificateTrust(pki, { certificates: [certificate] }, certificate,
        { certificates: [{ value: new pki.Certificate() }], crls: crls.map(value => ({ value })) });
    assert.equal(result.revocationChecked, false);
    assert.equal(calls.length, 1);
});

test('current CRLs require strict verification, and revocation failures remain explicit', async () => {
    const name = { typesAndValues: [] };
    for (const revoked of [false, true]) {
        const { pki, certificate, calls } = fakePki([
            { result: true, certificatePath: [{ subject: name }, { subject: name }] },
            { result: !revoked, resultCode: revoked ? 12 : 0, resultMessage: revoked ? 'Revoked' : '' }
        ]);
        const result = await tools.verifyCertificateTrust(pki, { certificates: [certificate] }, certificate,
            { certificates: [{ value: new pki.Certificate() }], crls: [{ value: {
                thisUpdate: { value: new Date(Date.now() - 1000) }, nextUpdate: { value: new Date(Date.now() + 60000) }
            } }] });
        assert.equal(result.revocationChecked, !revoked);
        assert.equal(result.revoked, revoked);
        assert.equal(calls[1].options.passedWhenNotRevValues, false);
        assert.equal(calls[1].engine.crls.length, 1);
    }
});

test('malformed signature byte ranges fail before loading cryptographic libraries', async () => {
    context.PDFLib = { PDFName: { of: value => value }, PDFDict: class {}, PDFArray: class {} };
    for (const range of [[0, 2.5, 6, 2], [0, 2, 6, -1], [0, 2, Infinity, 2], [0, 2, 6, 99]]) {
        const dictionary = {
            lookup: key => key === 'Contents' ? { asBytes: () => new Uint8Array([0x30]) } : undefined,
            lookupMaybe: () => ({ asArray: () => range.map(value => ({ asNumber: () => value })) })
        };
        const result = await tools.verifySignature(new Uint8Array([0, 0, 60, 51, 48, 62, 0, 0]),
            { name: 'Signature', field: { acroField: { dict: { lookupMaybe: () => dictionary } } } });
        assert.equal(result.status, 'invalid');
    }
});

test('the unsigned gap must contain exactly the signature contents', async () => {
    context.PDFLib = { PDFName: { of: value => value }, PDFDict: class {}, PDFArray: class {} };
    const dictionary = {
        lookup: key => key === 'Contents' ? { asBytes: () => new Uint8Array([0x31]) } : undefined,
        lookupMaybe: () => ({ asArray: () => [0, 2, 6, 2].map(value => ({ asNumber: () => value })) })
    };
    const result = await tools.verifySignature(new Uint8Array([0, 0, 60, 51, 48, 62, 0, 0]),
        { name: 'Signature', field: { acroField: { dict: { lookupMaybe: () => dictionary } } } });
    assert.equal(result.status, 'invalid');
    assert.match(result.message, /exactly this signature contents/);
});

test('unlock worker receives a copy and always terminates after completion or error', async () => {
    for (const fail of [false, true]) {
        let worker, timeoutCleared = false;
        class Worker {
            constructor(url, options) { worker = this; assert.equal(options.type, 'module'); }
            postMessage(data) {
                assert.notEqual(data.bytes, bytes);
                assert.equal(data.password, 'test-only');
                queueMicrotask(() => this.onmessage({ data: fail ? { error: 'Incorrect PDF password.' } : { bytes: data.bytes, warnings: [] } }));
            }
            terminate() { this.terminated = true; }
        }
        const local = { window: { location: { href: 'http://localhost/index.html' } }, Worker, URL,
            setTimeout: () => 1, clearTimeout: () => { timeoutCleared = true; } };
        vm.createContext(local); vm.runInContext(source, local);
        const bytes = new Uint8Array([1, 2, 3]);
        if (fail) await assert.rejects(() => local.window.DailyPdfTools.unlockPdf(bytes, 'test-only'), /Incorrect PDF password/);
        else assert.deepEqual(Array.from((await local.window.DailyPdfTools.unlockPdf(bytes, 'test-only')).bytes), [1, 2, 3]);
        assert.equal(worker.terminated, true);
        assert.equal(timeoutCleared, true);
    }
});

test('unlocking through file URLs fails with web-server guidance before creating a worker', async () => {
    const local = { window: { location: { href: 'file:///C:/Daily/index.html' } }, URL };
    vm.createContext(local); vm.runInContext(source, local);
    await assert.rejects(() => local.window.DailyPdfTools.unlockPdf(new Uint8Array([1]), ''), /HTTP\(S\) web server/);
});
