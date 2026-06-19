const WebSocket = require('ws');
const http = require('http');

const server = http.createServer();
const wss = new WebSocket.Server({ server });

// rooms: roomId -> { clients: Map(ws -> sid), peers: Set(sid) }
const rooms = new Map();

function broadcastPeers(roomId) {
    const room = rooms.get(roomId);
    if (!room) return;
    const peerSids = Array.from(room.clients.values());
    const message = JSON.stringify({ _type: 'peers', peers: peerSids });
    for (const client of room.clients.keys()) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    }
}

wss.on('connection', (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const roomId = url.searchParams.get('room');

    if (!roomId) {
        ws.close(1008, 'Room ID required');
        return;
    }

    if (!rooms.has(roomId)) {
        rooms.set(roomId, { clients: new Map(), peers: new Set() });
    }
    const room = rooms.get(roomId);

    let sid = null;

    ws.on('message', (message) => {
        const data = message.toString();
          console.log(`[${roomId}] Received:`, data);
        let parsed;
        try { parsed = JSON.parse(data); } catch { return; }

        // Store the sid on the first message that contains it
        if (!sid && parsed._sid) {
            sid = parsed._sid;
            room.clients.set(ws, sid);
            room.peers.add(sid);
            broadcastPeers(roomId);
            console.log(`[${roomId}] Client ${sid} joined (${room.clients.size} total)`);
        }

        // Handle request_state: forward to all other clients
        if (parsed._type === 'request_state') {
            const requestMsg = JSON.stringify({ _type: 'request_state', _sid: sid });
            for (const client of room.clients.keys()) {
                if (client !== ws && client.readyState === WebSocket.OPEN) {
                    client.send(requestMsg);
                }
            }
            return;
        }

        // Forward any state update (has _cols, _cards, or _scratch) to all others
        if (parsed._cols || parsed._cards || parsed._scratch !== undefined) {
            for (const client of room.clients.keys()) {
                if (client !== ws && client.readyState === WebSocket.OPEN) {
                    client.send(data);
                }
            }
        }
    });

    ws.on('close', () => {
        if (sid) {
            room.clients.delete(ws);
            room.peers.delete(sid);
            broadcastPeers(roomId);
            console.log(`[${roomId}] Client ${sid} disconnected (${room.clients.size} remaining)`);
        }
        if (room.clients.size === 0) {
            rooms.delete(roomId);
        }
    });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`✅ Sync server running on ws://localhost:${PORT}`);
});