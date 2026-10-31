const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { mergeRecords, validRecords } = require('../sync-engine');

function createSyncServer() {
    const server = http.createServer((request, response) => {
        const pathname = new URL(request.url, 'http://localhost').pathname;
        const assets = { '/': 'index.html', '/index.html': 'index.html', '/sync-engine.js': 'sync-engine.js',
            '/daily-icon.png': 'daily-icon.png' };
        if (assets[pathname] && request.method === 'GET') {
            const type = pathname.endsWith('.js') ? 'text/javascript' : pathname.endsWith('.png') ? 'image/png' : 'text/html';
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

    wss.on('connection', (ws, request) => {
        const params = new URL(request.url, 'http://localhost').searchParams;
        const roomId = params.get('room');
        const collaborative = params.get('mode') === 'collaborate';
        if (!roomId || roomId.length > 128) {
            ws.close(1008, 'Room ID required');
            return;
        }
        if (collaborative && !rooms.has(roomId) && params.get('host') !== '1') {
            send(ws, { _type: 'sync_error', fatal: true, message: 'This shared board is unavailable. Ask the host to start it again.' });
            ws.close(1008, 'Shared board unavailable');
            return;
        }
        if (!rooms.has(roomId)) rooms.set(roomId, { clients: new Map(), records: {}, collaborative, host: null });
        const room = rooms.get(roomId);
        if (!!room.collaborative !== collaborative) {
            send(ws, { _type: 'sync_error', fatal: true, message: 'This room uses a different sharing mode.' });
            ws.close(1008, 'Room mode mismatch');
            return;
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
                send(ws, { _type: 'sync_capabilities', protocol: 2, collaborative: !!room.collaborative });
                send(ws, { _type: 'sync_state', _protocol: 2, initial: true, _sync: { records: room.records } });
                room.clients.forEach((sid, client) => {
                    if (client !== ws && !collaborative) send(client, message);
                });
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
                room.records = mergeRecords(room.records, message._sync.records);
                room.clients.forEach((sid, client) => send(client, {
                    _type: 'sync_state', _protocol: 2, _sync: { records: room.records },
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
            room.clients.delete(ws);
            broadcastPeers(room);
            if (!room.clients.size && !room.collaborative) rooms.delete(roomId);
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
    wss.on('close', () => clearInterval(heartbeat));
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
