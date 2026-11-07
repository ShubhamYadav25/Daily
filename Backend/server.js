const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { mergeRecords, validRecords, recordsEqual, createEngine } = require('../sync-engine');
const { diffChars } = require('diff');
const { randomUUID } = require('crypto');

function createSyncServer() {
    const server = http.createServer((request, response) => {
        const pathname = new URL(request.url, 'http://localhost').pathname;
        const assets = { '/': 'index.html', '/index.html': 'index.html', '/sync-engine.js': 'sync-engine.js',
            '/pdf-editor.js': 'pdf-editor.js', '/pdf-editor.css': 'pdf-editor.css', '/pdf-unlock-worker.js': 'pdf-unlock-worker.js',
            '/daily-icon.png': 'daily-icon.png' };
        if (assets[pathname] && request.method === 'GET') {
            const type = pathname.endsWith('.js') ? 'text/javascript' : pathname.endsWith('.css') ? 'text/css' : pathname.endsWith('.png') ? 'image/png' : 'text/html';
            fs.readFile(path.join(__dirname, '..', assets[pathname]), (error, data) => {
                response.writeHead(error ? 500 : 200, { 'Content-Type': error ? 'text/plain' : type });
                response.end(error ? 'Unable to load Daily app' : type === 'text/html'
                    ? data.toString().replace('<head>', '<head><script>window.DAILY_RELAY = location.origin.replace(/^http/, "ws");</script>') : data);
                if (error) console.error('Unable to serve Daily asset', error);
            });
            return;
        }
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ service: 'daily-sync', protocol: 2 }));
    });
    const wss = new WebSocket.Server({ server, maxPayload: 16 * 1024 * 1024 });
    const rooms = new Map();

    function send(client, message) {
        if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message));
    }

    function broadcastPeers(room) {
        const peers = [...room.clients.values()].filter(Boolean);
        const participants = [...room.clients.entries()].filter(([, sid]) => sid).map(([client, sid]) => ({
            id: sid, name: client.displayName || 'Guest', host: sid === room.host,
            cardId: client.cardId || null
        }));
        room.clients.forEach((sid, client) => send(client, { _type: 'peers', _protocol: 2, peers, participants,
            host: room.host || null, collaborative: !!room.collaborative }));
    }

    function commitStatus(room, error) {
        const commit = room.commit;
        if (!commit) return;
        if (error) commit.error = error;
        commit.members.forEach(client => send(client, {
            _type: 'device_commit_status', id: commit.id, phase: commit.phase,
            expected: commit.members.size, applied: commit.applied.size, error: commit.error || null
        }));
    }

    function failCommit(room, reason) {
        if (!room.commit || !['preparing', 'applying'].includes(room.commit.phase)) return;
        clearTimeout(room.commit.timer);
        room.commit.phase = room.commit.phase === 'applying' ? 'incomplete' : 'aborted';
        commitStatus(room, reason);
    }

    wss.on('connection', (ws, request) => {
        const params = new URL(request.url, 'http://localhost').searchParams;
        const roomId = params.get('room');
        const collaborative = params.get('mode') === 'collaborate';
        const deviceSync = params.get('mode') === 'device';
        if (!roomId || roomId.length > 128) {
            ws.close(1008, 'Room ID required');
            return;
        }
        if (collaborative && !rooms.has(roomId) && params.get('host') !== '1') {
            send(ws, { _type: 'sync_error', fatal: true, message: 'This shared board is unavailable. Ask the host to start it again.' });
            ws.close(1008, 'Shared board unavailable');
            return;
        }
        if (!rooms.has(roomId)) rooms.set(roomId, { clients: new Map(), records: {}, collaborative, deviceSync,
            revision: 0, host: null });
        const room = rooms.get(roomId);
        if (!!room.collaborative !== collaborative || !!room.deviceSync !== deviceSync) {
            send(ws, { _type: 'sync_error', fatal: true, message: 'This room uses a different sharing mode.' });
            ws.close(1008, 'Room mode mismatch');
            return;
        }
        if (deviceSync && room.commit?.phase === 'applying') {
            send(ws, { _type: 'sync_error', fatal: true, message: 'A final commit is being saved. Join again after it completes.' });
            ws.close(1008, 'Final commit in progress');
            return;
        }
        if (deviceSync && room.commit?.phase === 'preparing') {
            failCommit(room, 'A device joined. Review the updated participants and commit again.');
        }
        room.clients.set(ws, null);
        ws.isAlive = true;
        ws.on('pong', () => ws.isAlive = true);

        ws.on('message', raw => {
            let message;
            try { message = JSON.parse(raw.toString()); } catch {
                send(ws, { _type: 'sync_error', message: 'Invalid JSON message' });
                return;
            }
            if (!message || typeof message !== 'object') {
                send(ws, { _type: 'sync_error', message: 'Invalid message' });
                return;
            }
            if (message._type === 'request_state' && collaborative && !room.host) {
                if (params.get('host') !== '1' || !validRecords(message._sync?.records) || typeof message._sid !== 'string') {
                    send(ws, { _type: 'sync_error', fatal: true, message: 'The host must provide a valid board.' });
                    ws.close(1008, 'Invalid host board');
                    return;
                }
                room.host = message._sid;
                room.records = message._sync.records;
            }
            if (message._type === 'request_state' && collaborative && params.get('host') === '1'
                && ![...room.clients.values()].includes(room.host) && typeof message._sid === 'string') {
                room.host = message._sid;
            }
            if (typeof message.name === 'string') ws.displayName = message.name.trim().slice(0, 40) || 'Guest';
            if (message._type !== 'cursor' && typeof message._sid === 'string' && room.clients.get(ws) !== message._sid) {
                room.clients.set(ws, message._sid);
                broadcastPeers(room);
            }
            if (message._type === 'request_state') {
                if (deviceSync && message.deviceCommit !== 1) {
                    send(ws, { _type: 'sync_error', fatal: true, message: 'Update this device to use explicit final commits.' });
                    ws.close(1008, 'Device commit support required');
                    return;
                }
                send(ws, { _type: 'sync_capabilities', protocol: 2, collaborative: !!room.collaborative, deviceCommit: deviceSync ? 1 : undefined });
                send(ws, { _type: 'sync_state', _protocol: 2, initial: true, _revision: room.revision, _sync: { records: room.records } });
                room.clients.forEach((sid, client) => {
                    if (client !== ws && !collaborative) send(client, message);
                });
                return;
            }
            if (deviceSync && message._type === 'device_commit_request') {
                if (['preparing', 'applying'].includes(room.commit?.phase)) {
                    send(ws, { _type: 'sync_error', message: 'A final commit is already in progress.' });
                    return;
                }
                if (room.clients.size < 2 || [...room.clients.values()].some(sid => !sid)) {
                    send(ws, { _type: 'sync_error', message: 'Connect at least two ready devices before committing.' });
                    return;
                }
                if (message.revision !== room.revision || !validRecords(message.records) || !recordsEqual(message.records, room.records)) {
                    send(ws, { _type: 'sync_error', message: 'The preview changed. Wait for sync, review it and commit again.' });
                    return;
                }
                const engine = createEngine({ actor: 'relay-review', records: room.records, diffChars });
                if (engine.materialize().conflicts.length) {
                    send(ws, { _type: 'sync_error', message: 'Resolve all conflicts before committing the final board.' });
                    return;
                }
                room.commit = { id: randomUUID(), phase: 'preparing', records: room.records,
                    members: new Set(room.clients.keys()), prepared: new Set(), applied: new Set() };
                const commit = room.commit;
                commit.timer = setTimeout(() => failCommit(room, 'Some devices did not confirm the final commit. Reconnect them and retry.'), 15000);
                commit.timer.unref();
                commitStatus(room);
                commit.members.forEach(client => send(client, { _type: 'device_commit_prepare', id: commit.id,
                    records: commit.records, revision: room.revision }));
                return;
            }
            if (deviceSync && ['device_commit_ready', 'device_commit_applied', 'device_commit_reject'].includes(message._type)) {
                const commit = room.commit;
                if (!commit || message.id !== commit.id || !commit.members.has(ws)) return;
                if (message._type === 'device_commit_reject') {
                    failCommit(room, 'A device could not accept or save this board. Its original data is preserved; review and retry.');
                } else if (message._type === 'device_commit_ready' && commit.phase === 'preparing') {
                    commit.prepared.add(ws);
                    if (commit.prepared.size === commit.members.size) {
                        commit.phase = 'applying';
                        commitStatus(room);
                        commit.members.forEach(client => send(client, { _type: 'device_commit_apply', id: commit.id,
                            records: commit.records }));
                    }
                } else if (message._type === 'device_commit_applied' && ['applying', 'incomplete'].includes(commit.phase)) {
                    commit.applied.add(ws);
                    if (commit.applied.size === commit.members.size) {
                        const unchanged = recordsEqual(commit.records, room.records);
                        commit.phase = unchanged ? 'complete' : 'incomplete';
                        commit.error = unchanged ? null : 'Devices saved the previous commit, but the preview changed. Review and commit the new preview again.';
                        clearTimeout(commit.timer);
                    }
                    commitStatus(room);
                }
                return;
            }
            if (message._type === 'presence' && collaborative) {
                ws.cardId = typeof message.cardId === 'string' ? message.cardId.slice(0, 128) : null;
                broadcastPeers(room);
                return;
            }
            if (message._type === 'cursor' && collaborative) {
                const id = room.clients.get(ws);
                const cursor = message.cursor;
                if (!id || (cursor !== null && (!cursor || typeof cursor.anchor !== 'string'
                    || cursor.anchor.length > 160 || !Number.isFinite(cursor.x) || !Number.isFinite(cursor.y)
                    || cursor.x < 0 || cursor.x > 1 || cursor.y < 0 || cursor.y > 1))) {
                    send(ws, { _type: 'sync_error', message: 'Invalid cursor position' });
                    return;
                }
                room.clients.forEach((sid, client) => {
                    if (client !== ws) send(client, { _type: 'cursor', id, cursor });
                });
                return;
            }
            if (message._protocol === 2 && message._sync) {
                if (!validRecords(message._sync.records)) {
                    send(ws, { _type: 'sync_error', message: 'Invalid sync records' });
                    return;
                }
                const merged = mergeRecords(room.records, message._sync.records);
                if (deviceSync && !recordsEqual(merged, room.records)) {
                    if (room.commit?.phase === 'applying') {
                        send(ws, { _type: 'sync_error', message: 'Wait for the final commit to finish before changing the preview.' });
                        return;
                    }
                    failCommit(room, 'The preview changed during confirmation. Review and commit again.');
                    room.revision++;
                }
                room.records = merged;
                room.clients.forEach((sid, client) => send(client, {
                    _type: 'sync_state', _protocol: 2, _revision: room.revision, _sync: { records: room.records },
                    _ack: client === ws ? message._messageId : undefined
                }));
                return;
            }
            if (message._cols || message._cards || message._scratch !== undefined) {
                room.clients.forEach((sid, client) => {
                    if (client !== ws) send(client, message);
                });
            }
        });

        ws.on('error', () => ws.terminate());
        ws.on('close', () => {
            if (room.commit?.members.has(ws)) failCommit(room, 'A device disconnected. The final board is not confirmed on every device. Reconnect and retry.');
            room.clients.delete(ws);
            broadcastPeers(room);
            if (!room.clients.size && !room.collaborative && !room.deviceSync) rooms.delete(roomId);
        });
    });

    const heartbeat = setInterval(() => {
        wss.clients.forEach(client => {
            if (!client.isAlive) return client.terminate();
            client.isAlive = false;
            client.ping();
        });
    }, 30000);
    heartbeat.unref();
    wss.on('close', () => {
        clearInterval(heartbeat);
        rooms.forEach(room => clearTimeout(room.commit?.timer));
    });
    return { server, wss, rooms };
}

if (require.main === module) {
    const { server } = createSyncServer();
    const port = process.env.PORT || 8080;
    server.listen(port, () => {
        console.log(`Sync server running on port ${port}`);
    });
}

module.exports = { createSyncServer };
