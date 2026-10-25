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

await sleep(100);
await server.close();

const failed = checks.filter((c) => !c.ok);
console.log('');
console.log(`${checks.length - failed.length}/${checks.length} LAN checks passed`);
if (failed.length) throw new Error('LAN test failed');
console.log('lan ok');
