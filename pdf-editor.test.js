const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, 'pdf-editor.js'), 'utf8');
const context = { window: {} };
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
