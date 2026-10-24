/**
 * Headless LAN tests: starts the real relay server on an ephemeral port and
 * drives it with two WebSocket clients (host + guest).
 *
 *   npm run lantest
 */
import WebSocket from 'ws';
import { createLanServer } from '../server/lan-server.mjs';

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

const pageRes = await fetch(`http://127.0.0.1:${server.port}/`);
check('/ serves the game (or a build hint)', pageRes.ok, String(pageRes.status));
const traversal = await fetch(`http://127.0.0.1:${server.port}/../package.json`);
check('path traversal is blocked', traversal.status === 200 && !(await traversal.text()).includes('"scripts"'), String(traversal.status));

// --- pairing
const host = await open(wsUrl);
host.send({ t: 'join', role: 'host' });
check('host gets a joined ack', await waitFor(() => host.messages.some((m) => m.t === 'joined')), JSON.stringify(host.messages));
check('host ack says nobody has joined yet', host.messages.find((m) => m.t === 'joined')?.guest === false);

const guest = await open(wsUrl);
guest.send({ t: 'join', role: 'guest' });
check('guest gets a joined ack', await waitFor(() => guest.messages.some((m) => m.t === 'joined')));
check('guest ack sees the host present', guest.messages.find((m) => m.t === 'joined')?.host === true);
check('host is told the guest arrived', await waitFor(() => host.messages.some((m) => m.t === 'peer' && m.state === 'joined')));
check('guest is told it is paired', await waitFor(() => guest.messages.some((m) => m.t === 'paired')));

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

await sleep(100);
await server.close();

const failed = checks.filter((c) => !c.ok);
console.log('');
console.log(`${checks.length - failed.length}/${checks.length} LAN checks passed`);
if (failed.length) throw new Error('LAN test failed');
console.log('lan ok');
