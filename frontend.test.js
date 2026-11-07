const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function jsonHarness(repair, json5) {
    const context = { window: { JSONRepair: repair ? { jsonrepair: repair } : undefined, JSON5: json5 } };
    vm.createContext(context);
    const start = source.indexOf('function normalizeJson(raw)');
    vm.runInContext(source.slice(start, source.indexOf('function JsonPanel', start)), context);
    const formatStart = source.indexOf('function formatJSON(el)');
    vm.runInContext(source.slice(formatStart, source.indexOf('function escH', formatStart)), context);
    return context;
}

test('JSON recovery decodes shipment escapes without changing field types or string contents', () => {
    const value = {
        costCenterCode: 'CDC-00066928', paperless: 'false', shipmentDate: '2026-11-02',
        waybills: [{ data: { declared: [{ weight: 9940, height: '30' }], services: {},
            receiver: { address: 'via bruno buozzi 44/46', note1: null,
                note2: 'Line one\nLine two', path: 'C:\\labels\\new', quote: 'Say "hello"' } } }]
    };
    const escaped = JSON.stringify(JSON.stringify(value)).slice(1, -1).replace('44/46', '44\\/46');
    const result = jsonHarness().normalizeJson(escaped);
    assert.equal(result.status, 'repaired');
    assert.equal(result.issues.length, 0);
    assert.deepEqual(JSON.parse(result.result), value);
});

test('JSON recovery handles repeated serialization and Markdown wrappers', () => {
    const value = { nested: [true, null, { text: 'hello' }] };
    const h = jsonHarness();
    let text = JSON.stringify(value);
    for (let layer = 0; layer < 5; layer++) {
        text = JSON.stringify(text);
        assert.deepEqual(JSON.parse(h.normalizeJson(text).result), value);
    }
    assert.deepEqual(JSON.parse(h.normalizeJson('```jsonc\n' + text + '\n```').result), value);
    const escaped = JSON.stringify(JSON.stringify(value)).slice(1, -1);
    assert.deepEqual(JSON.parse(h.normalizeJson(JSON.stringify(escaped)).result), value);
});

test('JSON recovery preserves valid JSON primitives and ordinary escaped strings', () => {
    const h = jsonHarness();
    for (const value of [null, true, false, 42, -1.5, 'hello', 'C:\\new\\labels', 'line\nnext', {}, []]) {
        const result = h.normalizeJson(JSON.stringify(value));
        assert.equal(result.status, 'valid');
        assert.deepEqual(JSON.parse(result.result), value);
    }
});

test('JSON recovery preserves JSON-looking strings unless they encode a complete container', () => {
    const h = jsonHarness();
    for (const value of ['{not JSON', '[unfinished', '"quoted"', '\\network\\share', '```json\nnot JSON\n```', '{"unfinished":']) {
        const result = h.normalizeJson(JSON.stringify(value));
        assert.equal(result.status, 'valid', value);
        assert.equal(JSON.parse(result.result), value);
        assert.equal(result.steps.length, 0);
    }
});

test('JSON recovery round-trips generated nested values and serialization variants', () => {
    const h = jsonHarness();
    const strings = ['', '{unfinished', '[unfinished', '"quoted"', '\\path', '\n\t\r', '44/46', '<script>', '雪', 'true'];
    for (let index = 0; index < 200; index++) {
        const value = { index, text: strings[index % strings.length], nested: [null, index % 2 === 0, index / 10,
            { text: strings[(index + 3) % strings.length], empty: {} }] };
        let text = JSON.stringify(value);
        for (let layer = 0; layer < 4; layer++) {
            const result = h.normalizeJson(text);
            assert.deepEqual(JSON.parse(result.result), value, 'case ' + index + ', layer ' + layer);
            assert.equal(result.issues.length, 0);
            text = JSON.stringify(text);
        }
        const escaped = JSON.stringify(JSON.stringify(value)).slice(1, -1);
        assert.deepEqual(JSON.parse(h.normalizeJson(escaped).result), value);
    }
});

test('JSON recovery attempts library repair for every root syntax, not just selected prefixes', () => {
    const cases = new Map([
        ['/* comment */ true', true], ['// comment\n42', 42], ['+2', 2], ['.5', 0.5],
        ['undefined', null], ['NaN', null], ['FALSE', false], ['/* comment */ {a:1}', { a: 1 }]
    ]);
    const h = jsonHarness(text => {
        if (!cases.has(text)) throw new Error('Unrecognized input');
        return JSON.stringify(cases.get(text));
    });
    for (const [text, expected] of cases) {
        const result = h.normalizeJson(text);
        assert.deepEqual(JSON.parse(result.result), expected, text);
    }
});

test('JSON recovery falls back to original input when output nesting exceeds serialization limits', () => {
    const raw = '['.repeat(8000) + '0' + ']'.repeat(8000);
    const result = jsonHarness().normalizeJson(raw);
    assert.equal(result.status, 'partial');
    assert.equal(result.original, raw);
    assert.equal(JSON.parse(result.result), raw);
});

test('JSON recovery supports a JSON5 parser and retains non-finite numbers as reported text', () => {
    const values = new Map([['+2', 2], ['.5', 0.5], ['0xff', 255], ['NaN', NaN], ['Infinity', Infinity],
        ['{value:NaN}', { value: NaN }]]);
    const h = jsonHarness(undefined, { parse: text => {
        if (!values.has(text)) throw new Error('Unrecognized JSON5');
        return values.get(text);
    } });
    for (const [text, expected] of values) {
        const result = h.normalizeJson(text);
        const nonFinite = text.includes('NaN') || text.includes('Infinity');
        assert.equal(result.status, nonFinite ? 'partial' : 'repaired', text);
        assert.deepEqual(JSON.parse(result.result), text === '{value:NaN}' ? { value: 'NaN' } : nonFinite ? text : expected);
        assert.deepEqual(JSON.parse(JSON.stringify(result.parsed)), JSON.parse(result.result));
        if (nonFinite) assert.equal(result.original, text);
    }
});

test('JSON recovery retains the source when validation detects data loss', () => {
    const h = jsonHarness();
    for (const [text, code] of [['{"a":1,"a":2}', 'W060'], ['{"id":9007199254740993}', 'W050']]) {
        h.window.JSONLint = { validate: () => ({ diagnostics: [
            { code, severity: 'warning', start: 0, message: 'Potential data loss' }
        ] }), lineColumn: () => ({ line: 1, column: 1 }) };
        const result = h.normalizeJson(text);
        assert.equal(result.status, 'partial');
        assert.equal(result.original, text);
        assert.equal(result.issues[0].raw, text);
    }
});

test('JSON recovery bounds serialization layers without discarding the remainder', () => {
    let text = '{"ok":true}';
    for (let layer = 0; layer < 17; layer++) text = JSON.stringify(text);
    const result = jsonHarness().normalizeJson(text);
    assert.equal(result.status, 'partial');
    assert.match(result.issues[0].reason, /Serialization limit/);
    assert.equal(result.original, text);
    assert.equal(JSON.parse(result.result), result.parsed);
});

test('JSON recovery retains unrecognized fragments and separates multiple documents', () => {
    const h = jsonHarness();
    const partial = h.normalizeJson('{"good":1, broken, "tail":true}');
    assert.equal(partial.status, 'partial');
    assert.deepEqual(JSON.parse(partial.result), { good: 1, tail: true });
    assert.ok(partial.issues.some(issue => issue.raw.includes('broken')));
    const documents = h.normalizeJson('log entry {"first":1}\n{"second":2} trailing');
    assert.equal(documents.status, 'partial');
    assert.deepEqual(JSON.parse(documents.result), [{ first: 1 }, { second: 2 }]);
    assert.equal(documents.original, 'log entry {"first":1}\n{"second":2} trailing');
});

test('JSON editor formatting uses recovery and includes a report for uncertain data', () => {
    const h = jsonHarness();
    const result = h.formatJSON({ value: String.raw`{\"ok\":true}`, selectionStart: 0, selectionEnd: 0 });
    assert.deepEqual(JSON.parse(result.result), { ok: true });
    assert.equal(result.full, true);
    const partial = h.formatJSON({ value: '{"good":1, broken}', selectionStart: 0, selectionEnd: 0 });
    const report = JSON.parse(partial.result);
    assert.equal(report.status, 'partial');
    assert.equal(report.original, '{"good":1, broken}');
    assert.ok(report.unparsed.length);
});

function barcodeHarness(decodeSingle) {
    const state = { busy: false, data: '', error: '', logs: [], toasts: [], timerCleared: false };
    let timeout;
    const context = {
        imgSrc: 'data:image/png;base64,test',
        Quagga: decodeSingle ? { decodeSingle } : undefined,
        setBusy: value => { state.busy = value; },
        setScannedData: value => { state.data = value; },
        setError: value => { state.error = value; },
        addToast: (...args) => state.toasts.push(args),
        console: { error: (...args) => state.logs.push(args) },
        setTimeout: callback => { timeout = callback; return 1; },
        clearTimeout: () => { state.timerCleared = true; },
    };
    const start = source.indexOf('async function scanBarcode()');
    vm.createContext(context);
    vm.runInContext(source.slice(start, source.indexOf('function copyText()', start)), context);
    return { state, scan: () => context.scanBarcode(), timeout: () => timeout() };
}

test('barcode scan uses valid Quagga 0.12.1 readers and returns the decoded value', async () => {
    const h = barcodeHarness((config, callback) => {
        assert.deepEqual(Array.from(config.decoder.readers), [
            'code_128_reader', 'ean_reader', 'ean_8_reader', 'upc_reader', 'upc_e_reader',
            'codabar_reader', 'code_39_reader', 'code_39_vin_reader', '2of5_reader',
            'i2of5_reader', 'code_93_reader',
        ]);
        assert.equal(config.numOfWorkers, 0);
        assert.equal(config.inputStream.size, 2000);
        assert.equal(config.locator.halfSample, false);
        assert.equal(config.locator.patchSize, 'medium');
        callback({ codeResult: { code: 'DAILY123456' } });
    });
    await h.scan();
    assert.equal(h.state.data, 'DAILY123456');
    assert.equal(h.state.error, '');
    assert.equal(h.state.busy, false);
    assert.equal(h.state.timerCleared, true);
});

test('barcode scan reports missing decoder without calling an inaccessible loader', async () => {
    const h = barcodeHarness();
    await h.scan();
    assert.match(h.state.error, /decoder not loaded/);
    assert.equal(h.state.busy, false);
    assert.equal(h.state.logs.length, 1);
});

test('barcode scan reports empty results instead of returning placeholder text', async () => {
    for (const result of [null, {}, { codeResult: {} }, { codeResult: { code: '' } }]) {
        const h = barcodeHarness((_, callback) => callback(result));
        await h.scan();
        assert.match(h.state.error, /No barcode detected/);
        assert.equal(h.state.data, '');
        assert.equal(h.state.busy, false);
        assert.equal(h.state.timerCleared, true);
    }
});

test('barcode scan catches decoder exceptions and clears the busy state', async () => {
    const h = barcodeHarness(() => { throw new TypeError('Decoder failed'); });
    await h.scan();
    assert.match(h.state.error, /Decoder failed/);
    assert.equal(h.state.busy, false);
    assert.equal(h.state.timerCleared, true);
    assert.equal(h.state.logs.length, 1);
});

test('barcode scan times out without accepting a late callback', async () => {
    let complete;
    const h = barcodeHarness((_, callback) => { complete = callback; });
    const scan = h.scan();
    assert.equal(h.state.busy, true);
    h.timeout();
    await scan;
    assert.match(h.state.error, /timed out/);
    assert.equal(h.state.busy, false);
    complete({ codeResult: { code: 'LATE' } });
    assert.equal(h.state.data, '');
});

const featureSource = source.slice(source.indexOf('const APP_FEATURES = ['), source.indexOf('function useGuideFocus'));
const features = vm.runInNewContext(featureSource + '\nAPP_FEATURES');
const actionSource = source.slice(source.indexOf('function runFeature(id)'), source.indexOf('function addToast(msg'));
const keyStart = source.indexOf('if (showTour || e.defaultPrevented');
const keySource = source.slice(source.lastIndexOf('useEffect(() => {', keyStart), source.indexOf('function closeFeaturePanels'));

function harness(overrides = {}) {
    const calls = [];
    let listener;
    const context = {
        APP_FEATURES: features, cols: [{ id: 'todo' }], activeRoom: '', conflicts: [],
        showTour: false, openCard: null, quickMove: null, addCardCol: null,
        showAddCol: false, showShortcuts: false, showEditor: false, showDraw: false,
        showAi: false, showKroki: false, showBase64: false, showZpl: false,
        showPdf: false, showImage: false,
        showJson: false, showCalendar: false, showOcr: false, showDiff: false,
        showSyncModal: false, showConflicts: false,
        commitRef: { current: null },
        document: { querySelector: () => null },
        window: { addEventListener: (_, fn) => { listener = fn; }, removeEventListener: () => {} },
        useEffect: fn => fn(), setTimeout: fn => fn(),
        searchRef: { current: { focus: () => calls.push(['focusSearch']) } },
    };
    for (const name of new Set(actionSource.match(/\bset[A-Z]\w+/g))) {
        if (context[name]) continue;
        context[name] = value => calls.push([name, typeof value === 'function' ? value(false) : value]);
    }
    for (const name of ['closeFeaturePanels', 'addToast', 'refreshAge', 'enableNotifications',
        'importJSON', 'exportJSON', 'installPwa', 'setSearch']) {
        context[name] = (...args) => calls.push([name, ...args]);
    }
    Object.assign(context, overrides);
    vm.createContext(context);
    vm.runInContext(actionSource + '\n' + keySource, context);
    return {
        calls,
        run: id => context.runFeature(id),
        press: (key, extra = {}) => listener({
            key, ctrlKey: false, metaKey: false, altKey: false,
            target: { closest: () => null },
            preventDefault: () => calls.push(['preventDefault']),
            ...extra,
        }),
    };
}

test('every feature has a unique shortcut, description, tour step and executable action', () => {
    assert.equal(new Set(features.map(f => f.key)).size, features.length);
    assert.equal(new Set(features.map(f => f.id)).size, features.length);
    const stepsSource = source.match(/const TOUR_STEPS = useMemo\(\(\) => (\[[\s\S]*?\n            \]), \[\]\)/)[1];
    const steps = vm.runInNewContext(stepsSource, { APP_FEATURES: features });
    for (const feature of features) {
        assert.ok(feature.body.length > 20, feature.id);
        assert.ok(steps.some(step => step.title === feature.label && step.shortcut === feature.key), feature.id);
        const h = harness();
        h.run(feature.id);
        assert.ok(h.calls.length, feature.id);
        assert.ok(!h.calls.some(call => call[1] === 'This feature is not available.'), feature.id);
    }
});

test('letter shortcuts are case-insensitive and cover every registered feature', () => {
    for (const feature of features) {
        const expected = harness();
        expected.run(feature.id);
        const actual = harness();
        actual.press(feature.key.toUpperCase());
        assert.deepEqual(actual.calls.slice(1), expected.calls, feature.id);
        assert.equal(actual.calls[0][0], 'preventDefault');
    }
});

test('typing, modal editing, tour, composition, repeats and browser shortcuts do not launch features', () => {
    for (const overrides of [{ showTour: true }, { openCard: {} }, { quickMove: {} }, { showEditor: true },
        { showCalendar: true }, { showDraw: true }, { showSyncModal: true }, { showShortcuts: true },
        { showPdf: true }, { showImage: true }]) {
        const h = harness(overrides);
        h.press('n');
        assert.deepEqual(h.calls, []);
    }
    for (const extra of [{ ctrlKey: true }, { metaKey: true }, { altKey: true },
        { isComposing: true }, { repeat: true }, { defaultPrevented: true },
        { target: { closest: () => ({}) } }]) {
        const h = harness();
        h.press('n', extra);
        assert.deepEqual(h.calls, []);
    }
});

test('Escape closes tools even from an input, but not over a tour or confirmation', () => {
    const h = harness();
    h.press('Escape', { target: { closest: () => ({}) } });
    assert.ok(h.calls.some(call => call[0] === 'closeFeaturePanels'));
    assert.ok(h.calls.some(call => call[0] === 'setSearch' && call[1] === ''));
    const confirmation = harness({ document: { querySelector: () => ({}) } });
    confirmation.press('Escape');
    assert.deepEqual(confirmation.calls, []);
});

test('new card without columns opens column creation and reports the requirement', () => {
    const h = harness({ cols: [] });
    h.run('card');
    assert.ok(h.calls.some(call => call[0] === 'addToast' && call[2] === 'error'));
    assert.ok(h.calls.some(call => call[0] === 'setShowAddCol' && call[1] === true));
});

test('history opens Time Machine and calendar opens Events', () => {
    for (const [id, tab] of [['history', 'timemachine'], ['calendar', 'events']]) {
        const h = harness();
        h.run(id);
        assert.ok(h.calls.some(call => call[0] === 'setCalendarInitialTab' && call[1] === tab));
        assert.ok(h.calls.some(call => call[0] === 'setShowCalendar' && call[1] === true));
    }
});

test('tour resolves targets in priority order instead of matching the first DOM container', () => {
    const helper = source.slice(source.indexOf('function findTourTarget('), source.indexOf('function Tour('));
    const icon = { getBoundingClientRect: () => ({ width: 30, height: 30 }) };
    const menu = { getBoundingClientRect: () => ({ width: 200, height: 32 }) };
    const hidden = { getBoundingClientRect: () => ({ width: 0, height: 0 }) };
    const elements = { icon: [icon], menu: [menu], hidden: [hidden] };
    const context = {
        document: { querySelectorAll: selector => elements[selector] || [] },
        getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
    };
    vm.createContext(context);
    vm.runInContext(helper, context);
    assert.equal(context.findTourTarget('icon, menu'), icon);
    assert.equal(context.findTourTarget('hidden, menu'), menu);
    assert.equal(context.findTourTarget('missing'), null);
    assert.equal(context.findTourTarget(null), null);
    context.getComputedStyle = element => ({ visibility: element === icon ? 'hidden' : 'visible' });
    assert.equal(context.findTourTarget('icon, menu'), menu);
});

test('feature tour points to exact controls and menu entries, never a generic tools container', () => {
    const stepsSource = source.match(/const TOUR_STEPS = useMemo\(\(\) => (\[[\s\S]*?\n            \]), \[\]\)/)[1];
    const steps = vm.runInNewContext(stepsSource, { APP_FEATURES: features });
    for (const feature of features) {
        const step = steps.find(step => step.title === feature.label);
        assert.equal(step.target, `[data-tour="${feature.target || feature.id}"], [data-tour="menu:${feature.id}"]`);
        assert.equal(step.icon, feature.icon);
        assert.equal(step.menuTarget, feature.id !== 'tools');
    }
    assert.ok(source.includes('data-tour-connector'));
    assert.ok(source.includes('data-tour="add-column"'));
    assert.ok(!source.includes('target: `[data-tour="${feature.target || feature.id}"], [data-tour="mobile-menu"]'));
});

test('Device Sync and Collaborate have different launchers and keyboard shortcuts', () => {
    const sync = harness();
    sync.run('sync');
    assert.ok(sync.calls.some(call => call[0] === 'setSyncDialog' && call[1] === 'device'));
    const collab = harness();
    collab.run('collaborate');
    assert.ok(collab.calls.some(call => call[0] === 'setSyncDialog' && call[1] === 'collaborate'));
    assert.notEqual(features.find(feature => feature.id === 'sync').key, features.find(feature => feature.id === 'collaborate').key);
    assert.ok(!source.includes('Existing device sync (merge personal boards)'));
});

function finalBoardHarness(failKey) {
    const DailySync = require('./sync-engine');
    const { diffChars } = require('./Backend/node_modules/diff');
    const engine = DailySync.createEngine({ actor: 'test', diffChars });
    const snapshot = { cols: [{ id: 'todo', label: 'Todo' }], cards: { todo: [{ id: 'a', task: 'Agreed final value' }] }, scratch: 'Shared final scratch',
        scratchTabs: [{ id: 'notes', label: 'Final notes', content: 'Agreed second tab' }] };
    engine.capture({ cols: [], cards: {}, scratch: '' }, snapshot);
    const data = new Map([['daily_v5', 'old board'], ['daily_scratch', 'old scratch'], ['daily_sync_v2', 'old records']]);
    let failed = false;
    const storage = {
        getItem: key => data.get(key) ?? null,
        setItem: (key, value) => {
            if (key === failKey && !failed) { failed = true; throw new Error('Storage full'); }
            data.set(key, value);
        },
        removeItem: key => data.delete(key),
    };
    const helper = source.slice(source.indexOf('function saveFinalDeviceBoard('), source.indexOf('function DeviceSyncModal('));
    const context = { DailySync, Diff: { diffChars }, console };
    vm.createContext(context);
    vm.runInContext(helper, context);
    return { data, records: engine.getRecords(), save: records => context.saveFinalDeviceBoard(storage, records) };
}

test('explicit final commit persists original board, scratch and causal records together', () => {
    const h = finalBoardHarness();
    h.save(h.records);
    assert.equal(JSON.parse(h.data.get('daily_v5')).cards.todo[0].task, 'Agreed final value');
    assert.equal(h.data.get('daily_scratch'), 'Shared final scratch');
    assert.deepEqual(JSON.parse(h.data.get('daily_sync_v2')).records, JSON.parse(JSON.stringify(h.records)));
    const engine = require('./sync-engine').createEngine({ actor: 'reload', records: JSON.parse(h.data.get('daily_sync_v2')).records });
    assert.equal(engine.materialize().scratchTabs[0].content, 'Agreed second tab');
    assert.equal(JSON.parse(h.data.get('daily_device_commit_backup')).daily_v5, 'old board');
});

const moveSource = source.slice(source.indexOf('function moveBoardColumn('), source.indexOf('function QuickMoveModal('));
const moves = vm.runInNewContext(moveSource + '\n({ moveBoardColumn, moveBoardCard })');
const moveColumns = [{ id: 'TODO', label: 'Todo' }, { id: 'DONE', label: 'Done' }, { id: 'OTHER', label: 'Other', locked: true }];
const moveCards = { TODO: [{ id: 'a', task: 'A', comments: [{ id: 'note', text: 'Keep me' }] }, { id: 'b', task: 'B' }, { id: 'c', task: 'C' }], DONE: [{ id: 'd', task: 'D' }], OTHER: [] };
const ids = cards => Array.from(cards, card => card.id);

test('one-click card destinations append, preserve details and update Done timestamps', () => {
    const next = moves.moveBoardCard(moveCards, moveColumns, 'a', 'TODO', 'DONE', undefined, 'now');
    assert.deepEqual(ids(next.DONE), ['d', 'a']);
    assert.deepEqual(ids(next.TODO), ['b', 'c']);
    assert.equal(next.DONE[1].comments[0].text, 'Keep me');
    assert.equal(next.DONE[1].doneAt, 'now');
    const back = moves.moveBoardCard(next, moveColumns, 'a', 'DONE', 'OTHER', undefined, 'later');
    assert.deepEqual(ids(back.OTHER), ['a']);
    assert.equal(back.OTHER[0].doneAt, undefined);
    assert.deepEqual(ids(moveCards.TODO), ['a', 'b', 'c']);
});

const pdfContext = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'pdf-editor.js'), 'utf8'), pdfContext);
const pdfTools = pdfContext.window.DailyPdfTools;

test('PDF manual replacement warning requires an open page and a matching pending replacement', () => {
    const editorSource = fs.readFileSync(path.join(__dirname, 'pdf-editor.js'), 'utf8');
    const condition = editorSource.match(/\n\s+([^\n]+) && h\('div', \{ className: 'pdf-manual-replacement'/)[1];
    const visible = (page, manualReplacement) => !!vm.runInNewContext(condition, { page, manualReplacement });
    assert.equal(visible(undefined, null), false);
    assert.equal(visible(undefined, { pageId: 'old-page' }), false);
    assert.equal(visible({ id: 'page-1' }, null), false);
    assert.equal(visible({ id: 'page-1' }, { pageId: 'old-page' }), false);
    assert.equal(visible({ id: 'page-1' }, { pageId: 'page-1' }), true);
});

test('PDF text color detection accepts anti-aliased ink and rejects genuinely different colors and unsafe backgrounds', () => {
    const context = { window: {} };
    let pixels;
    context.document = { createElement: () => ({ getContext: () => ({
        scale() {}, rotate() {}, translate() {}, drawImage() {},
        getImageData: () => ({ data: pixels })
    }) }) };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'pdf-editor.js'), 'utf8'), context);
    const tools = context.window.DailyPdfTools;
    const target = { x: 10, y: 10, width: 10, height: 10, angle: 0 };
    const width = 36, height = 39;
    const fixture = (paper, ink, shades) => {
        pixels = new Uint8ClampedArray(width * height * 4);
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
            const inside = x >= 5 && x < width - 5 && y >= 5 && y < height - 5;
            const color = inside ? shades[(x + y) % shades.length] || ink : paper;
            pixels.set([...color, 255], (y * width + x) * 4);
        }
    };
    fixture([255, 255, 255], [0, 0, 0], [[0, 0, 0], [65, 65, 65], [120, 120, 120]]);
    assert.equal(tools.textPatchColors(target, {}, 100, 100).fill, '#000000');
    fixture([255, 255, 255], [180, 20, 40], [[180, 20, 40], [195, 67, 83], [217, 138, 148]]);
    assert.equal(tools.textPatchColors(target, {}, 100, 100).fill, '#b41428');
    fixture([255, 255, 255], [0, 0, 0], [[0, 0, 0], [255, 0, 0]]);
    assert.throws(() => tools.textPatchColors(target, {}, 100, 100), /multiple colors or artwork/);
    for (let x = 0; x < width; x++) pixels.set([0, 0, 0, 255], x * 4);
    assert.throws(() => tools.textPatchColors(target, {}, 100, 100), /complex background/);
    pixels[3] = 0;
    assert.throws(() => tools.textPatchColors(target, {}, 100, 100), /page edge/);
});

test('PDF text detects named font families and original bold/italic styles', () => {
    for (const [name, family, weight, style] of [
        ['ABCDEF+Arial-BoldItalicMT', 'Arial', 'bold', 'italic'],
        ['Consolas-Italic', 'Consolas', 'normal', 'italic'],
        ['SegoeUI-Semibold', 'Segoe UI', 'bold', 'normal'],
        ['Garamond', 'Garamond', 'normal', 'normal'],
        ['Times-BoldItalic', 'Times New Roman', 'bold', 'italic'],
        ['Courier-Oblique', 'Courier New', 'normal', 'italic']
    ]) {
        const detected = pdfTools.sourceFontStyle(name);
        assert.equal(detected.family, family, name);
        assert.equal(detected.weight, weight, name);
        assert.equal(detected.style, style, name);
    }
});

test('PDF subset fonts keep available glyphs when typing missing characters and match a full device font when available', () => {
    const original = { parsed: { hasGlyphForCodePoint: code => code === 65 }, face: {},
        family: 'RecoveredFont', fallback: 'Garamond' };
    const exact = pdfTools.sourceTextFont(original, 'A A');
    assert.equal(exact.fontFamily, 'RecoveredFont');
    assert.equal(exact.sourceFontExact, true);
    const partial = pdfTools.sourceTextFont(original, 'AB');
    assert.equal(partial.fontFamily, 'RecoveredFont, "Garamond"');
    assert.equal(partial.sourceFontMethod, 'partial');
    assert.equal(partial.sourceFontExact, false);
    assert.equal(pdfTools.sourceTextFont(original, 'B').fontFamily, 'Garamond');
    original.localFace = {}; original.localFamily = 'FullDeviceFont';
    const device = pdfTools.sourceTextFont(original, 'AB');
    assert.equal(device.fontFamily, 'FullDeviceFont');
    assert.equal(device.sourceFontMethod, 'device');
    assert.equal(device.sourceFontExact, true);
    assert.equal(pdfTools.sourceTextFont(original, 'A').fontFamily, 'RecoveredFont');
});

test('PDF replacement text keeps detected styling and width without bitmap object caching', () => {
    class ObjectStub {
        constructor(text, properties) {
            if (typeof text === 'string') { this.text = text; this.width = text.length * 5; }
            else properties = text;
            Object.assign(this, { lineHeight: 1, _fontSizeFraction: 0.2 }, properties);
        }
        set(key, value) { Object.assign(this, typeof key === 'string' ? { [key]: value } : key); }
        _getLeftOffset() { return 0; }
        _getTopOffset() { return 0; }
        getHeightOfLine() { return 10; }
        calcTransformMatrix() { return [this.scaleX, 0, 0, 1, this.left, this.top]; }
    }
    const context = { window: {}, crypto: { randomUUID: () => 'mask-id' }, fabric: {
        IText: ObjectStub, Rect: ObjectStub, Point: class { constructor(x, y) { Object.assign(this, { x, y }); } },
        util: { transformPoint: (point, matrix) => ({ x: point.x * matrix[0] + matrix[4], y: point.y + matrix[5] }) }
    } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'pdf-editor.js'), 'utf8'), context);
    const target = { text: 'Original', x: 40, y: 80, width: 60, height: 12, angle: 0,
        fontFamily: 'Recovered', fontWeight: 'bold', fontStyle: 'italic', sourceFontExact: true, sourceFontMethod: 'embedded' };
    const { object, mask } = context.window.DailyPdfTools.replacementObjects(target, '#ddeeff', '#bb2244');
    assert.equal(object.fontFamily, 'Recovered');
    assert.equal(object.fontWeight, 'bold');
    assert.equal(object.fontStyle, 'italic');
    assert.equal(object.fill, '#bb2244');
    assert.equal(object.fontSize, 12);
    assert.equal(object.width * object.scaleX, 60);
    assert.equal(object.objectCaching, false);
    assert.equal(object.top + 8, target.y + target.height);
    assert.equal(mask.fill, '#ddeeff');
    assert.equal(mask.selectable, false);
    assert.equal(object.replacementMask, mask.name);
});

test('PDF font recovery retries converted font data and extracts embedded fonts even without PDF.js font data', async () => {
    const attempts = [], added = [];
    const context = { window: {}, crypto: { randomUUID: () => String(attempts.length) },
        document: { fonts: { add: face => added.push(face) } } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'pdf-editor.js'), 'utf8'), context);
    let embeddedBytes = new Uint8Array([1]);
    const descriptor = { lookupMaybe: key => key === 'FontFile2' ? {} : undefined };
    const font = { get: () => ({ decodeText: () => 'TestFont' }),
        lookupMaybe: key => key === 'FontDescriptor' ? descriptor : undefined };
    const resources = { lookupMaybe: key => key === 'Font' ? { entries: () => [[{}, font]] } : undefined };
    const pdf = { getPage: () => ({ node: { Resources: () => resources } }), context: { lookup: value => value } };
    context.PDFLib = { PDFName: { of: key => key }, decodePDFRawStream: () => ({ decode: () => embeddedBytes }) };
    context.FontFace = class {
        constructor(family, bytes, descriptors) { Object.assign(this, { family, bytes, descriptors }); }
        async load() { if (typeof this.bytes === 'string') throw new Error('Device font not installed'); return this; }
    };
    context.window.fontkit = { create: bytes => {
        attempts.push(bytes[0]);
        if (bytes[0] === 1) throw new Error('Unsupported original font program');
        return { subfamilyName: 'Bold Italic', fullName: 'TestFont Bold Italic', hasGlyphForCodePoint: () => true };
    } };
    const tools = context.window.DailyPdfTools;
    const detected = tools.sourceFontStyle('TestFont-BoldItalic');
    const recovered = await tools.recoverSourceFont(pdf, 1, { name: 'TestFont', data: new Uint8Array([2]) }, detected);
    assert.deepEqual(attempts, [1, 2]);
    assert.equal(recovered.bytes[0], 2);
    assert.equal(recovered.fontWeight, 'bold');
    assert.equal(recovered.fontStyle, 'italic');
    assert.match(recovered.recoveryErrors[0], /Unsupported original font/);
    assert.equal(added.length, 1);
    attempts.length = 0; embeddedBytes = new Uint8Array([2]);
    const embeddedOnly = await tools.recoverSourceFont(pdf, 1, { name: 'TestFont' }, detected);
    assert.deepEqual(attempts, [2]);
    assert.ok(embeddedOnly.face);
    embeddedBytes = null;
    context.FontFace = class {
        constructor(family, source, descriptors) { Object.assign(this, { family, source, descriptors }); }
        async load() {
            if (this.source !== 'local("Garamond Italic")' && this.source !== 'local("Helvetica")') throw new Error('Font not installed');
            return this;
        }
    };
    const installed = await tools.recoverSourceFont(pdf, 1, { name: 'Garamond-Italic' }, tools.sourceFontStyle('Garamond-Italic'));
    assert.ok(installed.localFace);
    assert.equal(installed.localFace.descriptors.style, 'italic');
    const unavailable = await tools.recoverSourceFont(pdf, 1, { name: 'UnknownCustom' }, tools.sourceFontStyle('UnknownCustom'));
    assert.equal(unavailable.localFace, undefined, 'A generic fallback must not be reported as an exact device font match');
});

test('Layout-preserving Markdown keeps stable block identities and rejects structural changes', () => {
    const blocks = [{ id: 'text-1', source: 'Title' }, { id: 'text-2', source: 'Body' }];
    const source = pdfTools.layoutSource(blocks);
    assert.deepEqual(Array.from(pdfTools.parseLayoutSource(source, blocks)), ['Title', 'Body']);
    assert.deepEqual(Array.from(pdfTools.parseLayoutSource(source.replace('Body', '**Edited**'), blocks)), ['Title', '**Edited**']);
    assert.throws(() => pdfTools.parseLayoutSource(source.replace('<!-- pdf-block:text-2 -->', ''), blocks), /Keep each pdf-block/);
    assert.throws(() => pdfTools.parseLayoutSource(source.replace('text-2', 'text-3'), blocks), /original order/);
    assert.throws(() => pdfTools.parseLayoutSource('New paragraph\n' + source, blocks), /Keep each pdf-block/);
});

test('Layout-preserving Markdown changes only edited annotations and rejects overflow atomically', async () => {
    const context = { window: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'pdf-editor.js'), 'utf8'), context);
    const tools = context.window.DailyPdfTools;
    class Text {
        constructor(data) { Object.assign(this, JSON.parse(JSON.stringify(data))); this.initDimensions(); }
        set(properties) { Object.assign(this, properties); return this; }
        initDimensions() { this._textLines = this.text.split('\n'); this.width = Math.max(...this._textLines.map(line => line.length)) * 6; this.height = this._textLines.length * 12; }
        setCoords() {}
        toObject() { const { _textLines, ...data } = this; return data; }
    }
    context.fabric = { util: { enlivenObjects: (objects, callback) => callback(objects.map(object => new Text(object))) } };
    const object = { type: 'i-text', name: 'annotation-1', text: 'Original label', left: 60, top: 90, fill: '#cc2233', fontSize: 12, fontFamily: 'TestFont' };
    const originalOverlay = { objects: [
        { type: 'rect', name: 'artwork', left: 10, top: 10, fill: '#124488', width: 200, height: 100 },
        object, { type: 'image', name: 'picture', src: 'fixture', left: 220, top: 140 }
    ] };
    const blocks = [{ id: 'text-1', source: 'Original label', object }];
    const markdown = { blocks, originalOverlay, source: tools.layoutSource(blocks) };
    const noChange = await tools.layoutEdits(markdown, () => { throw new Error('Unchanged blocks must not be re-rendered'); });
    assert.deepEqual(JSON.parse(JSON.stringify(noChange)), originalOverlay);
    const lexer = text => [{ type: 'paragraph', tokens: [{ type: 'text', text }] }];
    markdown.source = tools.layoutSource([{ ...blocks[0], source: 'Edited' }]);
    const edited = await tools.layoutEdits(markdown, lexer);
    assert.deepEqual(JSON.parse(JSON.stringify(edited.objects[0])), originalOverlay.objects[0]);
    assert.deepEqual(JSON.parse(JSON.stringify(edited.objects[2])), originalOverlay.objects[2]);
    assert.equal(edited.objects[1].text, 'Edited');
    assert.equal(edited.objects[1].fill, '#cc2233');
    assert.equal(edited.objects[1].fontFamily, 'TestFont');
    assert.equal(edited.objects[1].left, 60);
    assert.equal(edited.objects[1].top, 90);
    markdown.source = tools.layoutSource([{ ...blocks[0], source: 'Far too much text to fit the original annotation block' }]);
    await assert.rejects(tools.layoutEdits(markdown, lexer), /overflows.*Apply is blocked/);
    assert.equal(originalOverlay.objects[1].text, 'Original label');
    markdown.source = tools.layoutSource([{ ...blocks[0], source: 'Line one\nLine two' }]);
    await assert.rejects(tools.layoutEdits(markdown, lexer), /overflows/);
    markdown.source = tools.layoutSource([{ ...blocks[0], source: '' }]);
    const deleted = await tools.layoutEdits(markdown, lexer);
    assert.equal(deleted.objects.length, 2);
    assert.equal(originalOverlay.objects.length, 3);
});

test('PDF font choices cover at least 30 unique font families', () => {
    assert.ok(pdfTools.FONT_CHOICES.length >= 30);
    assert.equal(new Set(pdfTools.FONT_CHOICES.map(font => font.family)).size, pdfTools.FONT_CHOICES.length);
    for (const family of ['Consolas', 'Garamond', 'Segoe UI', 'DM Sans']) {
        assert.ok(pdfTools.FONT_CHOICES.some(font => font.family === family));
    }
});

test('Markdown blocks retain formatting, nested lists and code without interpreting HTML or images', () => {
    const tokens = [
        { type: 'heading', depth: 1, tokens: [{ type: 'text', text: 'Title' }] },
        { type: 'paragraph', tokens: [{ type: 'strong', tokens: [{ type: 'text', text: 'Bold' }] },
            { type: 'em', tokens: [{ type: 'text', text: 'Italic' }] },
            { type: 'html', text: '<script>danger()</script>' }] },
        { type: 'list', ordered: true, start: 3, items: [{ tokens: [
            { type: 'text', tokens: [{ type: 'text', text: 'Third' }] },
            { type: 'list', ordered: false, items: [{ task: true, checked: true, tokens: [{ type: 'text', text: 'Nested' }] }] }
        ] }] },
        { type: 'code', text: 'const x = 1;\nconsole.log(x);' }
    ];
    const blocks = pdfTools.markdownBlocks('fixture', () => tokens);
    assert.equal(blocks[0].fontSize, 28);
    assert.equal(blocks[0].fontWeight, 'bold');
    assert.equal(blocks[1].runs[0].style.fontWeight, 'bold');
    assert.equal(blocks[1].runs[1].style.fontStyle, 'italic');
    assert.equal(blocks[1].runs[2].text, '<script>danger()</script>');
    assert.equal(blocks[2].runs.map(run => run.text).join(''), '3. Third');
    assert.equal(blocks[3].runs.map(run => run.text).join(''), '[x] Nested');
    assert.ok(blocks[3].indent > blocks[2].indent);
    assert.equal(blocks[4].fontFamily, 'Courier New');
});

test('Markdown image references use session assets, support removal and reject missing images', () => {
    const image = { object: { type: 'image', width: 100, height: 50, src: 'data:image/png;base64,fixture' }, fixed: true, top: 100, bottom: 150 };
    const tokens = [{ type: 'paragraph', tokens: [{ type: 'image', text: 'Picture', href: 'pdf-image:fixture' }] }];
    const blocks = pdfTools.markdownBlocks('![Picture](pdf-image:fixture)', () => tokens, { 'pdf-image:fixture': image });
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].image, image);
    assert.equal(blocks[0].href, 'pdf-image:fixture');
    assert.throws(() => pdfTools.markdownBlocks('![Picture](pdf-image:fixture)', () => tokens), /not available/);
    assert.equal(pdfTools.markdownBlocks('Text only', () => [{ type: 'paragraph', tokens: [{ type: 'text', text: 'Text only' }] }],
        { 'pdf-image:fixture': image }).some(block => block.image), false);
    assert.throws(() => pdfTools.markdownBlocks('table', () => [{ type: 'table', header: [{ tokens: tokens[0].tokens }], rows: [] }],
        { 'pdf-image:fixture': image }), /outside tables/);
});

test('PDF page conversion escapes literal Markdown and preserves inline formatting', () => {
    const text = pdfTools.pageMarkdown([
        { type: 'textbox', top: 50, left: 40, text: '# literal *content*', fontWeight: 'normal' },
        { type: 'textbox', top: 100, left: 40, text: 'Bold', styles: { 0: { 0: { fontWeight: 'bold' }, 1: { fontWeight: 'bold' },
            2: { fontWeight: 'bold' }, 3: { fontWeight: 'bold' } } } }
    ], {});
    assert.equal(text, '\\# literal \\*content\\*\n\n**Bold**');
    const wrapped = pdfTools.pageMarkdown([
        { type: 'textbox', top: 48, left: 48, fontSize: 12, lineHeight: 1.35, text: 'First line', styles: [{ start: 0, end: 5, style: { fontWeight: 'bold' } }] },
        { type: 'textbox', top: 66.3, left: 48, fontSize: 12, lineHeight: 1.35, text: 'wrapped continuation' },
        { type: 'textbox', top: 96, left: 48, fontSize: 12, lineHeight: 1.35, text: 'Next paragraph' }
    ], {});
    assert.equal(wrapped, '**First** line\nwrapped continuation\n\nNext paragraph');
});

test('PDF page image conversion reports malformed clipping paths and unsupported masks', async () => {
    pdfContext.pdfjsLib = { Util: { transform: () => [] }, OPS: { clip: 1, paintImageXObject: 2, paintImageMaskXObject: 3 } };
    const source = operators => ({ getViewport: () => ({}), getOperatorList: async () => operators });
    await assert.rejects(pdfTools.pageImages(source({ fnArray: [1, 2], argsArray: [[], ['image']] }), 0), /clipping path is missing/);
    await assert.rejects(pdfTools.pageImages(source({ fnArray: [3], argsArray: [[]] }), 0), /grouped or masked/);
});

test('PDF image clipping replays paths, even-odd rules and nested form bounds without leaking saved clips', async t => {
    const previous = { pdfjsLib: pdfContext.pdfjsLib, document: pdfContext.document, Path2D: pdfContext.Path2D, fabric: pdfContext.fabric };
    t.after(() => Object.assign(pdfContext, previous));
    const paths = [], contexts = [];
    pdfContext.Path2D = class {
        constructor(path) { this.commands = path ? path.commands.slice() : []; paths.push(this); }
        moveTo(...args) { this.commands.push(['move', ...args]); }
        lineTo(...args) { this.commands.push(['line', ...args]); }
        closePath() { this.commands.push(['close']); }
        bezierCurveTo(...args) { this.commands.push(['curve', ...args]); }
    };
    const ops = Object.fromEntries(['save', 'restore', 'transform', 'constructPath', 'rectangle', 'moveTo', 'lineTo',
        'curveTo', 'curveTo2', 'curveTo3', 'closePath', 'clip', 'eoClip', 'endPath',
        'paintFormXObjectBegin', 'paintFormXObjectEnd', 'paintInlineImageXObject'].map((name, index) => [name, index + 1]));
    const multiply = (a, b) => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
        a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
        a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
    pdfContext.pdfjsLib = { OPS: ops, Util: { transform: multiply,
        applyTransform: ([x, y], m) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]] } };
    pdfContext.document = { createElement: () => {
        const canvas = { width: 0, height: 0 };
        const context = { clips: [], scale() {}, translate() {}, transform() {}, drawImage() {},
            clip(path, rule) { this.clips.push({ path, rule }); },
            getImageData() { return { data: new Uint8Array(canvas.width * canvas.height * 4).fill(255) }; } };
        contexts.push(context); canvas.getContext = () => context;
        return canvas;
    } };
    pdfContext.fabric = { Image: class {
        constructor(canvas, options) { Object.assign(this, options, { width: canvas.width, height: canvas.height }); }
        toObject() { return { ...this }; }
    } };
    const image = { width: 10, height: 10, bitmap: {} };
    const sequence = [
        ['save', []], ['transform', [100, 0, 0, 100, 20, 30]],
        ['constructPath', [[ops.rectangle], [0, 0, 0.5, 1]]], ['clip', []], ['endPath', []],
        ['paintInlineImageXObject', [image]], ['restore', []],
        ['transform', [100, 0, 0, 100, 0, 0]], ['paintInlineImageXObject', [image]],
        ['save', []], ['constructPath', [[ops.moveTo, ops.curveTo, ops.closePath], [0, 0, 0, 1, 1, 1, 1, 0]]],
        ['eoClip', []], ['endPath', []],
        ['paintFormXObjectBegin', [[1, 0, 0, 1, 0, 0], [0, 0, 0.8, 0.8]]],
        ['paintInlineImageXObject', [image]], ['paintFormXObjectEnd', []],
        ['paintInlineImageXObject', [image]], ['restore', []]
    ];
    const result = await pdfTools.pageImages({
        getViewport: () => ({ width: 300, height: 300, transform: [1, 0, 0, 1, 0, 0] }),
        getOperatorList: async () => ({ fnArray: sequence.map(([name]) => ops[name]), argsArray: sequence.map(([, args]) => args) })
    }, 0);
    assert.equal(result.length, 4);
    const rendered = contexts.filter(context => context.clips.length);
    assert.deepEqual(rendered.map(context => context.clips.length), [1, 2, 1]);
    assert.deepEqual(rendered.map(context => context.clips.map(clip => clip.rule)), [['nonzero'], ['evenodd', 'nonzero'], ['evenodd']]);
    assert.deepEqual(Array.from(rendered[0].clips[0].path.commands[0]), ['move', 20, 30]);
    assert.ok(paths.some(path => path.commands.some(command => command[0] === 'curve')));
});

test('Markdown reports blank and oversized source and converts tables to text', () => {
    assert.throws(() => pdfTools.markdownBlocks('  \n', () => []), /Write some Markdown/);
    assert.throws(() => pdfTools.markdownBlocks('x'.repeat(100001), () => []), /100,000/);
    const cell = text => ({ tokens: [{ type: 'text', text }] });
    const blocks = pdfTools.markdownBlocks('table', () => [
        { type: 'table', header: [cell('A'), cell('B')], rows: [[cell('1'), cell('2')]] }
    ]);
    assert.equal(blocks[0].runs[0].text, 'A | B\n1 | 2');
});

test('Markdown layout paginates at A4 margins and keeps unstyled text eligible for vector export', () => {
    class Textbox {
        constructor(text, options) {
            Object.assign(this, options, { text });
            this._textLines = text.split('\n').map(line => Array.from(line));
            this._styleMap = this._textLines.map((line, index) => ({ line: index, offset: 0 }));
        }
        getHeightOfLine() { return this.fontSize * this.lineHeight; }
        getLineWidth(index) { return this._textLines[index].length * this.fontSize / 2; }
        toObject() { return { text: this.text, top: this.top, left: this.left, styles: this.styles, height: this.getHeightOfLine() }; }
    }
    pdfContext.fabric = { Textbox };
    const lines = Array.from({ length: 60 }, (_, index) => 'Line ' + index);
    const pages = pdfTools.layoutMarkdown([{ runs: [{ text: lines.join('\n'), style: {} }], indent: 0, fontSize: 20, fontFamily: 'Helvetica' }]);
    assert.equal(pages.length, 3);
    const objects = Array.from(pages).flatMap(page => Array.from(page.objects));
    assert.deepEqual(objects.map(object => object.text), lines);
    for (const object of objects) {
        assert.ok(object.top >= 48);
        assert.ok(object.top + object.height <= 793.89);
        assert.equal(Object.keys(object.styles).length, 0);
    }
    const styled = pdfTools.layoutMarkdown([{ runs: [{ text: 'Bold', style: { fontWeight: 'bold' } }], indent: 999, fontSize: 20, fontFamily: 'Helvetica' }]);
    assert.equal(styled[0].objects[0].styles[0][0].fontWeight, 'bold');
    assert.ok(styled[0].objects[0].left <= 228);
    assert.throws(() => pdfTools.layoutMarkdown([{ runs: [{ text: 'x\n'.repeat(6000), style: {} }], indent: 0, fontSize: 20, fontFamily: 'Helvetica' }]), /200-page/);
    const image = { object: { type: 'image', left: 80, top: 48, width: 100, height: 100, src: 'fixture' }, fixed: true, top: 48, bottom: 148 };
    const retained = pdfTools.layoutMarkdown([{ image, href: 'pdf-image:fixture' },
        { runs: [{ text: 'Below image', style: {} }], indent: 0, fontSize: 20, fontFamily: 'Helvetica' }]);
    assert.equal(retained[0].objects[0].left, 80);
    assert.equal(retained[0].objects[0].top, 48);
    assert.ok(retained[0].objects[1].top > 148);
});

test('quick move inserts cards at exact first, middle and last positions without duplicates or mutation', () => {
    for (const [position, expected] of [[0, ['c', 'a', 'b']], [1, ['a', 'c', 'b']], [2, ['a', 'b', 'c']]]) {
        const next = moves.moveBoardCard(moveCards, moveColumns, 'c', 'TODO', 'TODO', position, 'now');
        assert.deepEqual(ids(next.TODO), expected);
        assert.equal(new Set(ids(next.TODO)).size, 3);
    }
    for (const [position, expected] of [[0, ['a', 'd']], [1, ['d', 'a']]]) {
        const next = moves.moveBoardCard(moveCards, moveColumns, 'a', 'TODO', 'DONE', position, 'now');
        assert.deepEqual(ids(next.DONE), expected);
        assert.deepEqual(ids(next.TODO), ['b', 'c']);
        assert.equal(next.DONE.find(card => card.id === 'a').comments[0].text, 'Keep me');
        assert.equal(next.DONE.find(card => card.id === 'a').doneAt, 'now');
        const back = moves.moveBoardCard(next, moveColumns, 'a', 'DONE', 'OTHER', 0, 'later');
        assert.equal(back.OTHER[0].doneAt, undefined);
    }
    assert.deepEqual(ids(moveCards.TODO), ['a', 'b', 'c']);
    assert.equal(moveCards.TODO[0].updatedAt, undefined);
});

test('quick move validates stale entities, bounds and column locks', () => {
    for (const position of [-1, 4, 0.5, NaN]) {
        assert.throws(() => moves.moveBoardCard(moveCards, moveColumns, 'a', 'TODO', 'DONE', position), /valid card position/);
        assert.throws(() => moves.moveBoardColumn(moveColumns, 'TODO', position), /valid column position/);
    }
    assert.throws(() => moves.moveBoardCard(moveCards, moveColumns, 'missing', 'TODO', 'DONE', 0), /moved or was deleted/);
    assert.throws(() => moves.moveBoardCard(moveCards, moveColumns, 'a', 'TODO', 'missing', 0), /no longer exists/);
    assert.throws(() => moves.moveBoardColumn(moveColumns, 'OTHER', 0), /Unlock/);
    assert.throws(() => moves.moveBoardColumn(moveColumns, 'missing', 0), /no longer exists/);
    assert.deepEqual(Array.from(moves.moveBoardColumn(moveColumns, 'TODO', 2), column => column.id), ['DONE', 'OTHER', 'TODO']);
    assert.deepEqual(Array.from(moves.moveBoardColumn(moveColumns, 'DONE', 0), column => column.id), ['DONE', 'TODO', 'OTHER']);
    assert.deepEqual(moveColumns.map(column => column.id), ['TODO', 'DONE', 'OTHER']);
});

function scratchBackupHarness() {
    let download, input;
    const calls = [];
    const context = {
        cols: moveColumns, cards: moveCards, scratch: 'Main notes',
        scratchTabs: [{ id: 'tab', label: 'Work', content: 'Extra notes' }],
        Blob, URL: { createObjectURL: blob => { download = blob; return 'blob:test'; } },
        document: { createElement: tag => {
            const element = { click() {} };
            if (tag === 'input') input = element;
            return element;
        } },
        FileReader: class {
            readAsText(text) { this.onload({ target: { result: text } }); }
        },
        setCols: value => calls.push(['cols', value]),
        setCards: value => calls.push(['cards', value]),
        setScratch: value => calls.push(['scratch', value]),
        setScratchTabs: value => calls.push(['tabs', value]),
        addToast: (...args) => calls.push(['toast', ...args]),
    };
    const backupSource = source.slice(source.indexOf('function exportJSON()'), source.indexOf('async function installPwa()'));
    vm.createContext(context);
    vm.runInContext(backupSource, context);
    return {
        calls,
        export: async () => { context.exportJSON(); return JSON.parse(await download.text()); },
        import: data => {
            context.importJSON();
            input.onchange({ target: { files: [JSON.stringify(data)] } });
        },
    };
}

test('JSON backup round-trips every Scratch tab while old board imports preserve current notes', async () => {
    const h = scratchBackupHarness();
    const exported = await h.export();
    assert.equal(exported.scratch, 'Main notes');
    assert.deepEqual(exported.scratchTabs, [{ id: 'tab', label: 'Work', content: 'Extra notes' }]);
    h.import(exported);
    assert.equal(h.calls.find(call => call[0] === 'tabs')[1][0].content, 'Extra notes');
    const legacy = scratchBackupHarness();
    legacy.import({ cols: moveColumns, cards: moveCards });
    assert.ok(legacy.calls.some(call => call[0] === 'cols'));
    assert.ok(!legacy.calls.some(call => ['scratch', 'tabs'].includes(call[0])));
});

test('invalid or duplicate imported Scratch tabs report an error before changing the board', () => {
    for (const tabs of [{}, [null], [{ id: 'shared', label: 'Reserved', content: '' }],
        [{ id: 'a', label: 'A', content: 3 }],
        [{ id: 'a', label: 'A', content: '' }, { id: 'a', label: 'B', content: '' }]]) {
        const h = scratchBackupHarness();
        h.import({ cols: moveColumns, cards: moveCards, scratchTabs: tabs });
        assert.deepEqual(h.calls, [['toast', 'Import failed: Invalid Scratch tabs', 'error']]);
    }
});

test('failed final commit rolls back original data and never silently acknowledges success', () => {
    for (const key of ['daily_device_commit_backup', 'daily_v5', 'daily_scratch', 'daily_sync_v2']) {
        const h = finalBoardHarness(key);
        assert.throws(() => h.save(h.records), /Storage full/);
        assert.equal(h.data.get('daily_v5'), 'old board');
        assert.equal(h.data.get('daily_scratch'), 'old scratch');
        assert.equal(h.data.get('daily_sync_v2'), 'old records');
    }
    const invalid = finalBoardHarness();
    assert.throws(() => invalid.save({ broken: {} }), /Invalid final board/);
});
