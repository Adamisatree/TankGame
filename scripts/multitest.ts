/**
 * v1.3 multi-player LAN tests: drives the real relay server with 2–10 clients.
 *
 *   npm run multitest
 */
import WebSocket from 'ws';
import { createLanServer } from '../server/lan-server.mjs';

const checks: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  checks.push({ name, ok, detail });
}
async function waitFor(predicate: () => boolean, timeout = 2500): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return predicate();
}

type Client = { messages: any[]; send: (m: unknown) => void; close: () => void; id?: string };

async function open(url: string): Promise<Client> {
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
  return { messages, send: (m) => ws.send(JSON.stringify(m)), close: () => ws.close() };
}

const server = await createLanServer({ port: 0, host: '127.0.0.1', quiet: true });
const wsUrl = `ws://127.0.0.1:${server.port}/ws`;
const info = await (await fetch(`http://127.0.0.1:${server.port}/info`)).json();

check('/info reports a room capacity', typeof info.capacity === 'number' && info.capacity >= 2, JSON.stringify(info.capacity));
check('/info lists an empty roster', Array.isArray(info.roster) && info.roster.length === 0);

// --- 1. A 2-player match still works exactly as before.
const host = await open(wsUrl);
host.send({ t: 'join', role: 'host', version: info.version });
host.id = 'p1';
check('the host is seated as p1', await waitFor(() => host.messages.some((m) => m.t === 'joined' && m.id === 'p1')));

// The host owns the room size; open it up to the full ten.
host.send({ t: 'config', mode: 'ffa', capacity: 10, killTarget: 15, timeLimit: 480, friendlyFire: false, selfDamage: true });
await waitFor(() => host.messages.some((m) => m.t === 'config' || m.t === 'roster'));

const g2 = await open(wsUrl);
g2.send({ t: 'join', role: 'guest', version: info.version, skill: 'rage' });
g2.id = 'p2';
check('a guest gets the next seat', await waitFor(() => g2.messages.some((m) => m.t === 'joined' && m.id === 'p2')));
check('the host sees the roster grow', await waitFor(() => {
  const last = host.messages.filter((m) => m.t === 'roster').pop();
  return !!last && last.players.length === 2;
}));
check('the roster names both seats', (() => {
  const last = host.messages.filter((m) => m.t === 'roster').pop();
  return last?.players.map((p: any) => p.id).join(',') === 'p1,p2';
})());

// --- 2. Grow to 10 players; the 11th is refused.
const guests: Client[] = [];
for (let i = 0; i < 9; i += 1) {
  const client = await open(wsUrl);
  client.send({ t: 'join', role: 'guest', version: info.version });
  await waitFor(() => client.messages.some((m) => m.t === 'joined' || m.t === 'reject'), 1200);
  guests.push(client);
}
await waitFor(() => {
  const last = host.messages.filter((m) => m.t === 'roster').pop();
  return last?.players.length === 10;
}, 2000);
const rosterNow = host.messages.filter((m) => m.t === 'roster').pop();
check('ten players fit in one room', rosterNow?.players.length === 10, `${rosterNow?.players.length}`);
check('every seat id is unique', new Set(rosterNow?.players.map((p: any) => p.id)).size === 10);

const extra = await open(wsUrl);
extra.send({ t: 'join', role: 'guest', version: info.version });
const full = await waitFor(() => extra.messages.some((m) => m.t === 'reject'), 2000);
check('an eleventh player is refused', full && extra.messages.find((m) => m.t === 'reject')?.reason === 'full', JSON.stringify(extra.messages));
check('a refused player never joins the roster', !extra.messages.some((m) => m.t === 'joined'));
extra.close();
await new Promise((r) => setTimeout(r, 80));
check('the room is still full at ten', server.stats().players === 10, JSON.stringify(server.stats()));

// --- 3. Team mode: the host sets the config, everyone gets it, teams alternate.
host.send({ t: 'config', mode: 'team', capacity: 10, killTarget: 15, timeLimit: 480, friendlyFire: false, selfDamage: true });
check('the config is broadcast to guests', await waitFor(() => g2.messages.some((m) => m.t === 'config' && m.config.mode === 'team')));
const teamRoster = host.messages.filter((m) => m.t === 'roster').pop();
const teams = teamRoster?.players.map((p: any) => p.team) ?? [];
check('teams alternate across the roster', teams.join(',') === '0,1,0,1,0,1,0,1,0,1', teams.join(','));
check('the team roster is identical for a guest', (() => {
  const guestRoster = g2.messages.filter((m) => m.t === 'roster').pop();
  return JSON.stringify(guestRoster?.players) === JSON.stringify(teamRoster?.players);
})());

// --- 4. Input is relayed to the host with the sender's id.
g2.send({ t: 'input', seq: 7, input: { turn: 1, drive: 1, aim: 0, fire: false } });
check('the host receives input tagged with the sender', await waitFor(() => host.messages.some((m) => m.t === 'input' && m.from === 'p2' && m.seq === 7)));
check('guests never receive raw input', !g2.messages.some((m) => m.t === 'input'));

// --- 5. The host's snapshot reaches every guest.
host.send({ t: 'state', seq: 1, tanks: [{ id: 'p1' }, { id: 'p2' }], bullets: [], phase: 'playing', level: 0 });
const gotState = await Promise.all(guests.slice(0, 3).map((c) => waitFor(() => c.messages.some((m) => m.t === 'state'), 1500)));
check('snapshots fan out to every guest', gotState.every(Boolean), JSON.stringify(gotState));

// --- 6. A player leaving is reported as a surrender to everyone else.
const leaver = guests[0];
const beforeSurrender = host.messages.length;
leaver.send({ t: 'surrender' });
check('leaving broadcasts a surrender', await waitFor(() => host.messages.slice(beforeSurrender).some((m) => m.t === 'surrender'), 2000));
check('the surrender names who left', host.messages.filter((m) => m.t === 'surrender').pop()?.by === 'p3', JSON.stringify(host.messages.filter((m) => m.t === 'surrender')));
check('the room shrinks after the surrender', await waitFor(() => server.stats().players === 9, 2000), JSON.stringify(server.stats()));

// --- 7. Capacity is enforced from the host's own setting.
host.send({ t: 'config', mode: 'ffa', capacity: 3 });
await waitFor(() => server.stats().players <= 10);
const squeeze = await open(wsUrl);
squeeze.send({ t: 'join', role: 'guest', version: info.version });
check('a smaller capacity shuts the door early', await waitFor(() => squeeze.messages.some((m) => m.t === 'reject'), 2000), JSON.stringify(squeeze.messages.slice(-2)));
squeeze.close();

// --- 7b. Lobby: per-seat skills, teams, ready, begin.
{
  const lastRoster = () => host.messages.filter((m) => m.t === 'roster').pop();

  // The room starts in the lobby.
  check('the room reports a lobby state', lastRoster()?.started === false, JSON.stringify(lastRoster()?.started));

  // Each player owns their own skill: the guest changes it, only their seat moves.
  g2.send({ t: 'skill', skill: 'shield' });
  check(
    'a guest can change its own skill',
    await waitFor(() => lastRoster()?.players.find((p: { id: string }) => p.id === 'p2')?.skill === 'shield', 1500)
  );
  check(
    'nobody else\'s skill changes',
    lastRoster()?.players.find((p: { id: string }) => p.id === 'p3')?.skill !== 'shield'
  );

  // Teams: only the host may re-seat a player.
  host.send({ t: 'config', mode: 'team', capacity: 10, killTarget: 15, timeLimit: 480, friendlyFire: false, selfDamage: true });
  await waitFor(() => lastRoster()?.mode === 'team', 1500);
  // Pick a seat that actually exists in the (shrunken) room.
  const others = (lastRoster()?.players ?? []).filter((p: { id: string; host?: boolean }) => !p.host);
  const target = others[others.length - 1]?.id ?? 'p2';
  const teamOf = () => lastRoster()?.players.find((p: { id: string }) => p.id === target)?.team;
  const before = teamOf();
  g2.send({ t: 'team', id: target, team: before === 0 ? 1 : 0 });
  await new Promise((r) => setTimeout(r, 250));
  check('a guest cannot move a player between teams', teamOf() === before, JSON.stringify({ target, before, after: teamOf() }));
  const wanted = before === 0 ? 1 : 0;
  host.send({ t: 'team', id: target, team: wanted });
  check(
    'the host can move a player between teams',
    await waitFor(() => teamOf() === wanted, 1500),
    JSON.stringify({ target, before, wanted, after: teamOf() })
  );

  // Ready state is per seat.
  g2.send({ t: 'ready', ready: true });
  check(
    'a guest can mark itself ready',
    await waitFor(() => lastRoster()?.players.find((p: { id: string }) => p.id === 'p2')?.ready === true, 1500)
  );
  check('the host counts as ready', lastRoster()?.players.find((p: { id: string }) => p.id === 'p1')?.ready === true);

  // Only the host can start, and everyone is told.
  g2.send({ t: 'begin' });
  await new Promise((r) => setTimeout(r, 200));
  check('a guest cannot start the match', lastRoster()?.started === false);
  host.send({ t: 'begin' });
  check('the host starts the match', await waitFor(() => lastRoster()?.started === true, 1500));
  check(
    'a begin message reaches the guests',
    await waitFor(() => g2.messages.some((m) => m.t === 'begin'), 1500)
  );
  check(
    'begin carries the final rules',
    (g2.messages.filter((m) => m.t === 'begin').pop() as { config?: { mode?: string } })?.config?.mode === 'team'
  );
}

// --- 8. Version gate still rejects a mismatched build in a multi-player room.
const stale = await open(wsUrl);
stale.send({ t: 'join', role: 'guest', version: '0.0.1-old' });
check('an old build is refused with a version reason', await waitFor(() => stale.messages.some((m) => m.t === 'reject' && m.reason === 'version'), 2000));
stale.close();

for (const client of guests) client.close();
host.close();
g2.close();
await new Promise((r) => setTimeout(r, 120));
await server.close();

let failed = 0;
for (const c of checks) {
  console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail && !c.ok ? ` — ${c.detail}` : ''}`);
  if (!c.ok) failed += 1;
}
console.log(failed ? `\n${failed}/${checks.length} multi-player checks FAILED` : `\n${checks.length}/${checks.length} multi-player checks passed`);
if (failed) process.exit(1);
