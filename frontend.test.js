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
        showTour: false, openCard: null, quickMove: null, addCardCol: null,
        showAddCol: false, showShortcuts: false, showEditor: false, showDraw: false,
        showAi: false, showKroki: false, showBase64: false, showZpl: false,
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
