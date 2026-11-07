const test = require('node:test');
const assert = require('node:assert/strict');
const { diffChars } = require('diff');
const { createEngine } = require('../sync-engine');
const WebSocket = require('ws');
const { once } = require('node:events');
const { createSyncServer } = require('./server');

async function deviceRoom(context) {
    const relay = createSyncServer();
    const clients = [];
    context.after(async () => {
        clients.forEach(connection => connection.client.terminate());
        await new Promise(resolve => relay.wss.close(resolve));
        await new Promise(resolve => relay.server.close(resolve));
    });
    relay.server.listen(0, '127.0.0.1');
    await once(relay.server, 'listening');
    async function connect(id, mode = 'device', expectCapabilities = mode === 'device') {
        const client = new WebSocket(`ws://127.0.0.1:${relay.server.address().port}/?room=devices&mode=${mode}`);
        const messages = [], waiters = [];
        client.on('message', raw => {
            const message = JSON.parse(raw.toString());
            const index = waiters.findIndex(waiter => waiter.predicate(message));
            if (index >= 0) waiters.splice(index, 1)[0].resolve(message);
            else messages.push(message);
        });
        const receive = predicate => {
            const index = messages.findIndex(predicate);
            return index >= 0 ? Promise.resolve(messages.splice(index, 1)[0])
                : new Promise(resolve => waiters.push({ predicate, resolve }));
        };
        const send = message => client.send(JSON.stringify(message));
        const connection = { client, send, receive };
        clients.push(connection);
        await once(client, 'open');
        send({ _type: 'request_state', _sid: id, deviceCommit: 1 });
        if (expectCapabilities) {
            const capabilities = await receive(message => message._type === 'sync_capabilities');
            assert.equal(capabilities.deviceCommit, 1);
        }
        return connection;
    }
    return { ...relay, connect };
}

const empty = () => ({ cols: [], cards: {}, scratch: '' });
const snapshot = content => ({ cols: [{ id: 'TODO', label: 'Todo' }], cards: { TODO: [{ id: 'card-a', task: 'Card A', content }] }, scratch: '' });
const peer = actor => createEngine({ actor, diffChars });
const contentOf = engine => engine.materialize().cards.TODO[0].content;

test('PDF editor and module unlock worker are served with executable MIME types', async context => {
    const relay = await deviceRoom(context);
    const origin = `http://127.0.0.1:${relay.server.address().port}`;
    for (const [asset, type, text] of [
        ['/pdf-editor.js', 'text/javascript', 'DailyPdfTools'],
        ['/pdf-editor.css', 'text/css', '.pdf-window'],
        ['/pdf-unlock-worker.js', 'text/javascript', 'qpdf.decrypt']
    ]) {
        const response = await fetch(origin + asset);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('content-type'), type);
        assert.ok((await response.text()).includes(text));
    }
});

function paired(content = 'abc') {
    const desktop = peer('desktop');
    const mobile = peer('mobile');
    desktop.capture(empty(), snapshot(content), false);
    mobile.merge(desktop.getRecords());
    return { desktop, mobile };
}

test('independent boards merge all cards, columns and comments', () => {
    const desktop = peer('desktop');
    const mobile = peer('mobile');
    const first = snapshot('abc');
    first.cards.TODO[0].comments = [{ id: 'comment-a', text: 'Desktop note' }];
    const second = { cols: [{ id: 'OTHER', label: 'Other' }], cards: { OTHER: [{ id: 'card-b', task: 'Mobile task', content: 'def' }] }, scratch: '' };
    desktop.capture(empty(), first, false);
    mobile.capture(empty(), second, false);
    desktop.merge(mobile.getRecords());
    mobile.merge(desktop.getRecords());
    assert.equal(desktop.materialize().cards.OTHER[0].id, 'card-b');
    assert.equal(mobile.materialize().cards.TODO[0].comments[0].id, 'comment-a');
    assert.equal(desktop.materialize().conflicts.length, 0);
});

test('append and disjoint insertions converge without a prompt', () => {
    const { desktop, mobile } = paired();
    desktop.capture(snapshot('abc'), snapshot('abcd'));
    mobile.capture(snapshot('abc'), snapshot('Xabc'));
    desktop.merge(mobile.getRecords());
    mobile.merge(desktop.getRecords());
    assert.equal(contentOf(desktop), 'Xabcd');
    assert.equal(contentOf(mobile), 'Xabcd');
    assert.equal(desktop.materialize().conflicts.length, 0);
});

test('removal and same-field replacement retain both alternatives', () => {
    for (const [before, after] of [['abc', 'ab'], ['shubham', 'shabam']]) {
        const { desktop, mobile } = paired(before);
        mobile.capture(snapshot(before), snapshot(after));
        desktop.merge(mobile.getRecords());
        const conflict = desktop.materialize().conflicts.find(item => item.field === 'content');
        assert.deepEqual(conflict.values, [before, after]);
        assert.equal(desktop.materialize().cards.TODO.length, 1);
    }
});

test('offline replacements made before joining do not silently overwrite a peer', () => {
    const { desktop, mobile } = paired('shubham');
    mobile.capture(snapshot('shubham'), snapshot('shabam'), false);
    desktop.merge(mobile.getRecords());
    assert.ok(desktop.materialize().conflicts.some(item => item.field === 'content'));
});

test('different initial text without shared history requires a decision, even when one is a prefix', () => {
    for (const value of ['ab', 'abcd']) {
        const desktop = peer('desktop');
        const mobile = peer('mobile');
        desktop.capture(empty(), snapshot('abc'));
        mobile.capture(empty(), snapshot(value));
        desktop.merge(mobile.getRecords());
        const conflict = desktop.materialize().conflicts.find(item => item.field === 'content');
        assert.ok(conflict);
        assert.ok(conflict.values.includes('abc'));
        assert.ok(conflict.values.includes(value));
    }
});

test('card deletion remains visible until resolved and stale peers cannot resurrect it', () => {
    const { desktop, mobile } = paired();
    const stale = structuredClone(desktop.getRecords());
    mobile.capture(snapshot('abc'), { cols: snapshot('abc').cols, cards: { TODO: [] }, scratch: '' });
    desktop.merge(mobile.getRecords());
    const conflict = desktop.materialize().conflicts.find(item => item.field === '__deleted');
    assert.equal(desktop.materialize().cards.TODO.length, 1);
    const decision = desktop.resolve(conflict, true);
    mobile.merge(decision);
    mobile.merge(stale);
    assert.equal(mobile.materialize().cards.TODO.length, 0);
});

test('conflict choices converge across three devices and survive serialization', () => {
    const { desktop, mobile } = paired();
    const laptop = peer('laptop');
    laptop.merge(desktop.getRecords());
    mobile.capture(snapshot('abc'), snapshot('ab'));
    laptop.capture(snapshot('abc'), snapshot('xyz'));
    desktop.merge(mobile.getRecords());
    desktop.merge(laptop.getRecords());
    const conflict = desktop.materialize().conflicts.find(item => item.field === 'content');
    assert.equal(conflict.values.length, 3);
    const decision = desktop.resolve(conflict, 'chosen');
    mobile.merge(decision);
    laptop.merge(decision);
    const restored = createEngine({ actor: 'restored', records: JSON.parse(JSON.stringify(laptop.getRecords())), diffChars });
    assert.equal(contentOf(mobile), 'chosen');
    assert.equal(contentOf(restored), 'chosen');
    assert.equal(restored.materialize().conflicts.length, 0);
});

test('simultaneous different resolutions reopen a conflict; stale dialog choices are rejected', () => {
    const { desktop, mobile } = paired();
    mobile.capture(snapshot('abc'), snapshot('ab'));
    desktop.merge(mobile.getRecords());
    const conflict = desktop.materialize().conflicts.find(item => item.field === 'content');
    const first = desktop.resolve(conflict, 'abc');
    const second = mobile.resolve(mobile.materialize().conflicts.find(item => item.field === 'content'), 'ab');
    desktop.merge(second);
    mobile.merge(first);
    assert.ok(desktop.materialize().conflicts.some(item => item.field === 'content'));
    assert.ok(mobile.materialize().conflicts.some(item => item.field === 'content'));
    assert.equal(desktop.resolve(conflict, 'old decision'), null);
});

test('duplicates and reordered delivery do not lose pending alternatives', () => {
    const { desktop, mobile } = paired();
    const base = structuredClone(desktop.getRecords());
    mobile.capture(snapshot('abc'), snapshot('ab'));
    const removal = structuredClone(mobile.getRecords());
    mobile.capture(snapshot('ab'), snapshot('abX'));
    const latest = structuredClone(mobile.getRecords());
    desktop.merge(latest);
    desktop.merge(base);
    desktop.merge(removal);
    desktop.merge(latest);
    const conflict = desktop.materialize().conflicts.find(item => item.field === 'content');
    assert.ok(conflict.values.includes('abc'));
    assert.ok(conflict.values.includes('abX'));
});

test('WebSocket relay acknowledges updates, isolates rooms and replays pending conflicts to a third peer', { timeout: 10000 }, async context => {
    const { server, wss } = createSyncServer();
    const clients = [];
    context.after(async () => {
        clients.forEach(client => client.terminate());
        await new Promise(resolve => wss.close(resolve));
        await new Promise(resolve => server.close(resolve));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = `ws://127.0.0.1:${server.address().port}/?room=`;
    async function connect(actor, room = 'shared') {
        const client = new WebSocket(url + room);
        const messages = [];
        const waiting = [];
        clients.push(client);
        client.on('message', raw => {
            const message = JSON.parse(raw.toString());
            messages.push(message);
            waiting.forEach(waiter => { if (waiter.predicate(message)) waiter.resolve(message); });
        });
        const receive = predicate => {
            const existing = messages.find(predicate);
            return existing ? Promise.resolve(existing) : new Promise(resolve => waiting.push({ predicate, resolve }));
        };
        await once(client, 'open');
        client.send(JSON.stringify({ _type: 'request_state', _sid: actor, _protocol: 2 }));
        const peers = await receive(message => message._type === 'peers');
        assert.equal(peers._protocol, 2);
        await receive(message => message._type === 'sync_capabilities');
        return { client, receive };
    }
    const { desktop, mobile } = paired();
    const first = await connect('desktop');
    const second = await connect('mobile');
    const send = (connection, engine, id) => connection.client.send(JSON.stringify({
        _type: 'sync_state', _protocol: 2, _sync: { records: engine.getRecords() }, _sid: id, _messageId: id
    }));
    send(first, desktop, 'initial');
    await first.receive(message => message._ack === 'initial');
    mobile.capture(snapshot('abc'), snapshot('ab'));
    send(second, mobile, 'removal');
    const acknowledged = await second.receive(message => message._ack === 'removal');
    desktop.merge(acknowledged._sync.records);
    assert.ok(desktop.materialize().conflicts.length);
    const third = await connect('laptop');
    const replay = await third.receive(message => message._sync && Object.keys(message._sync.records).length > 0);
    const laptop = peer('laptop');
    laptop.merge(replay._sync.records);
    assert.ok(laptop.materialize().conflicts.length);
    const other = await connect('other', 'isolated');
    const isolated = await other.receive(message => message._type === 'sync_state');
    assert.equal(Object.keys(isolated._sync.records).length, 0);
    const conflict = desktop.materialize().conflicts.find(item => item.field === 'content');
    desktop.resolve(conflict, 'abc');
    send(first, desktop, 'resolved');
    const resolution = await first.receive(message => message._ack === 'resolved');
    mobile.merge(resolution._sync.records);
    laptop.merge(resolution._sync.records);
    assert.equal(mobile.materialize().conflicts.length, 0);
    assert.equal(contentOf(laptop), 'abc');
});

test('deletion concurrent with an edit or new comment reopens deletion review', () => {
    for (const comment of [false, true]) {
        const { desktop, mobile } = paired();
        desktop.capture(snapshot('abc'), { cols: snapshot('abc').cols, cards: { TODO: [] }, scratch: '' });
        const deletion = desktop.materialize().conflicts.find(item => item.field === '__deleted');
        desktop.resolve(deletion, true);
        const edited = snapshot(comment ? 'abc' : 'abcd');
        if (comment) edited.cards.TODO[0].comments = [{ id: 'new-comment', text: 'Do not lose this' }];
        mobile.capture(snapshot('abc'), edited);
        desktop.merge(mobile.getRecords());
        mobile.merge(desktop.getRecords());
        assert.equal(desktop.materialize().cards.TODO.length, 1);
        assert.equal(mobile.materialize().cards.TODO.length, 1);
        const reopened = desktop.materialize().conflicts.find(item => item.field === '__deleted');
        assert.ok(reopened);
        const confirmed = desktop.resolve(reopened, true);
        mobile.merge(confirmed);
        assert.equal(mobile.materialize().cards.TODO.length, 0);
    }
});

test('shared board applies ordinary replacements, moves and deletions immediately without changing device-sync rules', () => {
    const host = createEngine({ actor: 'host', diffChars, collaborative: true });
    host.capture(empty(), snapshot('original'));
    const guest = createEngine({ actor: 'guest', diffChars, collaborative: true, records: host.getRecords() });
    guest.capture(snapshot('original'), snapshot('rewritten'));
    host.merge(guest.getRecords());
    assert.equal(contentOf(host), 'rewritten');
    assert.equal(host.materialize().conflicts.length, 0);
    const moved = { cols: [...snapshot('').cols, { id: 'DONE', label: 'Done' }],
        cards: { TODO: [], DONE: [{ id: 'card-a', task: 'Card A', content: 'rewritten' }] }, scratch: 'Shared notes' };
    guest.capture(guest.materialize(), moved);
    host.merge(guest.getRecords());
    assert.equal(host.materialize().cards.DONE[0].id, 'card-a');
    assert.equal(host.materialize().scratch, 'Shared notes');
    guest.capture(moved, { ...moved, cards: { TODO: [], DONE: [] } });
    host.merge(guest.getRecords());
    assert.equal(host.materialize().cards.DONE.length, 0);
    assert.equal(host.materialize().conflicts.length, 0);
});

test('shared board preserves simultaneous replacements and can restore an isolated personal board', () => {
    const { desktop, mobile } = paired();
    const original = desktop.getRecords();
    desktop.replace(original, true);
    mobile.replace(original, true);
    desktop.capture(snapshot('abc'), snapshot('first'));
    mobile.capture(snapshot('abc'), snapshot('second'));
    desktop.merge(mobile.getRecords());
    mobile.merge(desktop.getRecords());
    const conflict = desktop.materialize().conflicts.find(item => item.field === 'content');
    assert.deepEqual(new Set(conflict.values), new Set(['first', 'second']));
    const decision = desktop.resolve(conflict, 'together');
    mobile.merge(decision);
    assert.equal(contentOf(mobile), 'together');
    desktop.replace(original);
    assert.equal(contentOf(desktop), 'abc');
    desktop.capture(snapshot('abc'), snapshot('ab'));
    assert.ok(desktop.materialize().conflicts.length);
    desktop.replace({}, true);
    assert.deepEqual(desktop.materialize(), { ...empty(), scratchTabs: [], conflicts: [] });
    assert.throws(() => desktop.replace({ invalid: {} }), /Invalid sync records/);
});

test('Scratch tabs migrate legacy notes, merge independent tabs and retain personal tabs after collaboration', () => {
    const desktop = peer('desktop');
    desktop.capture(empty(), { ...snapshot('abc'), scratch: 'Legacy notes' });
    assert.equal(desktop.materialize().scratch, 'Legacy notes');
    assert.deepEqual(desktop.materialize().scratchTabs, []);
    const original = desktop.getRecords();
    const mobile = peer('mobile');
    mobile.merge(original);
    const before = desktop.materialize();
    desktop.capture(before, { ...before, scratchTabs: [{ id: 'a', label: 'Laptop', content: 'First note' }] });
    mobile.capture(before, { ...before, scratchTabs: [{ id: 'b', label: 'Phone', content: 'Second note' }] });
    desktop.merge(mobile.getRecords());
    mobile.merge(desktop.getRecords());
    assert.deepEqual(desktop.materialize().scratchTabs, mobile.materialize().scratchTabs);
    assert.deepEqual(new Set(desktop.materialize().scratchTabs.map(tab => tab.id)), new Set(['a', 'b']));
    assert.equal(desktop.materialize().scratch, 'Legacy notes');
    assert.equal(desktop.materialize().conflicts.length, 0);
    desktop.replace(original, true);
    assert.deepEqual(desktop.materialize().scratchTabs, []);
    assert.equal(desktop.materialize().scratch, 'Legacy notes');
});

test('Scratch tab edits and deletion follow collaboration and Device Sync conflict rules', () => {
    const laptop = peer('laptop');
    const initial = { ...empty(), scratchTabs: [{ id: 'a', label: 'Notes', content: 'abc' }] };
    laptop.capture(empty(), initial);
    const original = laptop.getRecords();
    laptop.replace(original, true);
    const phone = createEngine({ actor: 'phone', records: original, collaborative: true, diffChars });
    laptop.capture(initial, { ...initial, scratchTabs: [{ id: 'a', label: 'Work', content: 'first' }] });
    phone.capture(initial, { ...initial, scratchTabs: [{ id: 'a', label: 'Notes', content: 'second' }] });
    laptop.merge(phone.getRecords());
    const conflict = laptop.materialize().conflicts.find(item => item.entity === 'scratchTab' && item.field === 'content');
    assert.ok(conflict);
    const resolved = laptop.resolve(conflict, 'agreed');
    phone.merge(laptop.getRecords());
    assert.ok(resolved);
    assert.equal(phone.materialize().scratchTabs[0].content, 'agreed');
    assert.equal(phone.materialize().scratchTabs[0].label, 'Work');
    const before = phone.materialize();
    phone.capture(before, { ...before, scratchTabs: [] });
    laptop.merge(phone.getRecords());
    assert.deepEqual(laptop.materialize().scratchTabs, []);
    laptop.replace(original);
    laptop.capture(initial, { ...initial, scratchTabs: [] });
    const deletion = laptop.materialize().conflicts.find(item => item.entity === 'scratchTab' && item.field === '__deleted');
    assert.ok(deletion);
    laptop.resolve(deletion, true);
    assert.deepEqual(laptop.materialize().scratchTabs, []);
});

test('ordinary Scratch tab renames, replacements and closes persist across reload without artificial conflicts', () => {
    const engine = peer('writer');
    const initial = { ...empty(), scratch: 'Original text', scratchTabs: [{ id: 'tab', label: 'Untitled', content: 'abc' }] };
    engine.capture(empty(), initial);
    const edited = { ...initial, scratch: 'Replaced text', scratchTabs: [{ id: 'tab', label: 'Work notes', content: 'Replaced tab text' }] };
    engine.capture(initial, edited, { reviewScratch: false });
    const reloaded = createEngine({ actor: 'new-session', records: engine.getRecords(), diffChars });
    assert.equal(reloaded.materialize().scratch, 'Replaced text');
    assert.equal(reloaded.materialize().scratchTabs[0].label, 'Work notes');
    assert.equal(reloaded.materialize().scratchTabs[0].content, 'Replaced tab text');
    assert.equal(reloaded.materialize().conflicts.length, 0);
    reloaded.capture(edited, { ...edited, scratchTabs: [] }, { reviewScratch: false });
    assert.deepEqual(reloaded.materialize().scratchTabs, []);
});

    test('Device Sync stages conflicts, rejects stale commits and confirms only after every device saves', { timeout: 10000 }, async context => {
        const { connect } = await deviceRoom(context);
        const laptop = await connect('laptop');
        const mobile = await connect('mobile');
        const { desktop, mobile: phoneEngine } = paired();
        phoneEngine.capture(snapshot('abc'), snapshot('different value'));
        const publish = async (client, engine, id) => {
            client.send({ _protocol: 2, _sync: { records: engine.getRecords() }, _messageId: id });
            return client.receive(message => message._ack === id);
        };
        const first = await publish(laptop, desktop, 'initial');
        const merged = await publish(mobile, phoneEngine, 'conflicting');
        laptop.send({ _type: 'device_commit_request', revision: merged._revision, records: merged._sync.records });
        assert.match((await laptop.receive(message => message._type === 'sync_error')).message, /Resolve all conflicts/);
        desktop.merge(merged._sync.records);
        const conflict = desktop.materialize().conflicts.find(item => item.field === 'content');
        desktop.resolve(conflict, 'Agreed on laptop and mobile');
        const resolved = await publish(laptop, desktop, 'resolved-final');
        laptop.send({ _type: 'device_commit_request', revision: first._revision, records: first._sync.records });
        assert.match((await laptop.receive(message => message._type === 'sync_error')).message, /preview changed/);
        laptop.send({ _type: 'device_commit_request', revision: resolved._revision, records: resolved._sync.records });
        const prepare = await laptop.receive(message => message._type === 'device_commit_prepare');
        assert.equal((await mobile.receive(message => message._type === 'device_commit_prepare')).id, prepare.id);
        laptop.send({ _type: 'device_commit_ready', id: prepare.id });
        mobile.send({ _type: 'device_commit_ready', id: prepare.id });
        const apply = await laptop.receive(message => message._type === 'device_commit_apply');
        const phoneApply = await mobile.receive(message => message._type === 'device_commit_apply');
        assert.deepEqual(apply.records, phoneApply.records);
        phoneEngine.replace(phoneApply.records);
        assert.equal(contentOf(phoneEngine), 'Agreed on laptop and mobile');
        laptop.send({ _type: 'device_commit_applied', id: prepare.id });
        const partial = await mobile.receive(message => message._type === 'device_commit_status' && message.applied === 1);
        assert.equal(partial.phase, 'applying');
        mobile.send({ _type: 'device_commit_applied', id: prepare.id });
        const complete = await laptop.receive(message => message._type === 'device_commit_status' && message.phase === 'complete');
        assert.equal(complete.expected, 2);
        assert.equal(complete.applied, 2);
        await mobile.receive(message => message._type === 'device_commit_status' && message.phase === 'complete');
    });

    test('Device Sync cancels preparation on new edits or disconnect and reports failed persistence honestly', { timeout: 10000 }, async context => {
        const { connect } = await deviceRoom(context);
        const laptop = await connect('laptop');
        const mobile = await connect('mobile');
        const engine = peer('laptop');
        engine.capture(empty(), snapshot('base'));
        laptop.send({ _protocol: 2, _sync: { records: engine.getRecords() }, _messageId: 'base' });
        let update = await laptop.receive(message => message._ack === 'base');
        const request = () => laptop.send({ _type: 'device_commit_request', revision: update._revision, records: update._sync.records });
        request();
        let prepare = await laptop.receive(message => message._type === 'device_commit_prepare');
        engine.capture(snapshot('base'), snapshot('base plus unsent edit'));
        mobile.send({ _protocol: 2, _sync: { records: engine.getRecords() }, _messageId: 'new-edit' });
        assert.match((await laptop.receive(message => message._type === 'device_commit_status' && message.phase === 'aborted')).error, /preview changed/);
        update = await mobile.receive(message => message._ack === 'new-edit');
        request();
        prepare = await laptop.receive(message => message._type === 'device_commit_prepare');
        const closed = once(mobile.client, 'close');
        mobile.client.close();
        await closed;
        assert.match((await laptop.receive(message => message._type === 'device_commit_status' && message.phase === 'aborted')).error, /disconnected/);
        const replacement = await connect('mobile-reconnected');
        request();
        prepare = await laptop.receive(message => message._type === 'device_commit_prepare');
        await replacement.receive(message => message._type === 'device_commit_prepare');
        laptop.send({ _type: 'device_commit_ready', id: prepare.id });
        replacement.send({ _type: 'device_commit_ready', id: prepare.id });
        await laptop.receive(message => message._type === 'device_commit_apply');
        laptop.send({ _type: 'device_commit_applied', id: prepare.id });
        replacement.send({ _type: 'device_commit_reject', id: prepare.id });
        const incomplete = await laptop.receive(message => message._type === 'device_commit_status' && message.phase === 'incomplete');
        assert.match(incomplete.error, /could not accept or save/);
        assert.equal(incomplete.applied, 1);
        assert.equal(incomplete.expected, 2);
    });

    test('Device Sync requires two devices and cannot be joined as collaboration or legacy auto-sync', { timeout: 10000 }, async context => {
        const { connect } = await deviceRoom(context);
        const laptop = await connect('laptop');
        laptop.send({ _type: 'device_commit_request', revision: 0, records: {} });
        assert.match((await laptop.receive(message => message._type === 'sync_error')).message, /at least two/);
        for (const mode of ['collaborate', 'legacy']) {
            const incompatible = await connect('incompatible', mode);
            const error = await incompatible.receive(message => message._type === 'sync_error');
            assert.equal(error.fatal, true);
            assert.match(error.message, /different sharing mode/);
        }
    });
test('shared relay hosts, joins, tracks presence, replays edits and survives all clients leaving', { timeout: 10000 }, async context => {
    const { server, wss } = createSyncServer();
    const clients = [];
    context.after(async () => {
        clients.forEach(client => client.terminate());
        await new Promise(resolve => wss.close(resolve));
        await new Promise(resolve => server.close(resolve));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const frontend = await fetch(base);
    assert.equal(frontend.status, 200);
    assert.match(await frontend.text(), /window\.DAILY_RELAY/);
    assert.match(await (await fetch(base + '/sync-engine.js')).text(), /createEngine/);
    async function connect(id, { host = false, room = 'board-live', records } = {}) {
        const client = new WebSocket(base.replace('http:', 'ws:') + `/?room=${room}&mode=collaborate${host ? '&host=1' : ''}`);
        clients.push(client);
        const messages = [];
        const waiters = [];
        client.on('message', raw => {
            const message = JSON.parse(raw.toString());
            messages.push(message);
            waiters.forEach(waiter => { if (waiter.predicate(message)) waiter.resolve(message); });
        });
        const receive = predicate => {
            const existing = messages.find(predicate);
            return existing ? Promise.resolve(existing) : new Promise(resolve => waiters.push({ predicate, resolve }));
        };
        await once(client, 'open');
        if (room !== 'missing') client.send(JSON.stringify({ _type: 'request_state', _sid: id, name: id,
            ...(records ? { _sync: { records } } : {}) }));
        return { client, receive };
    }
    const hostEngine = createEngine({ actor: 'host', diffChars, collaborative: true });
    hostEngine.capture(empty(), snapshot('Host board'));
    const host = await connect('host', { host: true, records: hostEngine.getRecords() });
    assert.equal((await host.receive(message => message._type === 'sync_capabilities')).collaborative, true);
    const guest = await connect('guest');
    const initial = await guest.receive(message => message.initial);
    const guestEngine = createEngine({ actor: 'guest', diffChars, collaborative: true, records: initial._sync.records });
    assert.equal(contentOf(guestEngine), 'Host board');
    const third = await connect('third');
    assert.ok((await third.receive(message => message._type === 'peers' && message.peers.length === 3))
        .participants.some(person => person.name === 'host' && person.host));
    guest.client.send(JSON.stringify({ _type: 'presence', _sid: 'guest', cardId: 'card-a', name: 'Writer' }));
    await host.receive(message => message.participants?.some(person => person.name === 'Writer' && person.cardId === 'card-a'));
    const cursor = { anchor: 'card:card-a', x: 0.25, y: 0.6 };
    const recordsBeforeCursor = JSON.stringify(initial._sync.records);
    guest.client.send(JSON.stringify({ _type: 'cursor', _sid: 'spoofed', cursor }));
    const pointer = await host.receive(message => message._type === 'cursor' && message.cursor?.x === 0.25);
    assert.equal(pointer.id, 'guest', 'Cursor identity comes from the registered socket');
    assert.deepEqual(pointer.cursor, cursor);
    assert.deepEqual((await third.receive(message => message._type === 'cursor' && message.cursor?.x === 0.25)).cursor, cursor);
    guest.client.send(JSON.stringify({ _type: 'cursor', cursor: { anchor: 'board', x: -1, y: 0 } }));
    assert.equal((await guest.receive(message => message._type === 'sync_error')).message, 'Invalid cursor position');
    guest.client.send(JSON.stringify({ _type: 'cursor', cursor: null }));
    await host.receive(message => message._type === 'cursor' && message.cursor === null);
    const replayDuringPresence = await connect('cursor-observer');
    assert.equal(JSON.stringify((await replayDuringPresence.receive(message => message.initial))._sync.records), recordsBeforeCursor);
    assert.equal((await replayDuringPresence.receive(message => message._type === 'peers')).participants
        .some(person => Object.hasOwn(person, 'cursor')), false, 'Cursor positions are not retained');
    replayDuringPresence.client.close();
    guestEngine.capture(snapshot('Host board'), snapshot('Guest is typing'));
    const sentAt = Date.now();
    guest.client.send(JSON.stringify({ _protocol: 2, _sync: { records: guestEngine.getRecords() }, _messageId: 'typed' }));
    const update = await third.receive(message => message._sync?.records
        && JSON.stringify(message._sync.records).includes('Guest is typing'));
    assert.ok(Date.now() - sentAt < 2000, 'Live updates must arrive without polling');
    hostEngine.merge(update._sync.records);
    assert.equal(contentOf(hostEngine), 'Guest is typing');
    assert.equal(hostEngine.materialize().conflicts.length, 0);
    await guest.receive(message => message._ack === 'typed');
    const missing = await connect('missing', { room: 'missing' });
    assert.equal((await missing.receive(message => message._type === 'sync_error')).fatal, true);
    const closures = [host, guest, third].map(connection => {
        const closed = once(connection.client, 'close');
        connection.client.close();
        return closed;
    });
    await Promise.all(closures);
    const returning = await connect('returning');
    const replay = await returning.receive(message => message.initial);
    const restored = createEngine({ actor: 'returning', diffChars, collaborative: true, records: replay._sync.records });
    assert.equal(contentOf(restored), 'Guest is typing');
    const hostReturning = await connect('new-host-session', { host: true, records: hostEngine.getRecords() });
    const peers = await hostReturning.receive(message => message.participants?.some(person => person.id === 'new-host-session' && person.host));
    assert.equal(peers.host, 'new-host-session');
});

test('new participants invalidate preparation and cannot join midway through saving', { timeout: 10000 }, async context => {
    const { connect } = await deviceRoom(context);
    const first = await connect('first');
    const second = await connect('second');
    first.send({ _type: 'device_commit_request', revision: 0, records: {} });
    await first.receive(message => message._type === 'device_commit_prepare');
    const third = await connect('third');
    const aborted = await first.receive(message => message._type === 'device_commit_status' && message.phase === 'aborted');
    assert.match(aborted.error, /device joined/);
    first.send({ _type: 'device_commit_request', revision: 0, records: {} });
    const prepare = await first.receive(message => message._type === 'device_commit_prepare');
    for (const connection of [first, second, third]) {
        connection.send({ _type: 'device_commit_ready', id: prepare.id });
    }
    await first.receive(message => message._type === 'device_commit_apply');
    const late = await connect('late', 'device', false);
    const error = await late.receive(message => message._type === 'sync_error');
    assert.equal(error.fatal, true);
    assert.match(error.message, /Join again after/);
    for (const connection of [first, second, third]) {
        connection.send({ _type: 'device_commit_applied', id: prepare.id });
    }
    const complete = await first.receive(message => message._type === 'device_commit_status' && message.phase === 'complete');
    assert.equal(complete.expected, 3);
    assert.equal(complete.applied, 3);
});