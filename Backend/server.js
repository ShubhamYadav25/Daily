const WebSocket = require('ws');
const http = require('http');
const { mergeRecords, validRecords } = require('../sync-engine');

function createSyncServer() {
    const server = http.createServer((request, response) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ service: 'daily-sync', protocol: 2 }));
    });
    const wss = new WebSocket.Server({ server });
    const rooms = new Map();

    function send(client, message) {
        if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message));
    }

    function broadcastPeers(room) {
        const peers = [...room.clients.values()].filter(Boolean);
        room.clients.forEach((sid, client) => send(client, { _type: 'peers', _protocol: 2, peers }));
    }

    wss.on('connection', (ws, request) => {
        const roomId = new URL(request.url, `http://${request.headers.host}`).searchParams.get('room');
        if (!roomId) {
            ws.close(1008, 'Room ID required');
            return;
        }
        if (!rooms.has(roomId)) rooms.set(roomId, { clients: new Map(), records: {} });
        const room = rooms.get(roomId);
        room.clients.set(ws, null);
        ws.isAlive = true;
        ws.on('pong', () => ws.isAlive = true);

        ws.on('message', raw => {
            let message;
            try { message = JSON.parse(raw.toString()); } catch { return; }
            if (!message || typeof message !== 'object') return;
            if (typeof message._sid === 'string' && room.clients.get(ws) !== message._sid) {
                room.clients.set(ws, message._sid);
                broadcastPeers(room);
            }
            if (message._type === 'request_state') {
                send(ws, { _type: 'sync_capabilities', protocol: 2 });
                send(ws, { _type: 'sync_state', _protocol: 2, _sync: { records: room.records } });
                room.clients.forEach((sid, client) => {
                    if (client !== ws) send(client, message);
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
            if (!room.clients.size) rooms.delete(roomId);
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
