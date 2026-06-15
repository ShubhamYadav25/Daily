// server.js
const { WebSocketServer } = require('ws');

// Store active rooms and their clients
const rooms = new Map();

const wss = new WebSocketServer({ port: process.env.PORT || 8080 });

wss.on('connection', (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const roomId = url.searchParams.get('room');

    if (!roomId) {
        ws.close(1008, 'Room ID is required.');
        return;
    }

    // Add client to the room
    if (!rooms.has(roomId)) rooms.set(roomId, new Set());
    const room = rooms.get(roomId);
    room.add(ws);
    
    // Send the current state of the room to the new client (optimization)
    // For simplicity, we'll broadcast the new client's state to everyone.
    
    ws.on('message', (data) => {
        // Broadcast the message to all other clients in the same room
        const message = data.toString();
        for (const client of room) {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
                client.send(message);
            }
        }
    });

    ws.on('close', () => {
        room.delete(ws);
        if (room.size === 0) rooms.delete(roomId);
    });
});