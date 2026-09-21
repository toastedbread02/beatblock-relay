const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const wss = new WebSocket.Server({ port: PORT });

const rooms = {}; // roomCode -> { host: ws, guest: ws }

function makeCode() {
    let code;
    do {
        code = Math.floor(1000 + Math.random() * 9000).toString();
    } while (rooms[code]);
    return code;
}

wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch (e) { return; }

        if (msg.type === 'createRoom') {
            const code = makeCode();
            rooms[code] = { host: ws, guest: null };
            ws.roomCode = code;
            ws.role = 'host';
            ws.send(JSON.stringify({ type: 'roomCreated', code }));
        }

        else if (msg.type === 'joinRoom') {
            const room = rooms[msg.code];
            if (!room) {
                ws.send(JSON.stringify({ type: 'joinFailed', reason: 'noSuchRoom' }));
                return;
            }
            if (room.guest) {
                ws.send(JSON.stringify({ type: 'joinFailed', reason: 'roomFull' }));
                return;
            }
            room.guest = ws;
            ws.roomCode = msg.code;
            ws.role = 'guest';
            ws.send(JSON.stringify({ type: 'joined', code: msg.code }));
            room.host.send(JSON.stringify({ type: 'guestJoined' }));
        }

        else if (msg.type === 'relay') {
            const room = rooms[ws.roomCode];
            if (!room) return;
            const other = ws.role === 'host' ? room.guest : room.host;
            if (other) other.send(JSON.stringify({ type: 'relay', data: msg.data }));
        }
    });

    ws.on('close', () => {
        const room = rooms[ws.roomCode];
        if (!room) return;
        const other = ws.role === 'host' ? room.guest : room.host;
        if (other) other.send(JSON.stringify({ type: 'peerLeft' }));
        delete rooms[ws.roomCode];
    });
});

console.log('Relay running on port ' + PORT);
