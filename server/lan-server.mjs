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
      port: currentPort,
      addresses: lanAddresses(),
      players: countPlayers(),
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

/** host <-> guest pairing; 1v1, newest host wins if two are waiting. */
const room = { host: null, guest: null };
let totalPlayers = 0;
let currentPort = 0;

function countPlayers() {
  return (room.host ? 1 : 0) + (room.guest ? 1 : 0);
}

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

/** The guest's menu choice travels with the pairing so the host can use it. */
function pair() {
  if (!room.host || !room.guest) return;
  send(room.host, { t: 'peer', state: 'joined', skill: room.guest.skill });
  send(room.guest, { t: 'paired', skill: room.host.skill });
  console.log('[lan] host <-> guest paired');
}

function unlink(ws, who) {
  if (who === 'host') {
    room.host = null;
    send(room.guest, { t: 'peer', state: 'left' });
  } else {
    room.guest = null;
    send(room.host, { t: 'peer', state: 'left' });
  }
  send(ws, { t: 'bye' });
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
        if (role === 'host') {
          if (room.host && room.host !== ws) send(room.host, { t: 'replaced' });
          room.host = ws;
          ws.role = 'host';
          totalPlayers++;
          send(ws, { t: 'joined', role: 'host', guest: !!room.guest });
          console.log('[lan] host joined');
          pair();
        } else {
          if (room.guest && room.guest !== ws) send(room.guest, { t: 'replaced' });
          room.guest = ws;
          ws.role = 'guest';
          totalPlayers++;
          send(ws, { t: 'joined', role: 'guest', host: !!room.host, skill: room.host?.skill });
          console.log('[lan] guest joined');
          pair();
        }
        return;
      }

      // Everything else is relayed to the other side of the room.
      if (msg.t === 'input') {
        if (ws.role === 'guest') send(room.host, { t: 'input', input: msg.input, seq: msg.seq });
        return;
      }
      if (msg.t === 'state' || msg.t === 'start' || msg.t === 'restart' || msg.t === 'level') {
        if (ws.role === 'host') send(room.guest, msg);
        return;
      }
      if (msg.t === 'leave') {
        unlink(ws, ws.role);
        ws.role = null;
      }
    });

    ws.on('close', () => {
      if (ws.role) {
        unlink(ws, ws.role);
        console.log(`[lan] ${ws.role} disconnected`);
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
