const express = require('express');
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const rooms = {}; // code -> { host, guest, guestJoined, levelId, lastSeen }

function makeCode() {
    let code;
    do {
        code = Math.floor(1000 + Math.random() * 9000).toString();
    } while (rooms[code]);
    return code;
}

app.post('/createRoom', (req, res) => {
    const code = makeCode();
    rooms[code] = {
        host: { queue: [] },
        guest: { queue: [] },
        guestJoined: false,
        levelId: req.body.levelId || null,
        lastSeen: Date.now()
    };
    res.json({ code });
});

app.post('/joinRoom', (req, res) => {
    const { code } = req.body;
    const room = rooms[code];
    if (!room) return res.json({ ok: false, error: 'noSuchRoom' });
    if (room.guestJoined) return res.json({ ok: false, error: 'roomFull' });
    room.guestJoined = true;
    room.host.queue.push({ type: 'guestJoined' });
    res.json({ ok: true, levelId: room.levelId });
});

app.post('/send', (req, res) => {
    const { code, role, data } = req.body;
    const room = rooms[code];
    if (!room) return res.json({ ok: false, error: 'noSuchRoom' });
    const target = role === 'host' ? room.guest : room.host;
    target.queue.push({ type: 'relay', data });
    room.lastSeen = Date.now();
    res.json({ ok: true });
});

app.get('/poll', (req, res) => {
    const { code, role } = req.query;
    const room = rooms[code];
    if (!room) return res.json({ ok: false, error: 'noSuchRoom' });
    const self = role === 'host' ? room.host : room.guest;
    const messages = self.queue;
    self.queue = [];
    room.lastSeen = Date.now();
    res.json({ ok: true, messages });
});

setInterval(() => {
    const cutoff = Date.now() - 30 * 60 * 1000;
    for (const code in rooms) {
        if (rooms[code].lastSeen < cutoff) delete rooms[code];
    }
}, 5 * 60 * 1000);

app.listen(PORT, () => console.log('Relay running on port ' + PORT));
