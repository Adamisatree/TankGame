/**
 * Headless LAN tests: starts the real relay server on an ephemeral port and
 * drives it with two WebSocket clients (host + guest).
 *
 *   npm run lantest
 */
import { readFile } from 'node:fs/promises';
import WebSocket from 'ws';
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
host.send({ t: 'join', role: 'host', skill: 'rage' });
check('host gets a joined ack', await waitFor(() => host.messages.some((m) => m.t === 'joined')), JSON.stringify(host.messages));
check('host ack says nobody has joined yet', host.messages.find((m) => m.t === 'joined')?.guest === false);

const guest = await open(wsUrl);
guest.send({ t: 'join', role: 'guest', skill: 'weaken' });
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
host2.send({ t: 'join', role: 'host' });
const guest2 = await open(wsUrl);
guest2.send({ t: 'join', role: 'guest' });
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
  host3.send({ t: 'join', role: 'host', map: roomMap, mapHash: mapHash(roomMap) });
  await waitFor(() => host3.messages.some((m) => m.t === 'joined'));

  const guest3 = await open(wsUrl);
  guest3.send({ t: 'join', role: 'guest' });
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
  guest4.send({ t: 'join', role: 'guest' });
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
  host5.send({ t: 'join', role: 'host' });
  await waitFor(() => host5.messages.some((m) => m.t === 'joined'));
  const guest5 = await open(wsUrl);
  guest5.send({ t: 'join', role: 'guest' });
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
  host6.send({ t: 'join', role: 'host' });
  await waitFor(() => host6.messages.some((m) => m.t === 'joined'));
  const guest6 = await open(wsUrl);
  guest6.send({ t: 'join', role: 'guest', session: 'sess-alpha' });
  check('a session guest is seated', await waitFor(() => guest6.messages.some((m) => m.t === 'joined' && !m.resumed)));
  const seat = guest6.messages.find((m) => m.t === 'joined' && !m.resumed)?.id;
  host6.send({ t: 'config', mode: 'ffa', capacity: 6, killTarget: 15, timeLimit: 480 });
  host6.send({ t: 'begin' });
  check('the room started', await waitFor(() => guest6.messages.some((m) => m.t === 'begin')));

  // The Wi-Fi dies: the socket goes away, the room keeps the seat.
  guest6.close();
  await waitFor(() => host6.messages.some((m) => m.t === 'peer' && m.state === 'left'));

  const back = await open(wsUrl);
  back.send({ t: 'join', role: 'guest', session: 'sess-alpha' });
  check('the reconnect is recognised as a resume', await waitFor(() => back.messages.some((m) => m.t === 'joined' && m.resumed === true)));
  check('it gets the same seat back', back.messages.find((m) => m.t === 'joined')?.id === seat, `${back.messages.find((m) => m.t === 'joined')?.id} vs ${seat}`);

  // The roster must still say the match is running, i.e. nobody is dumped back
  // into the lobby by a one-second hiccup.
  const roster = back.messages.filter((m) => m.t === 'roster').pop();
  check('the room is still in a match after the reconnect', roster?.started === true, JSON.stringify(roster?.started));

  // A *new* session still lands in the lobby (that is not a resume).
  const fresh = await open(wsUrl);
  fresh.send({ t: 'join', role: 'guest', session: 'sess-beta' });
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
// The watermarks are injected tiny here so both levels fire deterministically
// (the kernel only starts reporting a backlog once its own buffer is full, so
// the flood is deliberately large).
console.log('\nbackpressure');
{
  const slow = await createLanServer({
    port: 0,
    host: '127.0.0.1',
    quiet: true,
    coalesceBacklog: 4 * 1024,
    slowBacklog: 512 * 1024,
  });
  const url = `ws://127.0.0.1:${slow.port}/ws`;
  const host = await open(url);
  host.send({ t: 'join', role: 'host' });
  await waitFor(() => host.messages.some((m) => m.t === 'joined'));

  const lagging = await open(url);
  lagging.send({ t: 'join', role: 'guest', session: 'slow-one' });
  await waitFor(() => lagging.messages.some((m) => m.t === 'joined'));

  const healthy = await open(url);
  healthy.send({ t: 'join', role: 'guest', session: 'healthy-one' });
  await waitFor(() => healthy.messages.some((m) => m.t === 'joined'));

  // v1.5.4: stop reading this socket entirely, so the host's frames pile up in
  // the server's send buffer exactly like they do for a stalled machine.
  lagging.ws.pause();

  const DELTAS = 2000;
  const pad = 'x'.repeat(7000);
  for (let i = 1; i <= DELTAS; i += 1) {
    host.send({ t: 'state', seq: i, tanks: [], bullets: [], events: [], pad });
    if (i % 100 === 0) await sleep(4);
  }
  // The repair frame: a keyframe is never skipped.
  host.send({ t: 'state', seq: DELTAS + 1, kf: 1, tanks: [], bullets: [], events: [], pad });
  await sleep(500);

  lagging.ws.resume();
  await sleep(600);
  const lagStates = lagging.messages.filter((m) => m.t === 'state');
  const lagDeltas = lagStates.filter((m) => m.kf !== 1).length;
  check(
    'a lagging guest skips backlogged deltas',
    lagDeltas < DELTAS * 0.9,
    `received ${lagDeltas}/${DELTAS} deltas`
  );
  check('a lagging guest still receives the keyframe', lagStates.some((m) => m.kf === 1), `states=${lagStates.length}`);
  check(
    'a healthy guest is unaffected by a lagging one',
    healthy.messages.filter((m) => m.t === 'state').length >= DELTAS * 0.9,
    `received ${healthy.messages.filter((m) => m.t === 'state').length}/${DELTAS + 1}`
  );

  // Hopelessly behind: the queue is cut instead of growing forever, and the
  // client's own reconnect (v1.5.4) then rebuilds it from a keyframe.
  lagging.ws.pause();
  let closed = false;
  lagging.ws.once('close', () => {
    closed = true;
  });
  for (let i = 0; i < 1600; i += 1) {
    host.send({ t: 'state', seq: 5000 + i, kf: 1, tanks: [], bullets: [], events: [], pad });
    if (i % 100 === 0) await sleep(4);
  }
  await sleep(300);
  // A paused client only learns about the cut once it reads again.
  lagging.ws.resume();
  check('a hopelessly slow client is disconnected', await waitFor(() => closed, 5000));

  const before = Date.now();
  await slow.close();
  check('closing the server is bounded', Date.now() - before < 3000, `${Date.now() - before}ms`);
  host.close();
  healthy.close();
}

const failed = checks.filter((c) => !c.ok);
console.log('');
console.log(`${checks.length - failed.length}/${checks.length} LAN checks passed`);
if (failed.length) throw new Error('LAN test failed');
console.log('lan ok');
// v1.5.4: a wedged handle (an HTTP keep-alive socket, a half-closed ws) used to
// keep this process alive forever after the summary was printed.
setTimeout(() => process.exit(0), 250).unref();
