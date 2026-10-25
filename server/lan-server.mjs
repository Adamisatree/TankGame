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
  /** True once the host has started a match; a new join drops back to lobby. */
  started: false,
  /** How many teams team-mode uses. The host can add/remove teams in the lobby. */
  teamCount: 2,
  /**
   * The map the room will play. The host pushes the file itself, the server
   * keeps it so late joiners get the same one, and every guest must confirm it
   * before `begin` is accepted.
   */
  map: null,
  mapHash: '',
  /** Seats that have confirmed they hold the current map. */
  mapAcks: new Set(),
};

/** Same cap as `MAX_MAP_BYTES` in src/net/protocol.ts. */
const MAX_MAP_BYTES = 48 * 1024;

/** Guests that still need to confirm the room's map. */
function mapPending() {
  if (!room.map) return [];
  return [...room.players.keys()].filter((id) => id !== 'p1' && !room.mapAcks.has(id));
}

function mapStatus() {
  return {
    t: 'map-status',
    waiting: mapPending(),
    ready: [...room.mapAcks].filter((id) => id !== 'p1' && room.players.has(id)),
  };
}

/** True when the payload is a map file we are willing to relay. */
function isMapPayload(map) {
  if (!map || typeof map !== 'object') return false;
  if (map.format !== 'tankmap') return false;
  try {
    return JSON.stringify(map).length <= MAX_MAP_BYTES;
  } catch {
    return false;
  }
}

/** Host pushed a map: cache it, hand it to the guests, forget old acks. */
function setRoomMap(map, hash) {
  room.map = map;
  room.mapHash = typeof hash === 'string' ? hash : '';
  room.mapAcks.clear();
  broadcast({ t: 'map', map: room.map, hash: room.mapHash });
  console.log(`[lan] map ${map.id ?? '?'} rev ${map.rev ?? '?'} -> room`);
}
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

/**
 * Room snapshot, tailored per viewer.
 *
 * A player's summoner-skill choice is **private**: only the seat itself (and the
 * host, which has to simulate it) ever receives the value. Everyone else just
 * learns whether the seat has picked something yet.
 */
function roster(viewer = null) {
  const viewerId = viewer?.playerId ?? null;
  const isHost = viewer?.role === 'host';
  const players = [];
  for (const [id, ws] of room.players) {
    const mine = id === viewerId || isHost;
    const chosen = ws.skill ?? '';
    players.push({
      id,
      name: ws.name || `P${id.replace(/^p/, '')}`,
      skill: mine ? chosen : '',
      /** True once that seat has picked something (safe for others to know). */
      hasSkill: !!chosen,
      team: ws.team ?? 0,
      ready: id === 'p1' ? true : !!ws.ready,
      host: id === 'p1',
    });
  }
  return {
    t: 'roster',
    players,
    capacity: room.capacity,
    mode: room.mode,
    teams: room.teamCount,
    host: players.find((p) => p.host)?.id ?? null,
    started: room.started,
    config: room.config,
  };
}

function clampTeam(team) {
  return Math.max(0, Math.min(room.teamCount - 1, Number(team) || 0));
}

function teamForSeat(seat) {
  return room.mode === 'team' ? seat % room.teamCount : seat;
}

/** How many players sit in each team, index = team number. */
function teamSizes() {
  const sizes = new Array(room.teamCount).fill(0);
  for (const ws of room.players.values()) {
    const team = clampTeam(ws.team ?? 0);
    sizes[team] += 1;
  }
  return sizes;
}

/**
 * Rebuilds teams from seat order. Only used when the host asks for auto
 * balance – hand-picked teams (`team` messages) are kept as they are.
 */
function refreshTeams() {
  let seat = 0;
  for (const ws of room.players.values()) {
    ws.team = teamForSeat(seat);
    seat += 1;
  }
}

/**
 * Guarantees nobody sits on a team that does not exist, and that every team has
 * somebody. Pulls players out of the largest team, never below one member.
 */
function fillTeams() {
  for (const ws of room.players.values()) ws.team = clampTeam(ws.team ?? 0);
  const sizes = teamSizes();
  for (let team = 0; team < room.teamCount; team += 1) {
    if (sizes[team] > 0) continue;
    // Move one player from the biggest team that can spare one.
    let donor = -1;
    for (let i = 0; i < sizes.length; i += 1) {
      if (sizes[i] > 1 && (donor < 0 || sizes[i] > sizes[donor])) donor = i;
    }
    if (donor < 0) break;
    const mover = [...room.players.values()].find((player) => (player.team ?? 0) === donor);
    if (!mover) break;
    mover.team = team;
    sizes[donor] -= 1;
    sizes[team] += 1;
  }
}

function announceRoster() {
  // Teams are sticky: a host's hand-picked sides must survive every roster
  // broadcast. New seats get a sensible default at join time instead.
  for (const ws of room.players.values()) send(ws, roster(ws));
}

/** Least-populated team, so a fresh seat keeps the sides roughly even. */
function balancedTeam() {
  const sizes = teamSizes();
  let best = 0;
  for (let i = 1; i < sizes.length; i += 1) if (sizes[i] < sizes[best]) best = i;
  return best;
}

/** Legacy 1v1 pairing messages, kept so older clients (and the LAN tests) work. */
function pair() {
  const host = room.host;
  const guest = [...room.players.entries()].find(([id]) => id !== 'p1')?.[1] ?? null;
  if (!host || !guest) return;
  // No skill in these messages: picks are private (see roster()).
  send(host, { t: 'peer', state: 'joined', version: guest.version });
  send(guest, { t: 'paired' });
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
  room.mapAcks.delete(id);
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
          ws.team = 0;
          ws.ready = true;
          room.players.set('p1', ws);
          // The host owns the room's map: drop whatever the last host left
          // behind, then take the map it announces (if any).
          room.map = null;
          room.mapHash = '';
          room.mapAcks.clear();
          if (isMapPayload(msg.map)) setRoomMap(msg.map, msg.mapHash);
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
        ws.team = room.mode === 'team' ? balancedTeam() : 0;
        ws.ready = false;
        totalPlayers += 1;
        room.players.set(id, ws);
        // Someone walked into the room: back to the lobby so everyone can
        // pick sides and skills before the next match.
        room.started = false;
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
        // The host is the one client that may see a seat's skill, but even it
        // gets that from the roster, not from this notification.
        // A map picked before this guest walked in still has to reach it.
        if (room.map) {
          room.mapAcks.delete(id);
          send(ws, { t: 'map', map: room.map, hash: room.mapHash });
        }
        if (room.host) send(room.host, { t: 'peer', state: 'joined', id, version: ws.version });
        announceRoster();
        pair();
        return;
      }

      // Host-owned room settings: capacity, mode, win conditions, damage switches.
      if (msg.t === 'config') {
        if (ws.role !== 'host') return;
        const capacity = Math.max(2, Math.min(10, Number(msg.capacity) || room.capacity));
        const previousMode = room.mode;
        room.capacity = capacity;
        room.mode = msg.mode === 'team' ? 'team' : 'ffa';
        room.config = { ...msg, capacity };
        if (room.mode !== previousMode) {
          // Switching to team mode with everyone on team 0 is useless, so give
          // the seats an even split across the teams that exist.
          let seat = 0;
          for (const player of room.players.values()) {
            player.team = room.mode === 'team' ? seat % room.teamCount : 0;
            seat += 1;
          }
        }
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

      // Host changed the room's map: relay it and require fresh confirmations.
      if (msg.t === 'map') {
        if (ws.role !== 'host') return;
        if (!isMapPayload(msg.map)) {
          send(ws, { t: 'lobby-error', reason: 'map-failed', waiting: [], detail: '地图文件太大或格式不对' });
          return;
        }
        setRoomMap(msg.map, msg.mapHash);
        send(ws, mapStatus());
        return;
      }

      // Guest confirmed (or refused) the room's map.
      if (msg.t === 'map-ack') {
        if (ws.role !== 'guest' || !room.map) return;
        if (msg.id !== room.map.id || msg.hash !== room.mapHash) {
          send(room.host, { t: 'lobby-error', reason: 'map-failed', waiting: [ws.playerId], detail: '版本对不上' });
          return;
        }
        if (msg.ok === false) {
          send(room.host, {
            t: 'lobby-error',
            reason: 'map-failed',
            waiting: [ws.playerId],
            detail: typeof msg.reason === 'string' ? msg.reason.slice(0, 40) : '收到了地图但存不下来',
          });
          return;
        }
        room.mapAcks.add(ws.playerId);
        send(room.host, mapStatus());
        return;
      }

      // Host → everyone: snapshots, level changes, match events.
      if (msg.t === 'state' || msg.t === 'start' || msg.t === 'restart' || msg.t === 'level' || msg.t === 'event') {
        if (ws.role === 'host') broadcast(msg, ws);
        return;
      }

      // ---- lobby: each player owns their skill and ready state; the host owns
      // teams and the start button.
      if (msg.t === 'skill') {
        if (!ws.playerId) return;
        if (typeof msg.skill === 'string') ws.skill = msg.skill.slice(0, 24);
        announceRoster();
        return;
      }

      if (msg.t === 'ready') {
        if (!ws.playerId || ws.role === 'host') return;
        ws.ready = !!msg.ready;
        announceRoster();
        return;
      }

      if (msg.t === 'team') {
        if (ws.role !== 'host') return;
        const target = room.players.get(String(msg.id ?? ''));
        if (!target) return;
        target.team = clampTeam(msg.team);
        announceRoster();
        return;
      }

      // How many teams team-mode has. Adding a team immediately re-seats players
      // into the empty one so it never starts life empty.
      if (msg.t === 'teams') {
        if (ws.role !== 'host') return;
        room.teamCount = Math.max(2, Math.min(6, Number(msg.count) || room.teamCount));
        for (const player of room.players.values()) player.team = clampTeam(player.team);
        announceRoster();
        return;
      }

      if (msg.t === 'auto-teams') {
        if (ws.role !== 'host') return;
        refreshTeams();
        announceRoster();
        return;
      }

      // Fill empty teams by moving players out of the biggest one.
      if (msg.t === 'fill-teams') {
        if (ws.role !== 'host') return;
        fillTeams();
        announceRoster();
        return;
      }

      if (msg.t === 'begin') {
        if (ws.role !== 'host') return;
        // Every team needs at least one player: an empty side makes the match
        // nonsense (and a 1v1 with a phantom team is a free win).
        if (room.mode === 'team') {
          const sizes = teamSizes();
          const empty = sizes.map((size, index) => (size === 0 ? index : -1)).filter((index) => index >= 0);
          if (empty.length) {
            send(ws, { t: 'lobby-error', reason: 'empty-team', teams: sizes });
            return;
          }
        }
        // Every guest must hold the room's map before the first snapshot flies:
        // otherwise it would play a different arena than the host.
        const missing = mapPending();
        if (missing.length) {
          send(ws, { t: 'lobby-error', reason: 'map-pending', waiting: missing });
          send(ws, mapStatus());
          return;
        }
        room.started = true;
        // Everyone (host included) learns the room is live.
        broadcast({ t: 'begin', config: room.config, roster: room.players.size ? [...room.players.keys()] : [], mode: room.mode, teams: room.teamCount });
        announceRoster();
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
