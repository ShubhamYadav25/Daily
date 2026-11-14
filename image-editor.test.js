const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const context = { window: {}, Uint8Array, Uint8ClampedArray, DataView, Blob };
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'image-editor.js'), 'utf8'), context);
const tools = context.window.DailyImageTools;
const plain = value => JSON.parse(JSON.stringify(value));

test('dimensions reject invalid and unsafe allocations', () => {
    for (const pair of [[0, 1], [-1, 20], [1.5, 30], [NaN, 2], [Infinity, 2], [20000, 1]]) {
        assert.throws(() => tools.dimensions(...pair), /dimensions/);
    }
    assert.deepEqual(plain(tools.dimensions(4000, 3000)), { width: 4000, height: 3000 });
});

test('fit placement preserves aspect ratio unless stretch is explicitly chosen', () => {
    assert.deepEqual(plain(tools.placement(400, 200, 100, 100, 'contain')), { x: 0, y: 25, width: 100, height: 50 });
    assert.deepEqual(plain(tools.placement(400, 200, 100, 100, 'cover')), { x: -50, y: 0, width: 200, height: 100 });
    assert.deepEqual(plain(tools.placement(400, 200, 100, 100, 'stretch')), { x: 0, y: 0, width: 100, height: 100 });
});

test('crop stays inside image and passport/aspect presets yield centered rectangles', () => {
    assert.deepEqual(plain(tools.cropBounds({ x: -3, y: 95, width: 200, height: 100 }, 100, 100)),
        { x: 0, y: 95, width: 100, height: 5 });
    assert.deepEqual(plain(tools.aspectCrop(400, 200, 1)), { x: 100, y: 0, width: 200, height: 200 });
    const crop = tools.aspectCrop(1000, 1000, 35 / 45);
    assert.equal(crop.height, 1000);
    assert.ok(Math.abs(crop.width / crop.height - 35 / 45) < .001);
});

test('rotation preserves full bounds without adding a pixel at right angles', () => {
    const right = tools.rotationSize(800, 600, 90);
    assert.equal(right.width, 600); assert.equal(right.height, 800);
    const diagonal = tools.rotationSize(800, 600, 45);
    assert.equal(diagonal.width, 990); assert.equal(diagonal.height, 990);
    assert.deepEqual(plain(tools.rotationSize(800, 600, 450)), plain(right));
    assert.throws(() => tools.rotationSize(800, 600, Infinity), /finite/);
});

function pngChunk(tag, data) {
    const chunk = new Uint8Array(data.length + 12);
    new DataView(chunk.buffer).setUint32(0, data.length);
    chunk.set(Buffer.from(tag), 4); chunk.set(data, 8);
    new DataView(chunk.buffer).setUint32(chunk.length - 4, tools.crc32(chunk.subarray(4, chunk.length - 4)));
    return chunk;
}

test('PNG density follows IHDR, has a valid CRC and replaces existing density', () => {
    const source = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        pngChunk('IHDR', new Uint8Array(13)), pngChunk('IDAT', new Uint8Array(4)), pngChunk('IEND', new Uint8Array(0))]);
    let result = tools.densityBytes(new Uint8Array(source), 'image/png', 300);
    assert.equal(Buffer.from(result.subarray(12, 16)).toString(), 'IHDR');
    assert.equal(Buffer.from(result.subarray(37, 41)).toString(), 'pHYs');
    assert.equal(new DataView(result.buffer).getUint32(41), 11811);
    assert.equal(new DataView(result.buffer).getUint32(50), tools.crc32(result.subarray(37, 50)));
    result = tools.densityBytes(result, 'image/png', 72);
    assert.equal(result.length, source.length + 21);
    assert.equal(new DataView(result.buffer).getUint32(41), 2835);
});

test('JPEG density uses inches and replaces original JFIF, EXIF and comment segments', () => {
    const source = new Uint8Array([255, 216, 255, 224, 0, 4, 1, 2, 255, 225, 0, 4, 3, 4,
        255, 254, 0, 4, 5, 6, 255, 219, 0, 4, 7, 8, 255, 218, 0, 2, 9, 10, 255, 217]);
    const result = tools.densityBytes(source, 'image/jpeg', 300);
    assert.equal(result[13], 1);
    assert.equal(result[14] << 8 | result[15], 300);
    assert.equal(result[16] << 8 | result[17], 300);
    assert.deepEqual([...result.subarray(20)], [255, 219, 0, 4, 7, 8, 255, 218, 0, 2, 9, 10, 255, 217]);
    assert.equal(tools.densityBytes(result, 'image/jpeg', 72).length, result.length);
});

test('WebP density creates VP8X and minimal EXIF with correct RIFF size', () => {
    const source = new Uint8Array(26), view = new DataView(source.buffer);
    source.set(Buffer.from('RIFF')); view.setUint32(4, 18, true); source.set(Buffer.from('WEBPVP8L'), 8);
    view.setUint32(16, 5, true); source[20] = 47;
    view.setUint32(21, 9 | (19 << 14) | 0x10000000, true);
    const result = tools.densityBytes(source, 'image/webp', 300), reader = new DataView(result.buffer);
    assert.equal(Buffer.from(result.subarray(12, 16)).toString(), 'VP8X');
    assert.equal(result[20], 24);
    assert.equal(result[24], 9); assert.equal(result[27], 19);
    assert.equal(reader.getUint32(4, true), result.length - 8);
    assert.equal(Buffer.from(result.subarray(44, 48)).toString(), 'EXIF');
    assert.equal(reader.getUint32(102, true), 300);
    assert.equal(reader.getUint32(110, true), 300);
    const second = tools.densityBytes(result, 'image/webp', 72);
    assert.equal(second.length, result.length);
    assert.equal(new DataView(second.buffer).getUint32(102, true), 72);
});

test('DPI validation rejects invalid density rather than silently defaulting', () => {
    for (const dpi of [0, -1, 1.5, NaN, 2401]) assert.throws(() => tools.densityBytes(new Uint8Array(), 'image/png', dpi), /DPI/);
});

test('compression searches quality and verifies final size including metadata', async () => {
    const calls = [];
    const encode = async (canvas, type, quality, dpi) => {
        calls.push({ quality, dpi });
        return { size: Math.ceil(1000 * quality + 100) };
    };
    const result = await tools.compress({ width: 400, height: 200 }, 'image/jpeg', 950, 300, .75, false, null, encode);
    assert.ok(result.blob.size <= 950);
    assert.ok(result.quality >= .849 && result.quality <= .85);
    assert.equal(result.width, 400); assert.equal(result.height, 200);
    assert.ok(calls.every(call => call.dpi === 300));
});

test('compression preserves highest quality when it already meets target', async () => {
    const result = await tools.compress({ width: 20, height: 10 }, 'image/webp', 500, 72, .75, false, null, async () => ({ size: 200 }));
    assert.equal(result.quality, 1);
    assert.equal(result.blob.size, 200);
});

test('compression does not resize or silently exceed the threshold without permission', async () => {
    let resized = false;
    await assert.rejects(() => tools.compress({ width: 400, height: 200 }, 'image/jpeg', 500, 300, .75, false, null,
        async () => ({ size: 1000 }), async () => { resized = true; }), /Cannot meet/);
    assert.equal(resized, false);
});

test('PNG compression reduces dimensions only with permission and stays lossless', async () => {
    const qualities = [], sizes = [];
    const result = await tools.compress({ width: 400, height: 200 }, 'image/png', 2000, 300, .75, true, null,
        async (canvas, type, quality) => { qualities.push(quality); return { size: canvas.width * canvas.height + 100 }; },
        async (canvas, width, height) => { sizes.push({ width, height }); return { width, height }; });
    assert.ok(result.blob.size <= 2000);
    assert.ok(result.width < 400); assert.ok(result.height < 200);
    assert.ok(qualities.every(quality => quality === 1));
    assert.ok(sizes.length > 0);
});

test('impossible and invalid limits fail explicitly', async () => {
    for (const limit of [0, 127, NaN, 100000001, 250.5]) {
        await assert.rejects(() => tools.compress({ width: 1, height: 1 }, 'image/png', limit, 300, .75, false), /size limit/);
    }
    await assert.rejects(() => tools.compress({ width: 1, height: 1 }, 'image/png', 128, 300, .75, true, null,
        async () => ({ size: 200 })), /Cannot meet/);
});

test('enhancer preserves alpha and does not alter constant images', () => {
    const data = { width: 3, height: 3, data: new Uint8ClampedArray(36) };
    for (let index = 0; index < 9; index++) data.data.set([100, 120, 140, index * 20], index * 4);
    const original = new Uint8ClampedArray(data.data);
    tools.enhancePixels(data, 100);
    assert.deepEqual(data.data, original);
    data.data[16] = 200;
    tools.enhancePixels(data, 50);
    assert.equal(data.data[16], 250);
    assert.equal(data.data[19], original[19]);
});

test('image tool is wired to menu, header, shortcut, tour and close handling', () => {
    const source = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    for (const expected of ['src="./image-editor.js"', 'href="./image-editor.css"', "id: 'image', key: 'z'",
        'const [showImage, setShowImage]', '|| showImage ||', 'setShowImage(false);',
        'image: () => setShowImage(true)', 'label="Image Editor"', 'label: \'Image Editor\', action:',
        '{showImage && <window.DailyImageEditor']) assert.ok(source.includes(expected), expected);
});

test('floating panel keeps canvas children mounted across responsive layouts', () => {
    const source = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    const start = source.indexOf('function FloatingPanel(');
    const panel = source.slice(start, source.indexOf('\n        function ', start + 1));
    assert.equal((panel.match(/key="content" className="fp-content"/g) || []).length, 2);
    assert.equal((panel.match(/key="header" className="fp-hdr"/g) || []).length, 2);
});

test('numeric controls step by exactly one and respect their bounds', () => {
    assert.equal(tools.stepValue('800', 1, 1, 16384), 801);
    assert.equal(tools.stepValue('801', -1, 1, 16384), 800);
    assert.equal(tools.stepValue(1, -1, 1, 16384), 1);
    assert.equal(tools.stepValue(16384, 1, 1, 16384), 16384);
    assert.equal(tools.stepValue('', 1, 0, 100), 1);
    assert.equal(tools.stepValue(-90, 1), -89);
});

test('OCR converts recognized lines to bounded editable text targets', () => {
    const targets = tools.ocrTargets([
        { text: ' HELLO DAILY\n', bbox: { x0: 100, y0: 130, x1: 430, y1: 170 } },
        { text: '   ', bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } },
        { text: 'Missing bounds' },
        { text: 'EDGE', bbox: { x0: -3, y0: 390, x1: 500, y1: 430 } }
    ], 800, 400);
    assert.equal(targets.length, 2);
    assert.deepEqual(plain(targets[0]), { id: 'text-0', text: 'HELLO DAILY', x: 100, y: 130, width: 330, height: 40 });
    assert.equal(targets[1].x, 0);
    assert.equal(targets[1].height, 10);
    assert.equal(tools.ocrTargets(undefined, 800, 400).length, 0);
});

test('compact image UI has one command row, explicit steppers and no Apply adjustments', () => {
    const editor = fs.readFileSync(path.join(__dirname, 'image-editor.js'), 'utf8');
    assert.ok(editor.includes("className: 'image-commandbar'"));
    assert.ok(!editor.includes('image-topbar'));
    assert.ok(!editor.includes('Apply adjustments'));
    assert.ok(!editor.includes('help('));
    assert.ok(editor.includes("title: label, 'aria-label': label"));
    assert.ok(editor.includes("step: 1"));
    assert.ok(editor.includes('previewPending.current = true; commit()'));
    assert.ok(editor.includes('requestAnimationFrame'));
    assert.ok(editor.includes('flushPreview(); await action()'));
    assert.ok(editor.includes("className: 'image-actions image-annotation-tools'"));
    assert.ok(!editor.includes('Drop images or a PDF'));
});

test('source text editing retains OCR masks and targets across undo snapshots', () => {
    const editor = fs.readFileSync(path.join(__dirname, 'image-editor.js'), 'utf8');
    assert.ok(editor.includes("object.toObject(['replacementMask', 'replacementTarget', 'name', 'selectable', 'evented'])"));
    assert.ok(editor.includes('targets: value.targets'));
    assert.ok(editor.includes('value.targets = state.targets || []'));
    assert.ok(editor.includes('text.enterEditing(); text.selectAll()'));
    assert.ok(editor.includes('mask.name === object.replacementMask'));
    assert.ok(editor.includes('replacementMask: undefined, replacementTarget: undefined'));
});

function shortcut(key, options = {}) {
    return { key, ctrlKey: true, metaKey: false, target: { closest: () => null, hasAttribute: () => false }, ...options };
}

test('keyboard undo works from canvas pointer focus and Fabric hidden text input', () => {
    assert.equal(tools.imageShortcut(shortcut('z'), false, true, false), 'undo');
    assert.equal(tools.imageShortcut(shortcut('Z', { shiftKey: true }), true, true, false), 'redo');
    assert.equal(tools.imageShortcut(shortcut('y'), true, true, false), 'redo');
    assert.equal(tools.imageShortcut(shortcut('z', { target: { closest: () => ({}), hasAttribute: () => true } }), false, true, true), 'undo');
    assert.equal(tools.imageShortcut(shortcut('z', { target: { closest: () => ({}), hasAttribute: () => false } }), true, true, false), null);
    assert.equal(tools.imageShortcut(shortcut('z'), false, false, false), null);
    assert.equal(tools.imageShortcut(shortcut('z', { defaultPrevented: true }), true, true, false), null);
});

test('font style shortcuts match PDF editor and typing does not delete layers', () => {
    for (const [key, action] of [['b', 'bold'], ['i', 'italic'], ['u', 'underline'], ['a', 'selectText']]) {
        assert.equal(tools.imageShortcut(shortcut(key), true, true, true), action);
    }
    assert.equal(tools.imageShortcut(shortcut('Delete', { ctrlKey: false }), true, true, false), 'delete');
    assert.equal(tools.imageShortcut(shortcut('Backspace', { ctrlKey: false }), true, true, true), null);
});

test('lossless export cannot silently resample or quantize', () => {
    const source = fs.readFileSync(path.join(__dirname, 'image-editor.js'), 'utf8');
    assert.ok(source.includes('window.UPNG.encode([pixels.buffer], canvas.width, canvas.height, 0)'));
    assert.ok(source.includes('channel === pixels[index]'));
    assert.ok(source.includes('decoded.length !== pixels.length'));
    assert.ok(source.includes("'Lossless output is '"));
    assert.ok(source.includes('(type !== MIME.png || !settings.lossless) && settings.allowResize'));
    assert.ok(source.includes('const type = MIME[settings.format]'));
    assert.ok(source.includes('window.DailyPdfTools.FONT_CHOICES'));
    assert.ok(source.includes('blurRegion: value.blurRegion'));
});

test('text history restores layer selection rather than Fabric temporary editing flags', () => {
    const object = {
        isEditing: true, _savedProps: { selectable: true },
        toObject: () => ({ text: 'Updated', selectable: false, evented: true, replacementMask: 'mask' })
    };
    assert.deepEqual(plain(tools.layerSnapshot(object)),
        { text: 'Updated', selectable: true, evented: true, replacementMask: 'mask' });
    object.isEditing = false;
    assert.equal(tools.layerSnapshot(object).selectable, false);
    object.isEditing = true;
    object._savedProps.selectable = false;
    assert.equal(tools.layerSnapshot(object).selectable, false);
});

test('fractional steppers do not accumulate floating point noise', () => {
    assert.equal(tools.stepValue(1.2, .01, .5, 5), 1.21);
    assert.equal(tools.stepValue(1.21, -.01, .5, 5), 1.2);
});

test('automatic compression preserves PNG pixels when the target already fits', async () => {
    const result = await tools.autoCompress({ width: 400, height: 200 }, 150000, 300, null,
        async () => ({ size: 149002 }), null, null, true);
    assert.equal(result.type, 'image/png');
    assert.equal(result.width, 400);
    assert.equal(result.blob.size, 149002);
});

test('automatic compression compares formats before reducing dimensions', async () => {
    const result = await tools.autoCompress({ width: 400, height: 200 }, 80000, 300, null,
        async (canvas, type, quality) => ({ size: type === 'image/png' ? 149002 : Math.ceil(85000 * quality), type }),
        () => { throw new Error('Must preserve dimensions'); },
        async (canvas, blob) => blob.type === 'image/webp' ? 2 : 8, true);
    assert.equal(result.type, 'image/webp');
    assert.equal(result.width, 400);
    assert.ok(result.blob.size <= 80000);
    assert.ok(result.quality > .94);
});

test('automatic compression keeps transparency and resizes from the original only if needed', async () => {
    const source = { width: 400, height: 200 }, types = [];
    const result = await tools.autoCompress(source, 5000, 72, null,
        async (canvas, type, quality) => {
            types.push(type);
            return { size: Math.ceil(canvas.width * canvas.height * (type === 'image/png' ? 2 : quality) + 100), type };
        }, async (canvas, width, height) => {
            assert.equal(canvas, source);
            return { width, height };
        }, async () => 1, false);
    assert.ok(result.blob.size <= 5000);
    assert.ok(result.width < 400);
    assert.ok(result.width >= 112, 'refines dimensions instead of accepting the first small output');
    assert.ok(!types.includes('image/jpeg'));
});

test('automatic compression rejects invalid limits and encoder failures explicitly', async () => {
    await assert.rejects(() => tools.autoCompress({}, 127, 300, null, null, null, null, true), /size limit/);
    await assert.rejects(() => tools.autoCompress({ width: 1, height: 1 }, 128, 300, null,
        async () => ({ size: 300 }), null, null, true), /too small/);
    await assert.rejects(() => tools.autoCompress({}, 5000, 300, null,
        async () => { throw new Error('Encoder unavailable'); }, null, null, true), /Encoder unavailable/);
});

test('blur preserves uniform colors and alpha including image edges', () => {
    const image = { width: 20, height: 12, data: new Uint8ClampedArray(20 * 12 * 4) };
    for (let i = 0; i < image.data.length; i += 4) image.data.set([36, 103, 189, 180], i);
    const before = new Uint8ClampedArray(image.data);
    tools.blurPixels(image, 8, null);
    assert.deepEqual(image.data, before);
});

test('region blur changes inside colors only, preserving all original opacity', () => {
    const image = { width: 24, height: 16, data: new Uint8ClampedArray(24 * 16 * 4) };
    for (let y = 0; y < 16; y++) for (let x = 0; x < 24; x++) image.data.set([x % 2 ? 0 : 255, y % 2 ? 0 : 255, 80, (x + y) % 2 ? 120 : 255], (y * 24 + x) * 4);
    const before = new Uint8ClampedArray(image.data), region = { x: 5, y: 3, width: 8, height: 7 };
    tools.blurPixels(image, 3, region);
    let changed = 0;
    for (let y = 0; y < 16; y++) for (let x = 0; x < 24; x++) for (let c = 0; c < 4; c++) {
        const i = (y * 24 + x) * 4 + c;
        if (c === 3 || x < 5 || x >= 13 || y < 3 || y >= 10) assert.equal(image.data[i], before[i]);
        else if (image.data[i] !== before[i]) changed++;
    }
    assert.ok(changed > 0);
});

test('size optimization respects the selected format rather than switching codecs', async () => {
    for (const selectedType of ['image/png', 'image/jpeg', 'image/webp']) {
        const types = [];
        const result = await tools.autoCompress({ width: 100, height: 100 }, 1500, 300, null,
            async (canvas, type) => { types.push(type); return { size: canvas.width * canvas.height + 100 }; },
            async (source, width, height) => ({ width, height }), async () => 0, true, selectedType);
        assert.equal(result.type, selectedType);
        assert.ok(result.blob.size <= 1500);
        assert.ok(types.every(type => type === selectedType));
    }
});

test('font confidence rejects poor matches and short ambiguous words', () => {
    const ink = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]);
    assert.equal(tools.fontMatchConfidence(ink, ink), 1);
    assert.equal(tools.fontMatchConfidence(ink, new Uint8ClampedArray(8).fill(255)), 0);
    assert.equal(tools.reliableFontMatch({ confidence: .9 }, 'HELLO'), true);
    assert.equal(tools.reliableFontMatch({ confidence: .7 }, 'HELLO'), false);
    assert.equal(tools.reliableFontMatch({ confidence: 1 }, 'I'), false);
});

test('OCR font workflow asks for confirmation before altering uncertain source text', () => {
    const source = fs.readFileSync(path.join(__dirname, 'image-editor.js'), 'utf8');
    assert.ok(source.includes('await loadOpenFonts()'));
    assert.ok(source.includes('if (!reliableFontMatch(matched, target.text))'));
    assert.ok(source.includes('Confirm font & edit'));
    assert.ok(source.includes('Recognize selected text'));
    assert.ok(source.includes('x: target.x + rect.x, y: target.y + rect.y'));
    assert.ok(source.includes("const extension = settings.format;"));
});
