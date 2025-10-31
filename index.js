// Smart Gate WebSocket server
// Run: npm i express ws cors && node server.js

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const crypto = require('crypto');
const url = require('url');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({
  server,
  path: '/ws',
  perMessageDeflate: false,
  maxPayload: 128 * 1024,
});

// ---- config ----
const PORT = process.env.PORT || 8080;
const MAX_IDLE_MS = parseInt(process.env.MAX_IDLE_MS || `${24 * 60 * 60 * 1000}`, 10); // 24h
const SWEEP_MS = 10 * 60 * 1000; // sweep every 10 min

// ---- in-memory room store ----
// roomId -> { devices:Set<ws>, viewers:Set<ws>, lastSeen:number }
const rooms = new Map();

// ---- helpers ----
app.use(cors({ origin: '*' }));
app.use(express.json());

function slugifyName(name) {
  return String(name || 'anon')
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'anon';
}
function makeRoomId(base) {
  for (let i = 0; i < 5; i++) {
    const n = Math.floor(100 + Math.random() * 900); // 100..999
    const id = `${base}-${n}`;
    if (!rooms.has(id)) return id;
  }
  return `${base}-${crypto.randomBytes(2).toString('hex')}`;
}
function getOrCreateRoom(roomId) {           // used ONLY by REST creation endpoints
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { devices: new Set(), viewers: new Set(), lastSeen: Date.now() });
  }
  return rooms.get(roomId);
}
function getRoom(roomId) {                   // WS path: DO NOT CREATE
  return rooms.get(roomId) || null;
}
function touch(room) { room.lastSeen = Date.now(); }
function broadcastTo(set, obj) {
  const raw = JSON.stringify(obj);
  for (const ws of set) {
    if (ws.readyState === WebSocket.OPEN) { try { ws.send(raw); } catch {} }
  }
}

// ---- REST endpoints ----

// Generate & auto-reserve (create) a short, reusable room ID (e.g., “leslie-214”)
app.get('/api/register', (req, res) => {
  const base = slugifyName(req.query.name || 'anon');
  const roomId = makeRoomId(base);
  getOrCreateRoom(roomId);                   // creation allowed here
  console.log(`🆕 Room created & reserved: ${roomId}`);
  res.json({ roomId, name: base });
});

// Optionally (re)reserve an existing roomId
app.post('/api/reserve', (req, res) => {
  const roomId = String((req.body && req.body.roomId) || '').trim();
  if (!roomId) return res.status(400).json({ error: 'roomId required' });
  getOrCreateRoom(roomId);                   // creation allowed here
  res.json({ ok: true, roomId });
});

// Health
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

// Default
app.get('/', (_req, res) => res.type('text/plain').send('Smart Gate server running. Use /api/register and /ws.'));

// ---- WebSocket logic ----
function heartbeat() { this.isAlive = true; }
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) { try { ws.terminate(); } catch {} ; return; }
    ws.isAlive = false; try { ws.ping(); } catch {}
  });
}, 30_000);

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', heartbeat);

  const { query } = url.parse(req.url, true);
  const roomId = String(query.roomId || '').trim();
  const role = String(query.role || '').toLowerCase(); // "device" | "viewer"

  ws.meta = { roomId: null, role: null };

  // ATTACH: require pre-existing room; DO NOT create here
  const attach = (rid, r) => {
    const room = getRoom(rid);
    if (!room) {
      ws.send(JSON.stringify({ type: 'error', message: 'unknown roomId (create via /api/register first)' }));
      // optional: close so clients see immediate failure
      try { ws.close(4001, 'unknown room'); } catch {}
      return false;
    }
    (r === 'device' ? room.devices : room.viewers).add(ws);
    ws.meta.roomId = rid;
    ws.meta.role = r;
    touch(room);
    ws.send(JSON.stringify({ type: 'registered', roomId: rid, role: r }));
    console.log(`🔗 ${r} joined room: ${rid}`);
    return true;
  };

  // Attach immediately if params provided
  if (roomId && (role === 'device' || role === 'viewer')) {
    if (!attach(roomId, role)) return; // stop if unknown room
  } else {
    ws.send(JSON.stringify({
      type: 'info',
      message: 'Send {"type":"register","roomId":"name-123","role":"device|viewer"} (room must exist) or connect with ?roomId=&role='
    }));
  }

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // Lazy registration (still must target an EXISTING room)
    if (msg.type === 'register' && (!ws.meta.roomId || !ws.meta.role)) {
      const rid = String(msg.roomId || '').trim();
      const r = String(msg.role || '').toLowerCase();
      if (!rid || !['device','viewer'].includes(r)) {
        ws.send(JSON.stringify({ type:'error', message:'register requires roomId and role=device|viewer' }));
        return;
      }
      attach(rid, r);                         // uses getRoom (no creation)
      return;
    }

    if (!ws.meta.roomId || !ws.meta.role) return;
    const room = rooms.get(ws.meta.roomId);
    if (!room) return;
    touch(room);

    // DEVICE → VIEWER
    if (msg.type === 'gate_state' && ws.meta.role === 'device') {
      const gate = String(msg.gate || '').toUpperCase();
      if (gate !== 'OPEN' && gate !== 'CLOSED') return;
      const payload = { type: 'gate_state', roomId: ws.meta.roomId, gate, ts: Date.now() };
      broadcastTo(room.viewers, payload);
      return;
    }

    // VIEWER → DEVICE
    if (msg.type === 'command' && ws.meta.role === 'viewer') {
      const action = String(msg.action || '').toUpperCase();
      if (action !== 'OPEN' && action !== 'CLOSE') return;
      broadcastTo(room.devices, { type: 'command', action, roomId: ws.meta.roomId, ts: Date.now() });
      return;
    }
  });

  ws.on('close', () => {
    const { roomId: rid, role: r } = ws.meta;
    if (!rid || !r) return;
    const room = rooms.get(rid);
    if (!room) return;
    room.devices.delete(ws);
    room.viewers.delete(ws);
    touch(room);
    console.log(`❌ ${r} left room: ${rid}`);
  });

  ws.on('error', (err) => console.warn('⚠️ WS error:', err.message));
});

// ---- idle room cleanup ----
setInterval(() => {
  const now = Date.now();
  for (const [rid, room] of rooms.entries()) {
    if ((now - room.lastSeen) > MAX_IDLE_MS && room.devices.size === 0 && room.viewers.size === 0) {
      rooms.delete(rid);
      console.log(`🧹 Cleaned idle room: ${rid}`);
    }
  }
}, SWEEP_MS);

server.listen(PORT, () => {
  console.log(`🚀 HTTP  : http://0.0.0.0:${PORT}`);
  console.log(`🔌 WS    : ws://0.0.0.0:${PORT}/ws?roomId=<name-123>&role=device|viewer`);
});
