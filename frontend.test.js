const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
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
