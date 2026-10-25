/**
 * LAN match server.
 *
 * One process does two jobs, so "hosting a game" really is one click:
 *   1. serves the built game (dist/) over HTTP, so friends only need an IP
 *   2. relays the match over WebSocket on the same port
 *
 * The host's browser/Electron window runs the simulation; this server is a dumb
 * relay, which keeps netcode latency-sensitive logic out of the network layer.
 *
 * Also usable standalone:  node server/lan-server.mjs [--port 8787]
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '..');

/**
 * Both sides must run the same build: the netcode, the maps and the item table
 * all change between versions, so a mismatched pair would desync immediately.
 */
async function readVersion() {
  if (process.env.TANK_VERSION) return process.env.TANK_VERSION;
  try {
    const pkg = JSON.parse(await readFile(resolve(ROOT, 'package.json'), 'utf8'));
    return String(pkg.version || '0.0.0');
  } catch {
    return '0.0.0';
  }
}
const VERSION = await readVersion();
const DIST = process.env.TANK_DIST ? resolve(process.env.TANK_DIST) : join(ROOT, 'dist');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/** LAN addresses other machines can use, most useful first. */
export function lanAddresses() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family !== 'IPv4' || net.internal) continue;
      out.push(net.address);
    }
  }
  return out;
}

const NO_DIST = `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>坦克大作战 · 局域网</title>
<body style="font-family:system-ui;background:#f3ead9;color:#26221d;padding:40px;line-height:1.7">
<h1>还没有打包好的游戏文件</h1>
<p>先运行 <code>npm run build</code> 生成 <code>dist/</code>，再启动局域网服务。</p>
<p>或者直接运行 <code>npm run lan</code>（会自动先构建）。</p>
</body></html>`;

function json(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

async function serveStatic(req, res) {
  const url = new URL(req.url ?? '/', 'http://lan.local');
  if (url.pathname === '/info') {
    return json(res, 200, {
      ok: true,
      version: VERSION,
      port: currentPort,
      addresses: lanAddresses(),
      players: countPlayers(),
      capacity: room.capacity,
      mode: room.mode,
      roster: roster().players,
    });
  }

  const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  // normalize() collapses "..", and the prefix check rejects anything that escapes.
  const file = normalize(join(DIST, rel));
  if (!file.startsWith(DIST)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-cache',
    });
    res.end(body);
  } catch {
    // Single-page app: unknown paths fall back to index.html when it exists.
    try {
      const html = await readFile(join(DIST, 'index.html'));
      res.writeHead(200, { 'content-type': MIME['.html'], 'content-length': html.length });
      res.end(html);
    } catch {
      res.writeHead(200, { 'content-type': MIME['.html'] }).end(NO_DIST);
    }
  }
}

/**
 * v1.3: one room, up to 10 players.
 *
 * The host (p1) keeps the authoritative simulation; the server only relays.
 * Seats are handed out on join (p2, p3, …), teams alternate, and everyone gets
 * the same roster so every screen shows identical information.
 */
const room = {
  host: null,
  /** id -> socket, host included as 'p1'. */
  players: new Map(),
  capacity: 6,
  mode: 'ffa',
  config: null,
  nextId: 2,
};
let totalPlayers = 0;
let currentPort = 0;

function countPlayers() {
  return room.players.size;
}

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(msg, exceptWs = null) {
  for (const ws of room.players.values()) {
    if (ws === exceptWs) continue;
    send(ws, msg);
  }
}

/** Public snapshot of the room – identical for every client. */
function roster() {
  const players = [];
  for (const [id, ws] of room.players) {
    players.push({ id, skill: ws.skill ?? '', team: ws.team ?? 0, host: id === 'p1' });
  }
  return {
    t: 'roster',
    players,
    capacity: room.capacity,
    mode: room.mode,
    host: players.find((p) => p.host)?.id ?? null,
  };
}

function teamForSeat(seat) {
  return room.mode === 'team' ? seat % 2 : seat;
}

function refreshTeams() {
  let seat = 0;
  for (const ws of room.players.values()) {
    ws.team = teamForSeat(seat);
    seat += 1;
  }
}

function announceRoster() {
  refreshTeams();
  broadcast(roster());
}

/** Legacy 1v1 pairing messages, kept so older clients (and the LAN tests) work. */
function pair() {
  const host = room.host;
  const guest = [...room.players.entries()].find(([id]) => id !== 'p1')?.[1] ?? null;
  if (!host || !guest) return;
  send(host, { t: 'peer', state: 'joined', skill: guest.skill, version: guest.version });
  send(guest, { t: 'paired', skill: host.skill });
  console.log('[lan] host <-> guest paired');
}

function unlink(ws) {
  const id = ws.playerId;
  if (!id || !room.players.has(id)) return;
  const wasHost = id === 'p1';
  room.players.delete(id);
  ws.playerId = null;
  ws.role = null;
  if (wasHost) room.host = null;
  send(ws, { t: 'bye' });
  // Tell the survivors exactly who left. An explicit surrender was already
  // broadcast by the message handler; a dropped socket only reports "left".
  broadcast({ t: 'peer', state: 'left', id, host: wasHost });
  announceRoster();
}

export function createLanServer({ port = Number(process.env.PORT) || 8787, host = '0.0.0.0', quiet = false } = {}) {
  const server = createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end('method not allowed');
      return;
    }
    void serveStatic(req, res);
  });

  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1024 * 64 });

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.role = null;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (!msg || typeof msg.t !== 'string') return;

      if (msg.t === 'join') {
        const role = msg.role === 'host' ? 'host' : 'guest';
        ws.skill = typeof msg.skill === 'string' ? msg.skill : undefined;
        ws.version = typeof msg.version === 'string' ? msg.version : '';
        ws.name = typeof msg.name === 'string' && msg.name ? msg.name.slice(0, 12) : '';

        // A guest from a different build cannot be played with – say why.
        if (role === 'guest' && ws.version && ws.version !== VERSION) {
          send(ws, { t: 'reject', reason: 'version', hostVersion: VERSION, yourVersion: ws.version });
          console.log(`[lan] rejected guest ${ws.version} (host ${VERSION})`);
          ws.role = null;
          return;
        }

        if (role === 'host') {
          // A reconnecting host takes the p1 seat back and keeps the guests –
          // a restart in the middle of a match must not kick everybody.
          const previous = room.players.get('p1');
          if (previous && previous !== ws) send(previous, { t: 'replaced' });
          room.host = ws;
          ws.playerId = 'p1';
          ws.role = 'host';
          if (!previous) totalPlayers += 1;
          room.players.set('p1', ws);
          send(ws, { t: 'joined', role: 'host', id: 'p1', guest: false, capacity: room.capacity, version: VERSION });
          console.log('[lan] host joined');
          announceRoster();
          return;
        }

        // Guests: refuse when the room is already full.
        if (room.players.size >= room.capacity || !room.host) {
          send(ws, { t: 'reject', reason: room.host ? 'full' : 'unknown', capacity: room.capacity });
          console.log(`[lan] rejected guest: room ${room.players.size}/${room.capacity}`);
          return;
        }
        const id = `p${room.nextId++}`;
        ws.playerId = id;
        ws.role = 'guest';
        totalPlayers += 1;
        room.players.set(id, ws);
        send(ws, {
          t: 'joined',
          role: 'guest',
          id,
          host: true,
          capacity: room.capacity,
          version: VERSION,
          peerVersion: room.host?.version,
        });
        console.log(`[lan] guest ${id} joined (${room.players.size}/${room.capacity})`);
        if (room.host) send(room.host, { t: 'peer', state: 'joined', id, skill: ws.skill, version: ws.version });
        announceRoster();
        pair();
        return;
      }

      // Host-owned room settings: capacity, mode, win conditions, damage switches.
      if (msg.t === 'config') {
        if (ws.role !== 'host') return;
        const capacity = Math.max(2, Math.min(10, Number(msg.capacity) || room.capacity));
        room.capacity = capacity;
        room.mode = msg.mode === 'team' ? 'team' : 'ffa';
        room.config = { ...msg, capacity };
        announceRoster();
        // Everyone needs the same rules, not just the roster.
        broadcast({ t: 'config', config: room.config });
        return;
      }

      if (msg.t === 'input') {
        if (ws.role === 'guest' && room.host) {
          send(room.host, { t: 'input', from: ws.playerId, input: msg.input, seq: msg.seq });
        }
        return;
      }

      // Host → everyone: snapshots, level changes, match events.
      if (msg.t === 'state' || msg.t === 'start' || msg.t === 'restart' || msg.t === 'level' || msg.t === 'event') {
        if (ws.role === 'host') broadcast(msg, ws);
        return;
      }

      // Any player can walk away; the others must be told it was a surrender.
      if (msg.t === 'surrender') {
        broadcast({ t: 'surrender', by: ws.playerId ?? msg.by ?? 'p1' }, ws);
        unlink(ws);
        return;
      }

      if (msg.t === 'leave') {
        unlink(ws);
      }
    });

    ws.on('close', () => {
      if (ws.playerId) {
        unlink(ws);
        console.log(`[lan] ${ws.playerId} disconnected (${room.players.size}/${room.capacity})`);
      }
      ws.role = null;
    });
  });

  // Drop dead connections so a stale room doesn't block new joins.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 15000);
  heartbeat.unref?.();

  // A failed listen on either listener must reject cleanly instead of throwing
  // from an 'error' event that nobody listens to.
  const socketServer = server;

  return new Promise((resolvePromise, reject) => {
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      socketServer.off('error', onError);
      wss.off('error', onError);
    };
    socketServer.once('error', onError);
    wss.once('error', onError);
    server.listen(port, host, () => {
      const addr = server.address();
      const actual = typeof addr === 'object' && addr ? addr.port : port;
      currentPort = actual;
      cleanup();
      if (!quiet) {
        const ips = lanAddresses();
        console.log(`\n  坦克大作战 · 局域网服务已启动`);
        console.log(`  本机:   http://localhost:${actual}`);
        for (const ip of ips) console.log(`  局域网: http://${ip}:${actual}`);
        console.log(`  把「局域网」那一行的地址发给朋友，用浏览器打开就能加入房间。\n`);
      }
      resolvePromise({
        server,
        wss,
        port: actual,
        addresses: lanAddresses(),
        version: VERSION,
        close: () =>
          new Promise((done) => {
            clearInterval(heartbeat);
            for (const client of wss.clients) client.terminate();
            wss.close(() => server.close(() => done()));
          }),
        stats: () => ({ players: countPlayers(), totalPlayers }),
      });
    });
  });
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const portArg = process.argv.indexOf('--port');
  const port = portArg > -1 ? Number(process.argv[portArg + 1]) : undefined;
  await createLanServer({ port });
}
