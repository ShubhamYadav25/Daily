const test = require('node:test');
const assert = require('node:assert/strict');
const { diffChars } = require('diff');
const { createEngine } = require('../sync-engine');
const WebSocket = require('ws');
const { once } = require('node:events');
const { createSyncServer } = require('./server');

const empty = () => ({ cols: [], cards: {}, scratch: '' });
const snapshot = content => ({ cols: [{ id: 'TODO', label: 'Todo' }], cards: { TODO: [{ id: 'card-a', task: 'Card A', content }] }, scratch: '' });
const peer = actor => createEngine({ actor, diffChars });
const contentOf = engine => engine.materialize().cards.TODO[0].content;
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