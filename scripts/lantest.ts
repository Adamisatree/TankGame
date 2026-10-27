/**
 * Headless LAN tests: starts the real relay server on an ephemeral port and
 * drives it with two WebSocket clients (host + guest).
 *
 *   npm run lantest
 */
import { readFile } from 'node:fs/promises';
import WebSocket from 'ws';
// The build injects the version; under tsx we read it from package.json.
const TANK_VERSION = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
import { createLanServer } from '../server/lan-server.mjs';
import { emptyMap, mapHash } from '../src/maps/format';

const checks: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail && !ok ? ` — ${detail}` : ''}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate: () => boolean, timeout = 2500): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (predicate()) return true;
    await sleep(20);
  }
  return false;
}

type Box = { messages: any[]; send: (msg: unknown) => void; close: () => void; ws: WebSocket };

async function open(url: string): Promise<Box> {
  const ws = new WebSocket(url);
  const messages: any[] = [];
  ws.on('message', (raw) => {
    try {
      messages.push(JSON.parse(String(raw)));
    } catch {
      /* ignore */
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return {
    messages,
    ws,
    send: (msg) => ws.send(JSON.stringify(msg)),
    close: () => ws.close(),
  };
}

const server = await createLanServer({ port: 0, host: '127.0.0.1', quiet: true });
const wsUrl = `ws://127.0.0.1:${server.port}/ws`;
console.log(`lan server listening on ${server.port}`);

// --- HTTP surface
const infoRes = await fetch(`http://127.0.0.1:${server.port}/info`);
const info = await infoRes.json();
check('/info answers', infoRes.ok && info.ok === true, JSON.stringify(info));
check('/info reports a free room', info.players === 0, JSON.stringify(info));
check('/info reports the real port', info.port === server.port, `${info.port} vs ${server.port}`);
check('/info lists LAN addresses for the host to share', Array.isArray(info.addresses), JSON.stringify(info.addresses));

// --- version gate (different builds must never play together)
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
check('/info reports the build version', info.version === pkg.version, `${info.version} vs ${pkg.version}`);

const stale = await open(wsUrl);
stale.send({ t: 'join', role: 'guest', version: '0.0.0-old', protocol: 3 });
const rejected = await waitFor(() => stale.messages.some((m) => m.t === 'reject'), 2000);
const rejectMsg = stale.messages.find((m) => m.t === 'reject');
check('an old guest is refused with a reason', rejected && rejectMsg?.reason === 'version', JSON.stringify(stale.messages));
check('the refusal names both versions', rejectMsg?.hostVersion === pkg.version && rejectMsg?.yourVersion === '0.0.0-old', JSON.stringify(rejectMsg));
check('a refused guest never joins the room', !stale.messages.some((m) => m.t === 'joined'), JSON.stringify(stale.messages));
check('a refused guest does not occupy a seat', server.stats().players === 0, JSON.stringify(server.stats()));
stale.close();
await new Promise((r) => setTimeout(r, 60));

const pageRes = await fetch(`http://127.0.0.1:${server.port}/`);
check('/ serves the game (or a build hint)', pageRes.ok, String(pageRes.status));
const traversal = await fetch(`http://127.0.0.1:${server.port}/../package.json`);
check('path traversal is blocked', traversal.status === 200 && !(await traversal.text()).includes('"scripts"'), String(traversal.status));

// --- pairing
const host = await open(wsUrl);
host.send({ t: 'join', role: 'host', skill: 'rage' , version: TANK_VERSION });
check('host gets a joined ack', await waitFor(() => host.messages.some((m) => m.t === 'joined')), JSON.stringify(host.messages));
check('host ack says nobody has joined yet', host.messages.find((m) => m.t === 'joined')?.guest === false);

const guest = await open(wsUrl);
guest.send({ t: 'join', role: 'guest', skill: 'weaken' , version: TANK_VERSION });
check('guest gets a joined ack', await waitFor(() => guest.messages.some((m) => m.t === 'joined')));
check('the ack tells the guest which version it is playing', guest.messages.find((m) => m.t === 'joined')?.version === pkg.version);
check('guest ack sees the host present', guest.messages.find((m) => m.t === 'joined')?.host === true);
check('host is told the guest arrived', await waitFor(() => host.messages.some((m) => m.t === 'peer' && m.state === 'joined')));
check('guest is told it is paired', await waitFor(() => guest.messages.some((m) => m.t === 'paired')));
// v1.4: skill picks are private. Pairing only says *that* someone joined, and
// the roster only reveals other seats' choices as a boolean.
check(
  'pairing no longer leaks the guest skill',
  !host.messages.some((m) => m.t === 'peer' && m.skill),
  JSON.stringify(host.messages.filter((m) => m.t === 'peer'))
);
check(
  'pairing no longer leaks the host skill',
  !guest.messages.some((m) => m.t === 'paired' && m.skill),
  JSON.stringify(guest.messages.filter((m) => m.t === 'paired'))
);
host.send({ t: 'skill', skill: 'rage' });
guest.send({ t: 'skill', skill: 'weaken' });
check(
  'a seat sees its own skill in the roster',
  await waitFor(() => guest.messages.filter((m) => m.t === 'roster').some((m) =>
    m.players.find((p: { id: string }) => p.id === 'p2')?.skill === 'weaken'
  )),
  'own skill missing'
);
check(
  'the host sees every skill (it has to simulate them)',
  await waitFor(() => host.messages.filter((m) => m.t === 'roster').some((m) =>
    m.players.find((p: { id: string }) => p.id === 'p2')?.skill === 'weaken'
  )),
  'host roster missing the guest skill'
);
const guestRoster = guest.messages.filter((m) => m.t === 'roster').pop();
check(
  'a guest never sees another seat skill',
  !!guestRoster && (guestRoster.players.find((p: { id: string }) => p.id === 'p1')?.skill ?? '') === '',
  JSON.stringify(guestRoster?.players)
);
check(
  'but it learns that the seat has picked',
  !!guestRoster && guestRoster.players.find((p: { id: string }) => p.id === 'p1')?.hasSkill === true
);

// --- snapshot relay (host -> guest)
host.send({ t: 'state', seq: 1, level: 0, phase: 'playing', score: 0, crates: [], tanks: [], bullets: [], events: [] });
check('snapshots reach the guest', await waitFor(() => guest.messages.some((m) => m.t === 'state' && m.seq === 1)));

// --- input relay (guest -> host), and only guest -> host
guest.send({ t: 'input', seq: 7, input: { turn: 1, drive: 1, aim: 0.5, fire: true } });
check('input reaches the host', await waitFor(() => host.messages.some((m) => m.t === 'input' && m.seq === 7)));
check(
  'input carries the full control frame',
  JSON.stringify(host.messages.find((m) => m.t === 'input')?.input) === JSON.stringify({ turn: 1, drive: 1, aim: 0.5, fire: true })
);

const guestBefore = guest.messages.length;
host.send({ t: 'input', seq: 99, input: { turn: 0, drive: 0, aim: 0, fire: false } });
await sleep(120);
check('a host can never inject guest input', !guest.messages.slice(guestBefore).some((m) => m.t === 'input'));

// --- restart relay (host -> guest)
host.send({ t: 'restart', level: 2 });
check('restart reaches the guest', await waitFor(() => guest.messages.some((m) => m.t === 'restart' && m.level === 2)));

// --- disconnect handling
const hostBefore = host.messages.length;
guest.close();
check('host is told when the guest leaves', await waitFor(() => host.messages.slice(hostBefore).some((m) => m.t === 'peer' && m.state === 'left')));
check('the room keeps the host but drops the guest', await waitFor(() => server.stats().players === 1, 1500), JSON.stringify(server.stats()));
host.close();
check('the room empties once the host leaves', await waitFor(() => server.stats().players === 0, 1500), JSON.stringify(server.stats()));

// --- a fresh pair still works (no stale state)
await sleep(120);
const host2 = await open(wsUrl);
host2.send({ t: 'join', role: 'host' , version: TANK_VERSION });
const guest2 = await open(wsUrl);
guest2.send({ t: 'join', role: 'guest' , version: TANK_VERSION });
check('a second match can pair up', await waitFor(() => guest2.messages.some((m) => m.t === 'paired')));
host2.send({ t: 'state', seq: 42, level: 1, phase: 'playing', score: 5, crates: [], tanks: [], bullets: [], events: [] });
check('second match relays state', await waitFor(() => guest2.messages.some((m) => m.t === 'state' && m.seq === 42)));
host2.close();
guest2.close();

// --- map transfer: the host pushes the file, every guest confirms it
await sleep(120);
{
  const roomMap = emptyMap({ name: '联机测试图' });
  const mapMsg = { t: 'map', map: roomMap, hash: mapHash(roomMap) };
  const host3 = await open(wsUrl);
  host3.send({ t: 'join', role: 'host', map: roomMap, mapHash: mapHash(roomMap) , version: TANK_VERSION });
  await waitFor(() => host3.messages.some((m) => m.t === 'joined'));

  const guest3 = await open(wsUrl);
  guest3.send({ t: 'join', role: 'guest' , version: TANK_VERSION });
  check('a joining guest receives the room map', await waitFor(() => guest3.messages.some((m) => m.t === 'map')));
  // Seat ids grow across the whole process, so read ours instead of assuming p2.
  const seat3 = guest3.messages.find((m) => m.t === 'joined')?.id as string;
  const arrived = guest3.messages.find((m) => m.t === 'map');
  check('the map arrives with its id', arrived?.map?.id === roomMap.id, JSON.stringify(arrived?.map?.id));
  check('the map arrives with the host hash', arrived?.hash === mapMsg.hash, `${arrived?.hash} vs ${mapMsg.hash}`);
  check('the map arrives with its geometry', JSON.stringify(arrived?.map?.walls) === JSON.stringify(roomMap.walls));

  // Starting before the guest confirms has to be refused.
  host3.send({ t: 'begin' });
  check('begin is refused while the map is unconfirmed', await waitFor(() => host3.messages.some((m) => m.t === 'lobby-error')));
  const pending = host3.messages.find((m) => m.t === 'lobby-error');
  check('the refusal says the map is pending', pending?.reason === 'map-pending', JSON.stringify(pending));
  check('the refusal names the seat that owes an ack', Array.isArray(pending?.waiting) && pending.waiting.includes(seat3), JSON.stringify(pending?.waiting));
  check('nobody was pulled into a match', !guest3.messages.some((m) => m.t === 'begin'));

  // A wrong hash must be reported to the host, not silently accepted.
  guest3.send({ t: 'map-ack', id: roomMap.id, rev: roomMap.rev, hash: 'deadbeef', ok: true });
  check('a mismatched hash is reported', await waitFor(() => host3.messages.some((m) => m.t === 'lobby-error' && m.reason === 'map-failed')));
  check('the mismatch names the seat', host3.messages.find((m) => m.reason === 'map-failed')?.waiting?.includes(seat3));

  // The real ack unlocks the start.
  guest3.send({ t: 'map-ack', id: roomMap.id, rev: roomMap.rev, hash: mapMsg.hash, ok: true });
  check('the host sees the confirmation', await waitFor(() => host3.messages.some((m) => m.t === 'map-status' && m.ready.includes(seat3))));
  host3.send({ t: 'begin' });
  check('begin works once the map is confirmed', await waitFor(() => guest3.messages.some((m) => m.t === 'begin')));

  // A guest may not push a map into the room.
  const beforeBroadcast = guest3.messages.length;
  guest3.send({ t: 'map', map: emptyMap({ name: '捣乱' }), hash: 'x' });
  await sleep(120);
  check('only the host can set the room map', !guest3.messages.slice(beforeBroadcast).some((m) => m.t === 'map'));

  // A newcomer still gets the map (the server caches it).
  const guest4 = await open(wsUrl);
  guest4.send({ t: 'join', role: 'guest' , version: TANK_VERSION });
  check('a late guest also receives the map', await waitFor(() => guest4.messages.some((m) => m.t === 'map')));
  check('the late guest gets the same map', guest4.messages.find((m) => m.t === 'map')?.map?.id === roomMap.id);
  guest4.close();

  // An oversized blob is refused rather than relayed. (Kept under the socket's
  // 64 KB frame cap so this exercises the app-level limit, not the transport.)
  const huge = { ...emptyMap({ name: '太大' }), extra: { pad: 'x'.repeat(52 * 1024) } };
  host3.send({ t: 'map', map: huge, hash: 'huge' });
  check('an oversized map is refused', await waitFor(() => host3.messages.some((m) => m.t === 'lobby-error' && m.reason === 'map-failed' && String(m.detail).includes('太大'))));
  check('the room keeps its previous map', guest3.messages.filter((m) => m.t === 'map').pop()?.map?.id === roomMap.id);

  // Switching back to a built-in map clears the room copy (and its acks), so a
  // later `begin` needs no confirmation at all.
  const beforeClear = guest3.messages.length;
  host3.send({ t: 'map', map: null, hash: '' });
  check('clearing the map reaches the guests', await waitFor(() => guest3.messages.slice(beforeClear).some((m) => m.t === 'map' && m.map === null)));
  const cleared = guest3.messages.slice(beforeClear).find((m) => m.t === 'map');
  check('a cleared map carries no file and no hash', cleared?.map === null && cleared?.hash === '', JSON.stringify(cleared));

  host3.close();
  guest3.close();
}

// --- rooms without a custom map still start instantly
await sleep(120);
{
  const host5 = await open(wsUrl);
  host5.send({ t: 'join', role: 'host' , version: TANK_VERSION });
  await waitFor(() => host5.messages.some((m) => m.t === 'joined'));
  const guest5 = await open(wsUrl);
  guest5.send({ t: 'join', role: 'guest' , version: TANK_VERSION });
  await waitFor(() => guest5.messages.some((m) => m.t === 'paired'));
  host5.send({ t: 'begin' });
  check('a built-in map room starts without any ack', await waitFor(() => guest5.messages.some((m) => m.t === 'begin')));
  host5.close();
  guest5.close();
}

// --- v1.5.1: a dropped guest reconnects into its own seat (no lobby reset)
await sleep(120);
{
  const host6 = await open(wsUrl);
  host6.send({ t: 'join', role: 'host' , version: TANK_VERSION });
  await waitFor(() => host6.messages.some((m) => m.t === 'joined'));
  const guest6 = await open(wsUrl);
  guest6.send({ t: 'join', role: 'guest', session: 'sess-alpha' , version: TANK_VERSION });
  check('a session guest is seated', await waitFor(() => guest6.messages.some((m) => m.t === 'joined' && !m.resumed)));
  const seat = guest6.messages.find((m) => m.t === 'joined' && !m.resumed)?.id;
  host6.send({ t: 'config', mode: 'ffa', capacity: 6, killTarget: 15, timeLimit: 480 });
  host6.send({ t: 'begin' });
  check('the room started', await waitFor(() => guest6.messages.some((m) => m.t === 'begin')));

  // The Wi-Fi dies: the socket goes away, the room keeps the seat.
  guest6.close();
  await waitFor(() => host6.messages.some((m) => m.t === 'peer' && m.state === 'left'));

  const back = await open(wsUrl);
  back.send({ t: 'join', role: 'guest', session: 'sess-alpha' , version: TANK_VERSION });
  check('the reconnect is recognised as a resume', await waitFor(() => back.messages.some((m) => m.t === 'joined' && m.resumed === true)));
  check('it gets the same seat back', back.messages.find((m) => m.t === 'joined')?.id === seat, `${back.messages.find((m) => m.t === 'joined')?.id} vs ${seat}`);

  // The roster must still say the match is running, i.e. nobody is dumped back
  // into the lobby by a one-second hiccup.
  const roster = back.messages.filter((m) => m.t === 'roster').pop();
  check('the room is still in a match after the reconnect', roster?.started === true, JSON.stringify(roster?.started));

  // A *new* session still lands in the lobby (that is not a resume).
  const fresh = await open(wsUrl);
  fresh.send({ t: 'join', role: 'guest', session: 'sess-beta' , version: TANK_VERSION });
  await waitFor(() => fresh.messages.some((m) => m.t === 'joined'));
  const freshRoster = fresh.messages.filter((m) => m.t === 'roster').pop();
  check('a brand-new player still drops the room to the lobby', freshRoster?.started === false);

  // Host -> room results are relayed verbatim.
  const before = back.messages.length;
  host6.send({ t: 'result', winners: [seat ?? 'p2'], draw: false, reason: 'kills', scoreboard: [], elapsed: 42, mode: 'ffa', teams: 2 });
  check('the host\'s verdict reaches the guests', await waitFor(() => back.messages.slice(before).some((m) => m.t === 'result')));
  const relayed = back.messages.slice(before).find((m) => m.t === 'result');
  check('the relayed verdict keeps its numbers', relayed?.winners?.[0] === (seat ?? 'p2') && relayed?.elapsed === 42, JSON.stringify(relayed));
  // ...and a guest cannot fake one.
  const beforeFake = host6.messages.length;
  fresh.send({ t: 'result', winners: ['p1'], draw: false, reason: 'kills', scoreboard: [], elapsed: 1, mode: 'ffa', teams: 2 });
  await sleep(150);
  check('a guest cannot push a verdict', !host6.messages.slice(beforeFake).some((m) => m.t === 'result'));

  host6.close();
  back.close();
  fresh.close();
}

await sleep(100);
await server.close();

// --- v1.5.4: backpressure ----------------------------------------------------
// A relay that never looks at `bufferedAmount` queues minutes of snapshots for a
// client that stopped draining; it then replays them and can never catch up.
//
// The flood is *paced* (~2 MB/s, well above the real 30 Hz snapshot rate but
// far below what a socket can drain): a healthy reader therefore never builds a
// backlog, while a stalled one does. Dumping the same bytes in one tight loop
// would back up even a healthy reader on Windows and prove nothing.
console.log('\nbackpressure');
{
  // `slowBacklog` is raised so the hard cut cannot interrupt the skip phase; both
  // levels are the same code path, only the number differs.
  // v1.6 (review finding 3): the stalled client stops reading, so it also stops
  // answering pings. A long heartbeat keeps the keep-alive cull out of the way on
  // a slow machine; the backpressure logic is what is under test here.
  const slow = await createLanServer({
    port: 0,
    host: '127.0.0.1',
    quiet: true,
    coalesceBacklog: 64 * 1024,
    slowBacklog: 6 * 1024 * 1024,
    heartbeatMs: 10 * 60_000,
  });
  const url = `ws://127.0.0.1:${slow.port}/ws`;
  const host = await open(url);
  host.send({ t: 'join', role: 'host' , version: TANK_VERSION });
  await waitFor(() => host.messages.some((m) => m.t === 'joined'));

  const lagging = await open(url);
  lagging.send({ t: 'join', role: 'guest', session: 'slow-one' , version: TANK_VERSION });
  await waitFor(() => lagging.messages.some((m) => m.t === 'joined'));

  const healthy = await open(url);
  healthy.send({ t: 'join', role: 'guest', session: 'healthy-one' , version: TANK_VERSION });
  await waitFor(() => healthy.messages.some((m) => m.t === 'joined'));

  // Stop reading this socket entirely: frames pile up in the server's send
  // buffer exactly like they do for a stalled machine.
  lagging.ws.pause();

  const pad = 'x'.repeat(30000);
  const paced = async (from: number, count: number, keyframe: boolean): Promise<void> => {
    for (let i = 0; i < count; i += 1) {
      host.send({ t: 'state', seq: from + i, ...(keyframe ? { kf: 1 } : {}), tanks: [], bullets: [], events: [], pad });
      // ~3.5 MB/s: far above the game's 30 Hz cadence, far below what any
      // healthy reader needs in order to keep its own queue at zero.
      await sleep(8);
    }
  };

  // 600 × 30 KB ≈ 18 MB, which is more than any kernel buffer plus 64 KB.
  const FRAMES = 600;
  const KEYFRAME = FRAMES + 1;
  await paced(1, FRAMES, false);
  // The repair frame: a keyframe is never skipped.
  host.send({ t: 'state', seq: KEYFRAME, kf: 1, tanks: [], bullets: [], events: [], pad });
  await sleep(600);

  lagging.ws.resume();
  await sleep(1200);
  const lagStates = lagging.messages.filter((m) => m.t === 'state');
  const lagDeltas = lagStates.filter((m) => m.kf !== 1).length;
  const healthyStates = healthy.messages.filter((m) => m.t === 'state');
  const healthyDeltas = healthyStates.filter((m) => m.kf !== 1).length;
  check('a lagging guest skips backlogged deltas', lagDeltas < FRAMES * 0.9, `received ${lagDeltas}/${FRAMES} deltas`);
  check('a lagging guest still receives the keyframe', lagStates.some((m) => m.kf === 1), `states=${lagStates.length}`);
  check(
    'a healthy guest is unaffected by a lagging one',
    healthyDeltas === FRAMES && healthy.ws.readyState === healthy.ws.OPEN,
    `received ${healthyDeltas}/${FRAMES} deltas`
  );

  const before = Date.now();
  await slow.close();
  const closingMs = Date.now() - before;
  check('closing the server is bounded', closingMs < 3000, `${closingMs}ms`);
  // v1.6 (review finding 5): the normal path must finish through a real
  // completion signal, not by burning the 2 s guard.
  check('closing the server is quick on the normal path', closingMs < 1000, `${closingMs}ms`);
  host.close();
  healthy.close();
  lagging.close();
}

// The hard level: a queue that is hopeless is cut instead of growing forever,
// and the client's own reconnect (v1.5.4) then rebuilds it from a keyframe.
console.log('\nbackpressure · hard limit');
{
  const cut = await createLanServer({
    port: 0,
    host: '127.0.0.1',
    quiet: true,
    slowBacklog: 1024 * 1024,
    heartbeatMs: 10 * 60_000,
  });
  const url = `ws://127.0.0.1:${cut.port}/ws`;
  const host = await open(url);
  host.send({ t: 'join', role: 'host' , version: TANK_VERSION });
  await waitFor(() => host.messages.some((m) => m.t === 'joined'));
  const lagging = await open(url);
  lagging.send({ t: 'join', role: 'guest', session: 'stalled' , version: TANK_VERSION });
  await waitFor(() => lagging.messages.some((m) => m.t === 'joined'));
  const watcher = await open(url);
  watcher.send({ t: 'join', role: 'guest', session: 'watcher' , version: TANK_VERSION });
  await waitFor(() => watcher.messages.some((m) => m.t === 'joined'));
  const stalledSeat = lagging.messages.find((m) => m.t === 'joined')?.id;

  lagging.ws.pause();
  const pad = 'x'.repeat(30000);
  // The survivors are told about the cut, which is how we notice it while the
  // stalled socket is not reading.
  const dropped = () => watcher.messages.some((m) => m.t === 'peer' && m.state === 'left' && m.id === stalledSeat);
  let sent = 0;
  for (; sent < 900 && !dropped(); sent += 1) {
    host.send({ t: 'state', seq: 9000 + sent, kf: 1, tanks: [], bullets: [], events: [], pad });
    await sleep(6);
  }
  check('a hopelessly slow client is disconnected', await waitFor(dropped, 3000), `${sent} keyframes`);
  let closed = false;
  lagging.ws.once('close', () => {
    closed = true;
  });
  // A paused client only learns about the cut once it reads again.
  lagging.ws.resume();
  check('the stalled socket really closes', await waitFor(() => closed, 4000));
  check('the healthy guest is still connected afterwards', watcher.ws.readyState === watcher.ws.OPEN);

  await cut.close();
  host.close();
  watcher.close();
}

// --- v1.6.1: seat numbering and room state across sessions -------------------
// A seat id used to come from a counter that only ever climbed, and an emptied
// room kept the previous session's team count. Both surfaced in the *second*
// match of a server process: the first guest walked in as p4 (so the host's
// first remote tank was a seat the input router did not expect), and a leftover
// 4-team setting made `begin` refuse a three-player room for its empty fourth
// team — "team mode will not start", with the button greyed out to match.
console.log('\nroom state across sessions');
{
  const fresh = await createLanServer({ port: 0, host: '127.0.0.1', quiet: true });
  const url = `ws://127.0.0.1:${fresh.port}/ws`;

  const round1Host = await open(url);
  round1Host.send({ t: 'join', role: 'host' , version: TANK_VERSION });
  await waitFor(() => round1Host.messages.some((m) => m.t === 'joined'));
  const a = await open(url);
  a.send({ t: 'join', role: 'guest', session: 'round1-a' , version: TANK_VERSION });
  const b = await open(url);
  b.send({ t: 'join', role: 'guest', session: 'round1-b' , version: TANK_VERSION });
  await waitFor(() => a.messages.some((m) => m.t === 'joined') && b.messages.some((m) => m.t === 'joined'));
  check(
    'the first session hands out p2 and p3',
    a.messages.find((m) => m.t === 'joined')?.id === 'p2' && b.messages.find((m) => m.t === 'joined')?.id === 'p3',
    `${a.messages.find((m) => m.t === 'joined')?.id},${b.messages.find((m) => m.t === 'joined')?.id}`
  );

  // The host picks four teams, then everybody leaves.
  round1Host.send({ t: 'teams', count: 4 });
  await sleep(150);
  check('the host can raise the team count', round1Host.messages.filter((m) => m.t === 'roster').pop()?.teams === 4);
  a.close();
  b.close();
  round1Host.close();
  await waitFor(() => true, 50);
  await sleep(400);

  // A brand-new session in the same process.
  const round2Host = await open(url);
  round2Host.send({ t: 'join', role: 'host' , version: TANK_VERSION });
  await waitFor(() => round2Host.messages.some((m) => m.t === 'joined'));
  const c = await open(url);
  c.send({ t: 'join', role: 'guest', session: 'round2-c' , version: TANK_VERSION });
  const d = await open(url);
  d.send({ t: 'join', role: 'guest', session: 'round2-d' , version: TANK_VERSION });
  await waitFor(() => c.messages.some((m) => m.t === 'joined') && d.messages.some((m) => m.t === 'joined'));

  check(
    'a new session starts its seats at p2 again',
    c.messages.find((m) => m.t === 'joined')?.id === 'p2' && d.messages.find((m) => m.t === 'joined')?.id === 'p3',
    `${c.messages.find((m) => m.t === 'joined')?.id},${d.messages.find((m) => m.t === 'joined')?.id}`
  );
  const round2Roster = round2Host.messages.filter((m) => m.t === 'roster').pop();
  check('an emptied room forgets the last team count', round2Roster?.teams === 2, `teams=${round2Roster?.teams}`);
  check('an emptied room forgets the last capacity', round2Roster?.capacity === 6, `capacity=${round2Roster?.capacity}`);

  // ...and team mode actually starts on the fresh room state.
  round2Host.send({ t: 'config', mode: 'team', capacity: 6 });
  await sleep(200);
  round2Host.send({ t: 'begin' });
  const started = await waitFor(() => round2Host.messages.some((m) => m.t === 'begin'), 1500);
  const refused = round2Host.messages.some((m) => m.t === 'lobby-error');
  check('a three-player team room starts in the second session', started && !refused, refused ? 'refused' : 'not started');

  c.close();
  d.close();
  round2Host.close();
  await sleep(200);
  await fresh.close();
}

// A dropped seat's number is still reserved for its owner, so a newcomer can
// never be handed an id that is about to resume into it.
console.log('\nseat reservation');
{
  const fresh = await createLanServer({ port: 0, host: '127.0.0.1', quiet: true });
  const url = `ws://127.0.0.1:${fresh.port}/ws`;
  const host = await open(url);
  host.send({ t: 'join', role: 'host' , version: TANK_VERSION });
  await waitFor(() => host.messages.some((m) => m.t === 'joined'));

  const leaver = await open(url);
  leaver.send({ t: 'join', role: 'guest', session: 'keep-me' , version: TANK_VERSION });
  await waitFor(() => leaver.messages.some((m) => m.t === 'joined'));
  check('the leaver takes p2', leaver.messages.find((m) => m.t === 'joined')?.id === 'p2');

  leaver.close();
  await sleep(300);

  const newcomer = await open(url);
  newcomer.send({ t: 'join', role: 'guest', session: 'someone-else' , version: TANK_VERSION });
  await waitFor(() => newcomer.messages.some((m) => m.t === 'joined'));
  const taken = newcomer.messages.find((m) => m.t === 'joined')?.id;
  check('a newcomer cannot take a reserved seat', taken !== 'p2', `got ${taken}`);

  const back = await open(url);
  back.send({ t: 'join', role: 'guest', session: 'keep-me' , version: TANK_VERSION });
  await waitFor(() => back.messages.some((m) => m.t === 'joined'));
  check('the dropped guest still resumes into p2', back.messages.find((m) => m.t === 'joined')?.id === 'p2');

  back.close();
  newcomer.close();
  host.close();
  await sleep(200);
  await fresh.close();
}

// ===========================================================================
// v1.6.2 — the review's server-side findings, each one a live reproduction
// ===========================================================================
console.log('\nmalformed requests (A-3/A-16)');
{
  // The main server has already been torn down above, so use a fresh one.
  const fresh = await createLanServer({ port: 0, host: '127.0.0.1', quiet: true });
  const base = `http://127.0.0.1:${fresh.port}`;
  // One bad URL from any device on the LAN used to hang the request and then
  // kill the whole server process (unhandled rejection from decodeURIComponent).
  for (const bad of ['/%', '/%E0%A4%A', '/%zz', '/%C3%28']) {
    let status = 0;
    try {
      const res = await fetch(`${base}${bad}`, { signal: AbortSignal.timeout(2000) });
      status = res.status;
      await res.text();
    } catch {
      status = -1; // hung or aborted
    }
    check(`a malformed URL is answered, not fatal: ${bad}`, status === 400, `status ${status}`);
  }
  const after = await fetch(`${base}/info`);
  check('the server is still alive after those requests', after.ok);
  check('/info still answers', (await after.json()).ok === true);
  // A sibling directory whose name merely starts with "dist" must not be served.
  const sibling = await fetch(`${base}/%2e%2e%2fdist2%2fpackage.json`);
  check('a sibling directory with a dist prefix is not served', sibling.status !== 200 || !(await sibling.text()).includes('"scripts"'), String(sibling.status));
  await fresh.close();
}

console.log('\nprivilege of a replaced socket (A-2)');
{
  const fresh = await createLanServer({ port: 0, host: '127.0.0.1', quiet: true });
  const url = `ws://127.0.0.1:${fresh.port}/ws`;

  const oldHost = await open(url);
  oldHost.send({ t: 'join', role: 'host', version: TANK_VERSION });
  await waitFor(() => oldHost.messages.some((m) => m.t === 'joined'));

  const guest = await open(url);
  guest.send({ t: 'join', role: 'guest', version: TANK_VERSION });
  await waitFor(() => guest.messages.some((m) => m.t === 'joined'));

  // A second host socket takes the room over (page refresh, new window).
  const newHost = await open(url);
  newHost.send({ t: 'join', role: 'host', version: TANK_VERSION });
  await waitFor(() => newHost.messages.some((m) => m.t === 'joined'));
  check('the old host is told it was replaced', await waitFor(() => oldHost.messages.some((m) => m.t === 'replaced')));

  const before = guest.messages.length;
  oldHost.send({ t: 'state', kf: 1, tanks: [] });
  oldHost.send({ t: 'config', mode: 'team', capacity: 8 });
  await sleep(200);
  const leaked = guest.messages.slice(before).filter((m) => m.t === 'state' || m.t === 'config');
  check('a replaced host can no longer broadcast snapshots', !leaked.some((m) => m.t === 'state'), JSON.stringify(leaked));
  check('a replaced host can no longer change the room', !leaked.some((m) => m.t === 'config'), JSON.stringify(leaked));

  // Same for a guest seat: the old socket must stop driving the tank.
  const original = await open(url);
  original.send({ t: 'join', role: 'guest', version: TANK_VERSION, session: 'seat-x' });
  await waitFor(() => original.messages.some((m) => m.t === 'joined'));
  const seat = original.messages.find((m) => m.t === 'joined')?.id;
  const takeover = await open(url);
  takeover.send({ t: 'join', role: 'guest', version: TANK_VERSION, session: 'seat-x' });
  await waitFor(() => takeover.messages.some((m) => m.t === 'joined'));
  check('the same token takes its own seat back', takeover.messages.find((m) => m.t === 'joined')?.id === seat, String(seat));
  check('no extra seat was created for the same token', fresh.stats().players === 3, JSON.stringify(fresh.stats()));

  const mark = newHost.messages.length;
  original.send({ t: 'input', input: { turn: 1, drive: 1, aim: 0, fire: false }, seq: 1 });
  await sleep(200);
  check(
    'a replaced guest can no longer send input',
    !newHost.messages.slice(mark).some((m) => m.t === 'input'),
    JSON.stringify(newHost.messages.slice(mark))
  );

  original.close();
  takeover.close();
  guest.close();
  newHost.close();
  await sleep(200);
  await fresh.close();
}

console.log('\nfake surrender (A-1)');
{
  const fresh = await createLanServer({ port: 0, host: '127.0.0.1', quiet: true });
  const url = `ws://127.0.0.1:${fresh.port}/ws`;
  const host = await open(url);
  host.send({ t: 'join', role: 'host', version: TANK_VERSION });
  await waitFor(() => host.messages.some((m) => m.t === 'joined'));
  const guest = await open(url);
  guest.send({ t: 'join', role: 'guest', version: TANK_VERSION });
  await waitFor(() => guest.messages.some((m) => m.t === 'joined'));

  // A device that never joined sends "the host surrendered".
  const stranger = await open(url);
  stranger.send({ t: 'surrender', by: 'p1' });
  await sleep(250);
  check('a naked socket cannot surrender for somebody else', !guest.messages.some((m) => m.t === 'surrender'), JSON.stringify(guest.messages));
  check('...and the room is untouched', fresh.stats().players === 2, JSON.stringify(fresh.stats()));
  stranger.close();

  // A real seat still can, and the server says who it really was.
  guest.send({ t: 'surrender', by: 'p1' });
  const real = await waitFor(() => host.messages.some((m) => m.t === 'surrender'), 1500);
  check('a seated player can still surrender', real);
  check(
    'the surrender names the seat that actually sent it',
    host.messages.find((m) => m.t === 'surrender')?.by === 'p2',
    String(host.messages.find((m) => m.t === 'surrender')?.by)
  );

  host.close();
  await sleep(150);
  await fresh.close();
}

console.log('\njoin is idempotent (A-10)');
{
  const fresh = await createLanServer({ port: 0, host: '127.0.0.1', quiet: true });
  const url = `ws://127.0.0.1:${fresh.port}/ws`;
  const host = await open(url);
  host.send({ t: 'join', role: 'host', version: TANK_VERSION });
  await waitFor(() => host.messages.some((m) => m.t === 'joined'));

  const twice = await open(url);
  twice.send({ t: 'join', role: 'guest', version: TANK_VERSION });
  await waitFor(() => twice.messages.some((m) => m.t === 'joined'));
  twice.send({ t: 'join', role: 'guest', version: TANK_VERSION });
  twice.send({ t: 'join', role: 'host', version: TANK_VERSION });
  await sleep(250);
  check('joining twice on one socket does not take a second seat', fresh.stats().players === 2, JSON.stringify(fresh.stats()));
  check('the room still has its host', host.messages.some((m) => m.t === 'joined'));

  // ...and it does not leave a zombie behind: everyone can leave cleanly.
  twice.close();
  await sleep(250);
  check('leaving frees the only guest seat', fresh.stats().players === 1, JSON.stringify(fresh.stats()));

  host.close();
  await sleep(150);
  await fresh.close();
}

console.log('\nbegin is idempotent (A-12)');
{
  const fresh = await createLanServer({ port: 0, host: '127.0.0.1', quiet: true });
  const url = `ws://127.0.0.1:${fresh.port}/ws`;
  const host = await open(url);
  host.send({ t: 'join', role: 'host', version: TANK_VERSION });
  await waitFor(() => host.messages.some((m) => m.t === 'joined'));

  host.send({ t: 'begin' });
  await sleep(250);
  check('FFA with one player is not a match', !host.messages.some((m) => m.t === 'begin'), JSON.stringify(host.messages));
  check(
    'the refusal says why',
    host.messages.some((m) => m.t === 'lobby-error' && m.reason === 'solo'),
    JSON.stringify(host.messages.filter((m) => m.t === 'lobby-error'))
  );

  const guest = await open(url);
  guest.send({ t: 'join', role: 'guest', version: TANK_VERSION });
  await waitFor(() => guest.messages.some((m) => m.t === 'joined'));
  host.send({ t: 'begin' });
  await waitFor(() => guest.messages.some((m) => m.t === 'begin'), 1500);
  host.send({ t: 'begin' });
  await sleep(250);
  check('a double click begins once', guest.messages.filter((m) => m.t === 'begin').length === 1, String(guest.messages.filter((m) => m.t === 'begin').length));

  guest.close();
  host.close();
  await sleep(150);
  await fresh.close();
}

console.log('\nversion gate needs a version (A-13)');
{
  const fresh = await createLanServer({ port: 0, host: '127.0.0.1', quiet: true });
  const url = `ws://127.0.0.1:${fresh.port}/ws`;
  const host = await open(url);
  host.send({ t: 'join', role: 'host', version: TANK_VERSION });
  await waitFor(() => host.messages.some((m) => m.t === 'joined'));

  const silent = await open(url);
  silent.send({ t: 'join', role: 'guest' });
  const refused = await waitFor(() => silent.messages.some((m) => m.t === 'reject'), 1500);
  check('a guest that sends no version is refused', refused && silent.messages.find((m) => m.t === 'reject')?.reason === 'version');
  check('...and takes no seat', fresh.stats().players === 1, JSON.stringify(fresh.stats()));

  silent.close();
  host.close();
  await sleep(150);
  await fresh.close();
}

console.log('\ncapacity, teams and seat limits (A-14/A-15/A-21)');
{
  const fresh = await createLanServer({ port: 0, host: '127.0.0.1', quiet: true });
  const url = `ws://127.0.0.1:${fresh.port}/ws`;
  const host = await open(url);
  host.send({ t: 'join', role: 'host', version: TANK_VERSION });
  await waitFor(() => host.messages.some((m) => m.t === 'joined'));
  const guests = [];
  for (let i = 0; i < 3; i += 1) {
    const g = await open(url);
    g.send({ t: 'join', role: 'guest', version: TANK_VERSION });
    await waitFor(() => g.messages.some((m) => m.t === 'joined'));
    guests.push(g);
  }

  host.send({ t: 'config', capacity: 2, mode: 'ffa' });
  await sleep(250);
  check(
    'the room cannot be shrunk below its players',
    host.messages.some((m) => m.t === 'lobby-error' && m.reason === 'capacity'),
    JSON.stringify(host.messages.filter((m) => m.t === 'lobby-error'))
  );
  const roster = host.messages.filter((m) => m.t === 'roster').pop();
  check('...and the capacity keeps up with the room', roster?.capacity === 4, String(roster?.capacity));

  // FFA has no teams: auto-balance must not invent team 7.
  host.send({ t: 'teams', count: 2 });
  host.send({ t: 'auto-teams' });
  await sleep(250);
  const ffaRoster = host.messages.filter((m) => m.t === 'roster').pop();
  check('auto-teams in FFA keeps everybody on team 0', ffaRoster?.players.every((p: { team: number }) => p.team === 0), JSON.stringify(ffaRoster?.players));

  // Ten seats and no p11.
  host.send({ t: 'config', capacity: 10, mode: 'ffa' });
  await sleep(150);
  const more = [];
  for (let i = 0; i < 6; i += 1) {
    const g = await open(url);
    g.send({ t: 'join', role: 'guest', version: TANK_VERSION });
    await waitFor(() => g.messages.some((m) => m.t === 'joined' || m.t === 'reject'), 1200);
    more.push(g);
  }
  const overflow = await open(url);
  overflow.send({ t: 'join', role: 'guest', version: TANK_VERSION });
  await waitFor(() => overflow.messages.some((m) => m.t === 'joined' || m.t === 'reject'), 1500);
  const ids = [...guests, ...more].map((g) => g.messages.find((m) => m.t === 'joined')?.id).filter(Boolean);
  check('every seat is inside p2…p10', ids.every((id) => /^p([2-9]|10)$/.test(String(id))), JSON.stringify(ids));
  check('a full house is refused instead of inventing p11', overflow.messages.some((m) => m.t === 'reject'), JSON.stringify(overflow.messages));

  overflow.close();
  for (const g of [...guests, ...more]) g.close();
  host.close();
  await sleep(200);
  await fresh.close();
}

console.log('\ntwo servers in one process (A-20)');
{
  // The room used to be module-level state: the second server shared the first
  // one's players, which is what made a few review scenarios look like game bugs.
  const a = await createLanServer({ port: 0, host: '127.0.0.1', quiet: true });
  const b = await createLanServer({ port: 0, host: '127.0.0.1', quiet: true });
  const guestA = await open(`ws://127.0.0.1:${a.port}/ws`);
  guestA.send({ t: 'join', role: 'host', version: TANK_VERSION });
  await waitFor(() => guestA.messages.some((m) => m.t === 'joined'));
  check('the first server has the host', a.stats().players === 1, JSON.stringify(a.stats()));
  check('the second server is still empty', b.stats().players === 0, JSON.stringify(b.stats()));
  const infoB = await fetch(`http://127.0.0.1:${b.port}/info`).then((r) => r.json() as Promise<{ players: number }>);
  check('/info is per server too', infoB.players === 0, JSON.stringify(infoB));
  guestA.close();
  await sleep(150);
  await a.close();
  await b.close();
}

console.log('\nclosing frees the port at once (A-17)');
{
  const first = await createLanServer({ port: 0, host: '127.0.0.1', quiet: true });
  const port = first.port;
  await first.close();
  let rebound = false;
  try {
    const second = await createLanServer({ port, host: '127.0.0.1', quiet: true });
    rebound = true;
    await second.close();
  } catch {
    rebound = false;
  }
  check('the same port can be used again immediately', rebound);
}

console.log('\nmap checklist after a departure (A-4)');
{
  const fresh = await createLanServer({ port: 0, host: '127.0.0.1', quiet: true });
  const url = `ws://127.0.0.1:${fresh.port}/ws`;
  const host = await open(url);
  host.send({ t: 'join', role: 'host', version: TANK_VERSION });
  await waitFor(() => host.messages.some((m) => m.t === 'joined'));
  const guest = await open(url);
  guest.send({ t: 'join', role: 'guest', version: TANK_VERSION });
  await waitFor(() => guest.messages.some((m) => m.t === 'joined'));

  const custom = emptyMap({ name: 'waiting-room' });
  host.send({ t: 'map', map: custom, hash: mapHash(custom) });
  await waitFor(() => host.messages.some((m) => m.t === 'map-status' && m.waiting.length === 1), 1500);
  check('the host sees the guest owing an ack', host.messages.some((m) => m.t === 'map-status' && m.waiting.length === 1));

  guest.close();
  const cleared = await waitFor(
    () => host.messages.filter((m) => m.t === 'map-status').pop()?.waiting.length === 0,
    1500
  );
  check('the departure clears the map checklist', cleared, JSON.stringify(host.messages.filter((m) => m.t === 'map-status')));

  // A second player walks in and confirms the map, so the room can start.
  const next = await open(url);
  next.send({ t: 'join', role: 'guest', version: TANK_VERSION });
  const mapMsg = await waitFor(() => next.messages.some((m) => m.t === 'map'), 1500);
  check('a late joiner is handed the room map', mapMsg);
  next.send({ t: 'map-ack', id: custom.id, rev: custom.rev, hash: mapHash(custom), ok: true });
  await sleep(150);
  host.send({ t: 'begin' });
  check('and the room can start', await waitFor(() => host.messages.some((m) => m.t === 'begin'), 1500), JSON.stringify(host.messages.filter((m) => m.t === 'lobby-error')));
  next.close();

  host.close();
  await sleep(150);
  await fresh.close();
}

// v1.6.4: reservations must never fake a full room -----------------------
//
// v1.6.2 refused a join when no seat id was free, but a seat whose owner had
// left stays reserved for two minutes (so a reconnect lands back in its own
// tank). Nine guests in and out inside that window — one evening of play —
// reserved p2…p10 and the room then refused *everybody* with "every seat is
// taken" while it was visibly empty. Reported as "team mode can never fill up".
console.log('\nseat reservations do not fake a full room (v1.6.4)');
{
  const fresh = await createLanServer({ port: 0, host: '127.0.0.1', quiet: true });
  const url = `ws://127.0.0.1:${fresh.port}/ws`;
  const host = await open(url);
  host.send({ t: 'join', role: 'host', version: TANK_VERSION });
  await waitFor(() => host.messages.some((m) => m.t === 'joined'));
  // Room big enough that a seat shortage can only come from reservations.
  host.send({ t: 'config', capacity: 10, mode: 'team', teams: 2, roomName: 'seats' });
  await sleep(80);

  // Ten guests in and out: ten reservations cover every seat there is, which is
  // what an evening of play does. (Nine was not enough to fill p2…p11, which is
  // exactly the off-by-one below.)
  const used: string[] = [];
  const refusals: string[] = [];
  for (let index = 0; index < 10; index += 1) {
    const guest = await open(url);
    guest.send({ t: 'join', role: 'guest', version: TANK_VERSION, session: `left-${index}` });
    await waitFor(() => guest.messages.some((m) => m.t === 'joined' || m.t === 'reject'), 2000);
    const joined = guest.messages.find((m) => m.t === 'joined');
    if (joined) used.push(String(joined.id));
    else refusals.push(JSON.stringify(guest.messages.find((m) => m.t === 'reject')));
    guest.close();
    await sleep(50);
  }
  check('ten guests in and out never ran out of seats', refusals.length === 0, refusals.join(' '));
  check('they reused the nine real seats', new Set(used).size === 9, used.join(','));
  check('no seat outside p2…p10 was handed out', used.every((id) => /^p([2-9]|10)$/.test(id)), used.join(','));

  const late = await open(url);
  late.send({ t: 'join', role: 'guest', version: TANK_VERSION, session: 'late-arrival' });
  await waitFor(() => late.messages.some((m) => m.t === 'joined' || m.t === 'reject'), 2000);
  const lateReject = late.messages.find((m) => m.t === 'reject');
  const lateJoin = late.messages.find((m) => m.t === 'joined');
  check('an empty room still seats a newcomer after ten reservations', !lateReject && !!lateJoin, JSON.stringify(late.messages));
  check('the newcomer gets one of the reserved seats back', typeof lateJoin?.id === 'string' && used.includes(lateJoin.id), `${lateJoin?.id} vs ${used.join(',')}`);

  const roster = host.messages.filter((m) => m.t === 'roster').pop();
  const ids = (roster?.players ?? []).map((p: { id: string }) => p.id);
  check('the host sees exactly the two of them', ids.length === 2 && ids.includes('p1'), JSON.stringify(ids));

  // The room is genuinely full once the capacity is reached: the refusal has to
  // stay a refusal (no seat may be minted outside p2…p10).
  const crowd: Box[] = [];
  for (let index = 0; index < 8; index += 1) {
    const guest = await open(url);
    guest.send({ t: 'join', role: 'guest', version: TANK_VERSION, session: `crowd-${index}` });
    await waitFor(() => guest.messages.some((m) => m.t === 'joined' || m.t === 'reject'), 1500);
    crowd.push(guest);
  }
  const overflow = await open(url);
  overflow.send({ t: 'join', role: 'guest', version: TANK_VERSION, session: 'overflow' });
  await waitFor(() => overflow.messages.some((m) => m.t === 'joined' || m.t === 'reject'), 1500);
  const overflowReject = overflow.messages.find((m) => m.t === 'reject');
  check('a genuinely full room still refuses, and says why', overflowReject?.reason === 'full', JSON.stringify(overflow.messages));
  const seats = [...crowd, late].map((box) => box.messages.find((m) => m.t === 'joined')?.id).filter(Boolean);
  check('every seat handed out stays inside p2…p10', seats.every((id) => /^p([2-9]|10)$/.test(String(id))), seats.join(','));

  overflow.close();
  for (const box of crowd) box.close();
  late.close();
  host.close();
  await sleep(150);
  await fresh.close();
}

const failed = checks.filter((c) => !c.ok);
console.log('');
console.log(`${checks.length - failed.length}/${checks.length} LAN checks passed`);
if (failed.length) throw new Error('LAN test failed');
console.log('lan ok');
// v1.5.4: a wedged handle (an HTTP keep-alive socket, a half-closed ws) used to
// keep this process alive forever after the summary was printed.
setTimeout(() => process.exit(0), 250).unref();
