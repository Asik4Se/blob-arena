// ブロブアリーナ サーバー（部屋コード方式・サーバー計算・依存ライブラリなし）
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const ws = require('./ws.js');
const { Game } = require('./public/core.js');

const PORT = process.env.PORT || 3000;
const TICK = 1 / 20;
const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

// 静的ファイル配信
const server = http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent((req.url || '/').split('?')[0]); } catch (e) { res.writeHead(400); res.end(); return; }
  if (p === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

const rooms = new Map();
const clients = new Map(); // id -> { conn, room, name, vw, vh }

const send = (c, t, d) => { if (c && c.conn.open) c.conn.send(JSON.stringify({ t, d })); };

function newCode() {
  let code;
  do { code = String(Math.floor(1000 + Math.random() * 9000)); } while (rooms.has(code));
  return code;
}
function roomInfo(room) {
  return {
    code: room.code, hostId: room.hostId, state: room.state, matchTime: room.matchTime,
    members: [...room.members].map((id) => ({ id, name: clients.get(id).name })),
  };
}
function broadcast(room, t, d) { for (const id of room.members) send(clients.get(id), t, d); }
function broadcastRoom(room) { broadcast(room, 'room', roomInfo(room)); }

function startMatch(room) {
  stopLoop(room);
  room.game = new Game({ matchTime: room.matchTime });
  for (const id of room.members) room.game.addPlayer(id, clients.get(id).name);
  room.state = 'playing';
  broadcastRoom(room);
  room.loop = setInterval(() => tick(room), TICK * 1000);
}
function stopLoop(room) { if (room.loop) clearInterval(room.loop); room.loop = null; }

function tick(room) {
  const g = room.game;
  if (!g) return;
  g.step(TICK);
  for (const id of room.members) {
    const c = clients.get(id);
    if (!c || !c.conn.open) continue;
    if (c.conn.backlog > 512 * 1024) continue; // 回線が詰まっている人には今回分を送らない
    send(c, 'snap', g.view(id, c.vw, c.vh));
  }
  if (g.ended) {
    stopLoop(room);
    room.state = 'result';
    broadcast(room, 'result', g.result);
    broadcastRoom(room);
  }
}

function leave(id) {
  const c = clients.get(id);
  if (!c || !c.room) return;
  const room = rooms.get(c.room);
  c.room = null;
  if (!room) return;
  room.members.delete(id);
  if (room.game) room.game.removePlayer(id);
  if (!room.members.size) { stopLoop(room); rooms.delete(room.code); return; }
  if (room.hostId === id) room.hostId = room.members.values().next().value;
  broadcastRoom(room);
}
function joinRoom(id, room, name) {
  leave(id);
  const c = clients.get(id);
  c.name = cleanName(name);
  c.room = room.code;
  room.members.add(id);
  if (room.state === 'playing' && room.game) room.game.addPlayer(id, c.name);
  broadcastRoom(room);
}
function cleanName(n) {
  const s = String(n || '').replace(/[<>]/g, '').trim().slice(0, 12);
  return s || 'プレイヤー';
}

const handlers = {
  create(id, d) {
    const room = { code: newCode(), hostId: id, members: new Set(), state: 'lobby', matchTime: 300, game: null, loop: null };
    rooms.set(room.code, room);
    joinRoom(id, room, d && d.name);
  },
  join(id, d) {
    const room = rooms.get(String((d && d.code) || '').trim());
    if (!room) { send(clients.get(id), 'joinError', '部屋が見つかりません'); return; }
    joinRoom(id, room, d.name);
  },
  settings(id, d, room) {
    if (!room || room.hostId !== id || room.state === 'playing') return;
    const t = Math.round(Number(d && d.matchTime));
    if (t >= 60 && t <= 600) room.matchTime = t;
    broadcastRoom(room);
  },
  start(id, d, room) {
    if (!room || room.hostId !== id || room.state === 'playing') return;
    startMatch(room);
  },
  toLobby(id, d, room) {
    if (!room || room.hostId !== id) return;
    stopLoop(room); room.game = null; room.state = 'lobby';
    broadcastRoom(room);
  },
  viewport(id, d) {
    const c = clients.get(id);
    c.vw = Math.max(320, Math.min(3840, Number(d && d.w) || 1280));
    c.vh = Math.max(320, Math.min(2160, Number(d && d.h) || 720));
  },
  input(id, d, room) { if (room && room.game && d) room.game.setInput(id, Number(d.dx), Number(d.dy)); },
  split(id, d, room) { if (room && room.game) room.game.split(id); },
  eject(id, d, room) { if (room && room.game) room.game.setEject(id, !!d); },
  leave(id) { leave(id); },
};

ws.attach(server, '/ws', (conn) => {
  const id = crypto.randomBytes(6).toString('hex');
  clients.set(id, { conn, room: null, name: '', vw: 1280, vh: 720 });
  send(clients.get(id), 'hello', { id });
  conn.on('message', (text) => {
    let msg;
    try { msg = JSON.parse(text); } catch (e) { return; }
    const h = msg && handlers[msg.t];
    if (!h) return;
    const c = clients.get(id);
    try { h(id, msg.d, c && c.room ? rooms.get(c.room) : null); } catch (e) { console.error(e); }
  });
  conn.on('close', () => { leave(id); clients.delete(id); });
});

server.listen(PORT, () => console.log(`Blob Arena: http://localhost:${PORT}`));
