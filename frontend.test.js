const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

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
        showTour: false, openCard: null, addCardCol: null,
        showAddCol: false, showShortcuts: false, showEditor: false, showDraw: false,
        showAi: false, showKroki: false, showBase64: false, showZpl: false,
        showJson: false, showCalendar: false, showOcr: false, showDiff: false,
        showSyncModal: false, showConflicts: false,
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
    for (const overrides of [{ showTour: true }, { openCard: {} }, { showEditor: true },
        { showCalendar: true }, { showDraw: true }, { showSyncModal: true }, { showShortcuts: true }]) {
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
