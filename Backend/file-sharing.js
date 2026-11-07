const { createHmac, timingSafeEqual } = require('crypto');
const WebSocket = require('ws');

function iceConfiguration() {
    const iceServers = [{ urls: process.env.FILE_SHARE_STUN_URL || 'stun:stun.l.google.com:19302' }];
    const urls = (process.env.FILE_SHARE_TURN_URLS || '').split(',').map(url => url.trim()).filter(Boolean);
    if (urls.length && process.env.FILE_SHARE_TURN_SECRET) {
        const username = `${Math.floor(Date.now() / 1000) + 3600}:daily`;
        iceServers.push({
            urls, username,
            credential: createHmac('sha1', process.env.FILE_SHARE_TURN_SECRET).update(username).digest('base64')
        });
    }
    return { iceServers, relayAvailable: iceServers.length > 1 };
}

function createFileSharing() {
    const rooms = new Map();
    const uuid = /^[a-f0-9-]{36}$/i;
    const secretPattern = /^[a-f0-9]{64}$/;
    const send = (ws, message) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    };
    const announce = room => {
        const peers = [...room.peers.entries()].map(([id, ws]) => ({ id, name: ws.fileShareName }));
        room.peers.forEach(ws => send(ws, { type: 'peers', peers }));
    };
    const expire = () => {
        const now = Date.now();
        rooms.forEach((room, id) => {
            if (!room.peers.size && now - room.lastUsed > 24 * 60 * 60 * 1000) rooms.delete(id);
        });
    };
    const timer = setInterval(expire, 60000);
    timer.unref();

    function connect(ws, request) {
        const query = new URL(request.url, 'http://localhost').searchParams;
        const id = query.get('room'), key = query.get('key'), peer = query.get('peer');
        ws.isAlive = true;
        ws.on('pong', () => { ws.isAlive = true; });
        ws.on('error', error => {
            console.error('File-sharing signaling connection failed:', error.message);
            ws.terminate();
        });
        if (!uuid.test(id || '') || !uuid.test(peer || '') || !secretPattern.test(key || '')) {
            ws.close(1008, 'Invalid file-sharing invitation');
            return;
        }
        expire();
        if (!rooms.has(id)) {
            if (rooms.size >= 200) {
                ws.close(1013, 'File-sharing room capacity reached');
                return;
            }
            rooms.set(id, { key, peers: new Map(), lastUsed: Date.now() });
        }
        const room = rooms.get(id);
        if (!timingSafeEqual(Buffer.from(room.key), Buffer.from(key))) {
            ws.close(1008, 'Invalid invitation credentials');
            return;
        }
        if (room.peers.has(peer) || room.peers.size >= 8) {
            ws.close(1008, room.peers.has(peer) ? 'This device is already connected in another tab' : 'Room is full (8 devices)');
            return;
        }
        ws.fileShareName = (query.get('name') || 'Guest').trim().slice(0, 40) || 'Guest';
        room.peers.set(peer, ws);
        room.lastUsed = Date.now();
        let count = 0, windowStart = Date.now();
        ws.on('message', (raw, binary) => {
            if (Date.now() - windowStart > 10000) { count = 0; windowStart = Date.now(); }
            if (binary || raw.length > 64 * 1024 || ++count > 150) {
                ws.close(1008, 'Signaling limit exceeded');
                return;
            }
            let message;
            try { message = JSON.parse(raw.toString()); }
            catch { ws.close(1008, 'Invalid signaling JSON'); return; }
            if (!message || message.type !== 'signal' || !uuid.test(message.to || '')
                || !message.signal || typeof message.signal !== 'object'
                || !['description', 'candidate'].includes(message.signal.kind)) {
                ws.close(1008, 'Invalid signaling message');
                return;
            }
            const target = room.peers.get(message.to);
            if (target) send(target, { type: 'signal', from: peer, signal: message.signal });
            else send(ws, { type: 'peer-unavailable', peer: message.to });
        });
        ws.on('close', () => {
            room.peers.delete(peer);
            room.lastUsed = Date.now();
            announce(room);
        });
        announce(room);
    }

    return { connect, close: () => clearInterval(timer) };
}

module.exports = { createFileSharing, iceConfiguration };
