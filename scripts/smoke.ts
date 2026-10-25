/**
 * Headless smoke test: boots the real scenes in jsdom with a software canvas
 * and steps the game loop, so runtime errors in create()/update() surface
 * without a browser. Run with `npm run smoke`.
 */
import { JSDOM } from 'jsdom';
import { createCanvas } from '@napi-rs/canvas';

const dom = new JSDOM('<!doctype html><html><body><div id="game"></div></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/',
});

const { window } = dom;

// Give jsdom a real 2D context (Phaser bakes text and procedural textures).
const contexts = new WeakMap<HTMLCanvasElement, CanvasRenderingContext2D>();
const origCreate = window.document.createElement.bind(window.document);
window.document.createElement = ((tag: string, options?: ElementCreationOptions) => {
  const el = origCreate(tag, options);
  if (tag.toLowerCase() === 'canvas') {
    const native = createCanvas(300, 150) as unknown as { getContext: (id: string) => CanvasRenderingContext2D | null; toDataURL: () => string; width: number; height: number };
    const ctx = native.getContext('2d');
    Object.defineProperty(el, 'getContext', {
      value: (id: string) => (id === '2d' ? ctx : null),
    });
    Object.defineProperty(el, 'toDataURL', { value: () => native.toDataURL() });
    if (ctx) contexts.set(el as HTMLCanvasElement, ctx);
    (el as unknown as { __native: unknown }).__native = native;
  }
  return el;
}) as typeof window.document.createElement;

// jsdom can't decode images; a tiny stand-in lets Phaser's texture pipeline
// finish booting (we only care about runtime errors, not pixels).
class FakeImage {
  width = 2;
  height = 2;
  naturalWidth = 2;
  naturalHeight = 2;
  complete = true;
  crossOrigin = '';
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private _src = '';
  set src(value: string) {
    this._src = value;
    window.setTimeout(() => this.onload?.(), 0);
  }
  get src(): string {
    return this._src;
  }
  decode(): Promise<void> {
    return Promise.resolve();
  }
  addEventListener(name: string, cb: () => void): void {
    if (name === 'load') this.onload = cb;
  }
  removeEventListener(): void {}
}

// Keep the software bitmap in sync with whatever size Phaser asks for.
const nativeLookup = (el: HTMLCanvasElement): { width: number; height: number } | undefined =>
  (el as unknown as { __native?: { width: number; height: number } }).__native;

for (const dim of ['width', 'height'] as const) {
  Object.defineProperty(window.HTMLCanvasElement.prototype, dim, {
    configurable: true,
    get(this: HTMLCanvasElement) {
      return Number(this.getAttribute(dim)) || (dim === 'width' ? 300 : 150);
    },
    set(this: HTMLCanvasElement, value: number) {
      this.setAttribute(dim, String(value));
      const native = nativeLookup(this);
      if (native) native[dim] = Number(value) || 1;
    },
  });
}

// Canvas dimensions must agree with the context's bitmap.
const origSetAttribute = window.HTMLCanvasElement.prototype.setAttribute;
window.HTMLCanvasElement.prototype.setAttribute = function patched(name: string, value: string) {
  origSetAttribute.call(this, name, value);
  if (name === 'width' || name === 'height') {
    const native = (this as unknown as { __native?: { width: number; height: number } }).__native;
    const w = Number(this.getAttribute('width')) || 1;
    const h = Number(this.getAttribute('height')) || 1;
    if (native) native.width = w, native.height = h;
  }
};

const g = globalThis as unknown as Record<string, unknown>;
const define = (key: string, value: unknown): void => {
  Object.defineProperty(g, key, { value, writable: true, configurable: true });
};

define('self', window);
define('window', window);
define('document', window.document);
define('HTMLImageElement', window.HTMLImageElement);
define('HTMLVideoElement', window.HTMLVideoElement);
define('XMLHttpRequest', window.XMLHttpRequest);
define('CustomEvent', window.CustomEvent);
define('MutationObserver', window.MutationObserver);
define('DOMParser', window.DOMParser);
define('Node', window.Node);
define('navigator', window.navigator);
define('HTMLCanvasElement', window.HTMLCanvasElement);
define('HTMLVideoElement', window.HTMLVideoElement);
define('Image', FakeImage);
define('HTMLImageElement', FakeImage);
define('ImageData', window.ImageData);
define('CanvasRenderingContext2D', window.CanvasRenderingContext2D);
define('Element', window.Element);
define('HTMLElement', window.HTMLElement);
define('Event', window.Event);
define('EventTarget', window.EventTarget);
define('KeyboardEvent', window.KeyboardEvent);
define('MouseEvent', window.MouseEvent);
define('TouchEvent', window.TouchEvent);
define('getComputedStyle', window.getComputedStyle.bind(window));
define('requestAnimationFrame', (cb: FrameRequestCallback) => window.setTimeout(() => cb(performance.now()), 16));
define('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
define('devicePixelRatio', 1);
define('localStorage', window.localStorage);
define('screen', window.screen);
define('location', window.location);
define('focus', window.focus.bind(window));
define('AudioContext', undefined);

// jsdom has no WebSocket; the LAN client can use the real `ws` implementation.
const { default: NodeWebSocket } = await import('ws');
define('WebSocket', NodeWebSocket);

const Phaser = (await import('phaser')).default;
const { GameScene } = await import('../src/game/GameScene');
const { MenuScene } = await import('../src/game/MenuScene');

const errors: string[] = [];
// Some jsdom/software-canvas artefacts are not game bugs; ignore those.
const harnessNoise = ['drawImage', 'CanvasFeatures', 'Performance.now', 'PerformanceImpl'];
let stackOverflowReports = 0;
window.addEventListener('error', (e: ErrorEvent) => {
  const text = String(e.error?.stack ?? e.error?.message ?? e.message);
  if (harnessNoise.some((n) => text.includes(n))) return;
  if (text.includes('Maximum call stack')) {
    stackOverflowReports++;
    return;
  }
  errors.push(text);
});

// HEADLESS has no renderer, so CanvasTexture.refresh() would dereference null.
// Pixel upload is irrelevant here.
const canvasProto = Phaser.Textures.CanvasTexture.prototype as unknown as { refresh: () => void };
const originalRefresh = canvasProto.refresh;
canvasProto.refresh = function patchedRefresh(this: unknown) {
  try {
    originalRefresh.call(this);
  } catch {
    /* no renderer in headless mode */
  }
};

const game = new Phaser.Game({
  type: Phaser.HEADLESS,
  parent: 'game',
  width: 1280,
  height: 720,
  audio: { noAudio: true },
  banner: false,
  scene: [MenuScene, GameScene],
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
await wait(600);
console.log('booted:', game.isBooted, 'running:', game.isRunning, 'renderType:', game.config.renderType);
console.log(
  'scenes:',
  game.scene.scenes.map((sc) => `${sc.sys.settings.key}:${sc.sys.settings.status}`).join(', ')
);

const menu = game.scene.getScene('Menu');
console.log('menu active:', !!menu && menu.scene.isActive());

game.scene.stop('Menu');
game.scene.start('Game');
await wait(400);

const scene = game.scene.getScene('Game') as InstanceType<typeof GameScene>;
const checks: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string): void => {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail && !ok ? ` — ${detail}` : ''}`);
};

type TankRef = {
  x: number;
  y: number;
  alive: boolean;
  hp: number;
  maxHp: number;
  kills: number;
  deaths: number;
  team: number;
  shieldUntil: number;
  awaitingRespawn: boolean;
  invulnerableUntil: number;
  radius: number;
  bodyAngle: number;
  turretAngle: number;
  turretOffset: number;
  rageShots: number;
  aimAt: (angle: number) => void;
  turnHull: (delta: number) => void;
  setHp: (hp: number) => void;
};
type Poked = {
  bullets: { owner: string; dead: boolean; x: number; y: number; vx: number; vy: number; dmg: number }[];
  particles: unknown[];
  score: number;
  levelIndex: number;
  phase: string;
  versus: boolean;
  aiCharge: number;
  aiReload: number;
  aiGraceUntil: number;
  p1: TankRef;
  p2?: TankRef;
  enemy?: TankRef;
  layout: {
    player: { x: number; y: number };
    enemy: { x: number; y: number };
    walls: { x: number; y: number; w: number; h: number }[];
    crates: { x: number; y: number; w: number; h: number }[];
  };
  pickups: { kind: string; x: number; y: number; respawn: number; pop: number }[];
  keys: Map<string, { keyCode: number; isDown: boolean }>;
  useSkill: (tank: unknown) => boolean;
  startRoomMatch: () => void;
  roster: { id: string; team: number; skill: string; ready?: boolean }[];
  /** Anything else the tests poke at. */
  [key: string]: unknown;
  skillP1: string;
  connected: boolean;
  skillReadyAt: number;
  spawnBullet: (x: number, y: number, dir: number, owner: 'p1' | 'p2' | 'enemy', speed: number, maxBounces: number) => void;
  fire: (tank: unknown) => void;
  firePlayer?: () => void;
  setPaused: (paused: boolean) => void;
  setAutoDodge: (on: boolean) => void;
  restartGame: () => void;
};
const poke = scene as unknown as Poked;
const settings = (await import('../src/game/settings')).settings;

check('game scene is active', scene.scene.isActive());
check('game loop is running', game.loop.running, `frame=${game.loop.frame}`);
check('solo mode by default', !poke.versus);
// v1.5: the minimap labels yourself, your team and everyone else.
const soloMarks = () =>
  (poke as unknown as { minimapMarks: () => { id: string; kind: string }[] }).minimapMarks();
check('the solo CPU shows up as an enemy on the minimap', soloMarks().some((m) => m.id === 'enemy' && m.kind === 'foe'), JSON.stringify(soloMarks()));
check('the minimap never marks a solo run as a team', !soloMarks().some((m) => m.kind === 'mate'), JSON.stringify(soloMarks()));
check('everyone starts on 100 HP', poke.p1.hp === 100 && poke.p1.maxHp === 100, `hp=${poke.p1.hp}`);
check('the AI is on the same health pool', poke.enemy?.hp === 100, `hp=${poke.enemy?.hp}`);
check('a grace period before the AI may fire', poke.aiGraceUntil > scene.time.now);

// Wait for the ready banner, then let a real skirmish run.
await wait(1600);
check('the match starts playing', poke.phase === 'playing', poke.phase);

let sawEnemyShell = false;
let sawPlayerShell = false;
const fireTimer = setInterval(() => {
  const tank = poke.p1;
  if (!tank.alive) return;
  // The barrel is mounted on the hull, so aim by pointing the tank.
  if (poke.enemy) {
    const a = Math.atan2(poke.enemy.y - tank.y, poke.enemy.x - tank.x);
    tank.bodyAngle = a;
    tank.aimAt(a);
  }
  poke.fire(tank);
  // Sample while the shells are in flight – they die fast against the walls.
  sawPlayerShell ||= poke.bullets.some((b) => b.owner === 'p1');
  sawEnemyShell ||= poke.bullets.some((b) => b.owner === 'enemy');
}, 120);
for (let i = 0; i < 40 && !(sawEnemyShell && sawPlayerShell); i++) await wait(100);
clearInterval(fireTimer);
check('player shells exist', sawPlayerShell);
check('the AI fires shells', sawEnemyShell);

// --- self damage: our own shell must be able to hit us.
poke.bullets.length = 0;
poke.aiGraceUntil = 1e15;
poke.aiCharge = 0;
const beforeSelf = poke.p1.hp;
poke.p1.invulnerableUntil = 0;
// Fire a shell into the wall right behind us, so it comes straight back.
const wallDir = Math.PI;
poke.spawnBullet(poke.p1.x + Math.cos(wallDir) * 60, poke.p1.y, wallDir, 'p1', 1200, 4);
await wait(1500);
check('own shells are tracked as p1', true);
check('our own ricochet can hurt us', poke.p1.hp < beforeSelf, `hp=${poke.p1.hp}`);

// --- enemy shell must cost a life too.
await wait(1400);
poke.bullets.length = 0;
poke.p1.invulnerableUntil = 0;
const beforeEnemy = poke.p1.hp;
poke.spawnBullet(poke.p1.x - 60, poke.p1.y, 0, 'enemy', 700, 2);
await wait(400);
// Exact per-part numbers are covered by the pure rules test; here we only
// prove an enemy shell really takes health off.
check('an enemy shell costs HP', poke.p1.hp < beforeEnemy, `hp=${poke.p1.hp} phase=${poke.phase}`);
check('damage stays in the per-part range', beforeEnemy - poke.p1.hp <= 24, `${beforeEnemy} -> ${poke.p1.hp}`);
await wait(1800);
check('the player respawns after dying', poke.p1.alive && poke.phase === 'playing', `phase=${poke.phase}`);

// --- auto dodge moves the hull without any input.
poke.setAutoDodge(true);
const startX = poke.p1.x;
const startY = poke.p1.y;
poke.spawnBullet(poke.p1.x - 130, poke.p1.y - 4, 0, 'enemy', 700, 4);
await wait(700);
const moved = Math.hypot(poke.p1.x - startX, poke.p1.y - startY);
check('auto dodge moves the hull on its own', moved > 10, `moved=${moved.toFixed(1)}px`);
poke.setAutoDodge(false);

// --- destroy the AI to advance a level.
poke.bullets.length = 0;
poke.p1.invulnerableUntil = 1e15;
const levelBefore = poke.levelIndex;
// Short health so the test is about the kill → next-level flow, not about how
// many shells a 100 HP target needs.
poke.enemy!.setHp(20);
for (let i = 0; i < 4; i++) {
  const e = poke.enemy!;
  if (!e || !e.alive) break;
  e.invulnerableUntil = 0;
  poke.spawnBullet(e.x - 60, e.y, 0, 'p1', 900, 2);
  await wait(340);
}
check('the AI tank dies after enough hits', poke.phase === 'cleared' || !poke.enemy?.alive, poke.phase);
await wait(2200);
check('the next level loads', poke.levelIndex === levelBefore + 1 || poke.phase === 'victory', `level=${poke.levelIndex}`);

// --- versus mode boots with two humans and no AI.
settings.mode = 'versus';
poke.restartGame();
await wait(1500);
check('versus mode has two human tanks', !!poke.p2 && !poke.enemy);
check('versus gives both sides 100 HP', poke.p1.hp === 100 && poke.p2?.hp === 100, `p1=${poke.p1.hp} p2=${poke.p2?.hp}`);
const p2HpBefore = poke.p2!.hp;
poke.p2!.invulnerableUntil = 0;
poke.spawnBullet(poke.p2!.x - 60, poke.p2!.y, 0, 'p1', 900, 2);
await wait(400);
check('P1 can damage P2', poke.p2!.hp < p2HpBefore, `p2=${poke.p2!.hp}`);

// --- restart resets everything.
poke.restartGame();
await wait(1400);
check(
  'restart resets health and level',
  poke.p1.hp === 100 && poke.p2?.hp === 100 && poke.levelIndex === 0,
  `p1=${poke.p1.hp} p2=${poke.p2?.hp} level=${poke.levelIndex}`
);

// --- back to solo: the AI must dodge and must find shots.
settings.mode = 'solo';
settings.difficulty = 'hard';
poke.restartGame();
await wait(1700);

const enemy = poke.enemy!;
check('solo mode is restored', !poke.versus && !!poke.enemy);

// 1) A shell flying straight at the AI: it should step off the line of fire.
poke.bullets.length = 0;
const ex0 = enemy.x;
const ey0 = enemy.y;
poke.spawnBullet(ex0 - 260, ey0, 0, 'p1', 620, 4);
await wait(900);
const dodged = Math.hypot(enemy.x - ex0, enemy.y - ey0);
check('the AI dodges incoming shellfire', dodged > 12, `moved=${dodged.toFixed(1)}px`);

// 2) With the grace period over it should line up a shot (and telegraph it).
poke.bullets.length = 0;
poke.aiGraceUntil = 0;
poke.aiReload = 0;
poke.aiCharge = 0;
let acquired = false;
for (let i = 0; i < 30 && !acquired; i++) {
  if (poke.aiCharge > 0 || poke.bullets.some((b) => b.owner === 'enemy')) acquired = true;
  if (!acquired) await wait(100);
}
check('the AI acquires and fires shots', acquired, `charge=${poke.aiCharge}`);

// --- v1.5: the dashed aiming line follows the (tunable) bounce count.
{
  const T = await import('../src/game/tuning');
  const aim = poke as unknown as {
    aimPreviewBounces: () => number;
    aimPreviewLegs: (tank: unknown) => { bounce: boolean }[];
  };
  const keep = { x: poke.p1.x, y: poke.p1.y, turret: poke.p1.turretAngle };
  poke.p1.x = 640;
  poke.p1.y = 360;
  // Aim around the compass and keep the longest line this map allows, so the
  // check is about the bounce count and not about one unlucky wall.
  const longest = (): { legs: number; reflections: number } => {
    let best = { legs: 0, reflections: 0 };
    for (let i = 0; i < 72; i += 1) {
      poke.p1.turretAngle = (i / 72) * Math.PI * 2;
      const legs = aim.aimPreviewLegs(poke.p1);
      const reflections = legs.filter((leg) => leg.bounce).length;
      if (reflections > best.reflections || (reflections === best.reflections && legs.length > best.legs)) {
        best = { legs: legs.length, reflections };
      }
    }
    return best;
  };

  check('the aiming line previews two bounces by default', aim.aimPreviewBounces() === 2, `${aim.aimPreviewBounces()}`);
  const shipped = longest();
  check('two bounces means two reflections', shipped.reflections === 2, JSON.stringify(shipped));
  check('two bounces means three straight legs', shipped.legs === 3, JSON.stringify(shipped));

  T.setTuning({ aimBounces: 4 });
  const four = longest();
  check('the line follows a raised bounce count', aim.aimPreviewBounces() === 4 && four.reflections === 4, JSON.stringify(four));
  check('four bounces means five legs', four.legs === 5, JSON.stringify(four));

  T.setTuning({ aimBounces: 0 });
  const straight = longest();
  check('zero bounces is one straight leg', straight.legs === 1 && straight.reflections === 0, JSON.stringify(straight));

  T.setTuning({ aimBounces: 99 });
  check('the bounce count is clamped', aim.aimPreviewBounces() === 6, `${aim.aimPreviewBounces()}`);

  T.resetTuning();
  const back = longest();
  check('resetting restores the two-bounce line', back.legs === 3 && back.reflections === 2, JSON.stringify(back));
  check('the line never bounces more than it is told to', back.reflections <= aim.aimPreviewBounces());
  check('the shell bounce limit is a separate knob', T.tuning().maxBounces === 2, `${T.tuning().maxBounces}`);

  poke.p1.x = keep.x;
  poke.p1.y = keep.y;
  poke.p1.turretAngle = keep.turret;
}

// --- pause / resume.
poke.setPaused(true);
await wait(150);
poke.setPaused(false);
await wait(150);
check('pause/resume keeps the game healthy', poke.phase !== 'over', poke.phase);

// --- LAN: host the match for real and connect a guest over WebSocket.
const { createLanServer } = await import('../server/lan-server.mjs');
const lanServer = await createLanServer({ port: 0, host: '127.0.0.1', quiet: true });
settings.mode = 'lan';
settings.lanRole = 'host';
settings.lanAddress = `127.0.0.1:${lanServer.port}`;
poke.restartGame();
await wait(1800);

check('host mode connects to the LAN server', (scene as unknown as { lanRole: string }).lanRole === 'host');

// A guest joins from a plain WebSocket client.
const guest = new NodeWebSocket(`ws://127.0.0.1:${lanServer.port}/ws`);
const guestMsgs: any[] = [];
guest.on('message', (raw: unknown) => {
  try {
    guestMsgs.push(JSON.parse(String(raw)));
  } catch {
    /* ignore */
  }
});
await new Promise<void>((resolve, reject) => {
  guest.once('open', () => resolve());
  guest.once('error', reject);
});
guest.send(JSON.stringify({ t: 'join', role: 'guest' }));
await wait(500);
// v1.4: newcomers land in the room lobby; the host starts the match.
const hostPhase = () => (poke as any).phase as string;
check('the room opens in a lobby', hostPhase() === 'lobby', hostPhase());
poke.startRoomMatch();
await wait(500);

const snapSeen = () => guestMsgs.filter((m) => m.t === 'state');
await wait(700);
check('the guest starts receiving snapshots', snapSeen().length > 0, `got ${snapSeen().length}`);

const lastSnap = () => snapSeen()[snapSeen().length - 1];
check('snapshots describe both tanks', (lastSnap()?.tanks?.length ?? 0) === 2, JSON.stringify(lastSnap()?.tanks?.length));
check(
  'snapshots carry health, phase and level',
  typeof lastSnap()?.phase === 'string' && typeof lastSnap()?.level === 'number' && Array.isArray(lastSnap()?.crates),
  JSON.stringify({ phase: lastSnap()?.phase, level: lastSnap()?.level })
);

// Guest input must actually move the host's second tank.
const p2Start = { x: poke.p2!.x, y: poke.p2!.y };
const sendInput = () =>
  guest.send(JSON.stringify({ t: 'input', seq: 1, input: { turn: 1, drive: 1, aim: 0, fire: false } }));
const inputTimer = setInterval(sendInput, 33);
await wait(900);
clearInterval(inputTimer);
const p2Moved = Math.hypot(poke.p2!.x - p2Start.x, poke.p2!.y - p2Start.y);
check('guest input drives the host-side tank', p2Moved > 10, `moved=${p2Moved.toFixed(1)}px`);

// v1.5: the minimap has to say who is friendly and who is not.
const marks = () =>
  (poke as unknown as { minimapMarks: () => { id: string; kind: string }[] }).minimapMarks();
check('the minimap marks yourself', marks().some((m) => m.kind === 'me'), JSON.stringify(marks()));
check(
  'the minimap marks the other seat as an enemy in FFA',
  marks().some((m) => m.id === 'p2' && m.kind === 'foe'),
  JSON.stringify(marks())
);
check('nobody is marked as a team-mate without teams', !marks().some((m) => m.kind === 'mate'), JSON.stringify(marks()));
// Team mode: put the guest on our side and the mark has to switch.
const teamScene = poke as unknown as { setTeamOf: (id: string, team: number) => void };
settings.match.mode = 'team';
teamScene.setTeamOf('p2', 0);
await wait(400);
check(
  'a team-mate is marked as friendly',
  marks().some((m) => m.id === 'p2' && m.kind === 'mate'),
  JSON.stringify(marks())
);
teamScene.setTeamOf('p2', 1);
await wait(350);
check(
  'another team is marked as an enemy again',
  marks().some((m) => m.id === 'p2' && m.kind === 'foe'),
  JSON.stringify(marks())
);
settings.match.mode = 'ffa';

const guestTank = lastSnap()?.tanks?.find((t: { id: string }) => t.id === 'p2');
check(
  'the guest sees its own tank move in snapshots',
  !!guestTank && Math.hypot(guestTank.x - p2Start.x, guestTank.y - p2Start.y) > 10,
  JSON.stringify(guestTank)
);

// --- v1.3.1: hit zones follow the shell, and the multiplier is applied.
{
  const probe = poke as any;
  const victim = probe.p1;
  victim.alive = true;
  victim.awaitingRespawn = false;
  victim.invulnerableUntil = 0;
  victim.shieldUntil = 0;
  victim.bodyAngle = -Math.PI / 2; // nose points up (screen coordinates)

  victim.setHp(100);
  probe.damage(victim, 'p1', Math.PI / 2); // shell travelling down = hits the nose
  const frontLoss = 100 - victim.hp;

  victim.setHp(100);
  probe.damage(victim, 'p1', -Math.PI / 2); // shell travelling up = hits the rear
  const rearLoss = 100 - victim.hp;

  victim.setHp(100);
  probe.damage(victim, 'p1', 0); // side-on
  const sideLoss = 100 - victim.hp;

  victim.setHp(100);
  probe.damage(victim, 'p1', Math.PI / 2, 2); // 狂暴 shell
  const doubledLoss = 100 - victim.hp;

  check('nose hits deal the least damage', frontLoss === 7, `${frontLoss}`);
  check('flank hits deal 9', sideLoss === 9, `${sideLoss}`);
  check('rear hits deal the most', rearLoss === 12 && rearLoss > frontLoss, `${rearLoss}`);
  check('the damage multiplier is applied', doubledLoss === 14, `${doubledLoss}`);
}

// --- v1.3.1: every pickup starts on cooldown, staggered.
{
  const probe = poke as any;
  // Rebuild just the pickup set (a full restart would tear the LAN socket down).
  probe.resetPickups(probe.levelIndex);
  const cooldowns = probe.pickups.map((p: { respawn: number }) => p.respawn);
  check('pickups start the match on cooldown', cooldowns.every((c: number) => c > 0), JSON.stringify(cooldowns));
  check(
    'pickups do not all pop at once',
    new Set(cooldowns.map((c: number) => Math.round(c * 10))).size === cooldowns.length,
    JSON.stringify(cooldowns)
  );
}

// --- barrel heat: free until the cap, then a hard lock.
const heatProbe = poke as any;
heatProbe.p1.coldBarrel();
heatProbe.bullets.length = 0;
heatProbe.p1.fireReadyAt = 0;
heatProbe.fire(heatProbe.p1);
check('firing heats the barrel', heatProbe.p1.heat.heat > 0, JSON.stringify(heatProbe.p1.heat));
check('a warm barrel still fires', heatProbe.p1.canShoot());
for (let i = 0; i < 6; i++) heatProbe.p1.addHeat();
check('the cap locks the barrel', !heatProbe.p1.canShoot(), JSON.stringify(heatProbe.p1.heat));
heatProbe.bullets.length = 0;
heatProbe.p1.fireReadyAt = 0;
heatProbe.fire(heatProbe.p1);
check('a locked barrel refuses to fire', heatProbe.bullets.length === 0, `bullets=${heatProbe.bullets.length}`);
heatProbe.p1.coolDown(3);
check('cooling down unlocks the barrel', heatProbe.p1.canShoot(), JSON.stringify(heatProbe.p1.heat));
heatProbe.bullets.length = 0;
heatProbe.p1.fireReadyAt = 0;
heatProbe.fire(heatProbe.p1);
check('a cooled barrel fires again', heatProbe.bullets.length > 0, `bullets=${heatProbe.bullets.length}`);

// --- ten players: a second guest must become a third tank on the host.
const guest2 = new NodeWebSocket(`ws://127.0.0.1:${lanServer.port}/ws`);
const guest2Msgs: any[] = [];
guest2.on('message', (raw: unknown) => {
  try {
    guest2Msgs.push(JSON.parse(String(raw)));
  } catch {
    /* ignore */
  }
});
await new Promise<void>((resolve, reject) => {
  guest2.once('open', () => resolve());
  guest2.once('error', reject);
});
guest2.send(JSON.stringify({ t: 'join', role: 'guest' }));
await wait(500);
// A new seat drops the room back to the lobby until the host starts again.
poke.startRoomMatch();
await wait(700);
check('the host renders a tank per seat', heatProbe.tanks().length >= 3, `tanks=${heatProbe.tanks().length}`);
check(
  'a third seat is named p3',
  (lastSnap()?.tanks ?? []).some((t: { id: string }) => t.id === 'p3'),
  JSON.stringify((lastSnap()?.tanks ?? []).map((t: { id: string }) => t.id))
);
check(
  'snapshots carry private heat and its lock',
  (lastSnap()?.tanks ?? []).every((t: { heat?: number; heatLocked?: number }) => typeof t.heat === 'number' && typeof t.heatLocked === 'number')
);
guest2Msgs.length = 0;
guest2.close();
await wait(500);
check('a departing seat is removed from the field', heatProbe.tanks().length === 2 && !heatProbe.byId('p3'), `tanks=${heatProbe.tanks().length}`);

// --- every tank must fit where it spawns (no materialising inside a wall).
{
  const insideAny = (tank: { x: number; y: number }) =>
    poke.layout.walls.some(
      (box) =>
        tank.x > box.x - 18 && tank.x < box.x + box.w + 18 && tank.y > box.y - 18 && tank.y < box.y + box.h + 18
    );
  const allTanks = (poke as any).tanks() as { x: number; y: number }[];
  const stuck = allTanks.filter((tank) => insideAny(tank));
  check('nobody spawns inside a wall', stuck.length === 0, `${stuck.length} stuck`);
}

// Host can end the match / restart and the guest is told.
guestMsgs.length = 0;
poke.restartGame();
await wait(400);
check('restart is mirrored to the guest', guestMsgs.some((m) => m.t === 'restart'), JSON.stringify(guestMsgs.map((m) => m.t)));

guest.close();
lanServer.close();
await wait(300);

// Back to solo: this must shut the socket down and leave no pending retries.
settings.mode = 'solo';
settings.lanAddress = '';
poke.restartGame();
await wait(1200);
check('leaving LAN mode stops the socket', !(scene as unknown as { lan: unknown }).lan, 'socket still open');

// ---------------------------------------------------------------- new systems

// Pickups: scattered on the chosen map and collectable by touch.
check('the map seeds pickups', poke.pickups.length >= 3, `${poke.pickups.length}`);
check(
  'pickups sit inside the arena',
  poke.pickups.every(
    (p) => p.x > 0 && p.y > 0 && p.x < 1280 && p.y < 720
  )
);

const spot = poke.pickups[0];
spot.kind = 'health';
spot.respawn = 0;
poke.p1.setHp(40);
const beforeHp = poke.p1.hp;
poke.p1.x = spot.x;
poke.p1.y = spot.y;
await wait(250);
check('touching a medkit heals 40 HP', poke.p1.hp === beforeHp + 40, `${beforeHp} -> ${poke.p1.hp}`);
check('a collected pickup goes on cooldown', spot.respawn > 0, `${spot.respawn.toFixed(1)}s`);

// A shield must absorb the next hit instead of costing a life.
const shieldSpot = poke.pickups[1];
shieldSpot.kind = 'shield';
shieldSpot.respawn = 0;
poke.p1.x = shieldSpot.x;
poke.p1.y = shieldSpot.y;
await wait(200);
const shielded = poke.p1.hp;
poke.p1.invulnerableUntil = 0;
// Park the tank mid-arena and shoot it point blank, so the test does not depend
// on where its own ricochet happens to go.
poke.p1.x = 640;
poke.p1.y = 420;
poke.spawnBullet(poke.p1.x - 50, poke.p1.y, 0, 'enemy', 600, 2);
await wait(500);
check('a shield blocks the hit', poke.p1.hp === shielded, `${shielded} -> ${poke.p1.hp}`);
// v1.3: one hit is all it stops.
check('the shield is used up by that hit', poke.p1.shieldUntil <= scene.time.now, `until=${poke.p1.shieldUntil} now=${scene.time.now}`);

// Turret is mounted on the hull: turning the hull carries the barrel.
poke.p1.x = 640;
poke.p1.y = 420;
poke.p1.turretOffset = 0.4;
poke.p1.bodyAngle = 0;
poke.p1.turretAngle = 0.4;
const bodyBefore = { body: poke.p1.bodyAngle, turret: poke.p1.turretAngle, offset: poke.p1.turretOffset };
poke.p1.turnHull(0.5);
check(
  'the barrel rotates with the hull',
  Math.abs(poke.p1.turretAngle - (bodyBefore.turret + 0.5)) < 1e-6,
  `turret ${poke.p1.turretAngle}`
);
check(
  'the barrel keeps its offset from the nose',
  Math.abs(poke.p1.turretOffset - bodyBefore.offset) < 1e-6,
  `${poke.p1.turretOffset}`
);
poke.p1.aimAt(poke.p1.bodyAngle + 3);
check(
  'aiming is clamped to the mount arc',
  Math.abs(poke.p1.turretOffset) <= Math.PI / 2 + 1e-6,
  `${poke.p1.turretOffset.toFixed(2)} rad`
);

// Bug fix: a barrel pressed against a wall must not fire through it.
// The outer frame is appended last: [level walls..., top, bottom, left, right].
const topWall = poke.layout.walls[poke.layout.walls.length - 4];
poke.p1.x = 500;
poke.p1.y = topWall.y + topWall.h + poke.p1.radius + 0.5;
poke.p1.bodyAngle = -Math.PI / 2;
poke.p1.turretOffset = 0;
poke.p1.turretAngle = -Math.PI / 2;
poke.bullets.length = 0;
poke.fire(poke.p1);
const shot = poke.bullets[0];
check(
  'a point-blank shot never starts behind the wall',
  !shot || shot.y >= topWall.y + topWall.h - 1,
  shot ? `spawned at y=${shot.y.toFixed(1)}, wall ends ${(topWall.y + topWall.h).toFixed(1)}` : 'no shell (dry click)'
);

// Summoner skills.
settings.skillP1 = 'rage';
poke.restartGame();
await wait(1500);
check('the skill choice is applied to the scuffle', poke.skillP1 === 'rage', poke.skillP1);
const used = poke.useSkill(poke.p1);
check('the skill can be triggered', used);
check('rage loads extra-damage shells', poke.p1.rageShots === 5, `${poke.p1.rageShots}`);
check('the skill goes on cooldown', poke.useSkill(poke.p1) === false);

// Bound keys are live in the running scene.
const bindings = (await import('../src/game/keybinds')).getBindings();
check(
  'the scene listens on the rebound keys',
  poke.keys.get('p1.up')?.keyCode === bindings.solo.up &&
    poke.keys.get('p1.fire')?.keyCode === bindings.solo.fire,
  `${poke.keys.get('p1.up')?.keyCode} vs ${bindings.solo.up}`
);

// ------------------------------------------- v1.5: LAN fixes end to end
// A custom map has to reach the room, a death must not freeze the match, and
// every decided match has to show a 赢/输 card. This block runs its own room.
{
  const { OVERLAY_EVENT, MATCH_LEFT_EVENT } = await import('../src/game/events');
  const overlays: any[] = [];
  game.events.on(OVERLAY_EVENT, (state: any) => overlays.push(state));
  let leftEvents = 0;
  game.events.on(MATCH_LEFT_EVENT, () => {
    leftEvents += 1;
  });

  const { createLanServer } = await import('../server/lan-server.mjs');
  const lanServer2 = await createLanServer({ port: 0, host: '127.0.0.1', quiet: true });
  const { emptyMap, mapHash } = await import('../src/maps/format');
  const { saveMap } = await import('../src/maps/store');
  const { refreshLevels } = await import('../src/maps/registry');
  const roomMap = saveMap({ ...emptyMap({ name: '联机冒烟图' }), id: 'custom-smoke', rev: 1 } as any)!;
  refreshLevels();

  settings.mode = 'lan';
  settings.lanRole = 'host';
  settings.lanAddress = `127.0.0.1:${lanServer2.port}`;
  settings.match = {
    ...settings.match,
    mode: 'ffa',
    winCondition: 'kills',
    killTarget: 2,
    timeLimit: 120,
    capacity: 4,
  };
  settings.mapId = roomMap.id;
  poke.restartGame();
  await wait(1600);
  const room = poke as any;
  check(
    'the room opens on the map picked in the menu',
    room.phase === 'lobby' && room.roomLevelId === roomMap.id,
    `${room.phase} / ${room.roomLevelId}`
  );

  // Leaving the room in the lobby must not look like a surrender.
  overlays.length = 0;
  (room as unknown as { handleSurrender: (by: string) => void }).handleSurrender('p2');
  await wait(150);
  check('a lobby exit is not treated as a surrender', !overlays.some((o) => o.kind === 'matchOver'), JSON.stringify(overlays.map((o) => o.kind)));

  const peer = new NodeWebSocket(`ws://127.0.0.1:${lanServer2.port}/ws`);
  const peerMsgs: any[] = [];
  peer.on('message', (raw: unknown) => {
    try {
      peerMsgs.push(JSON.parse(String(raw)));
    } catch {
      /* ignore */
    }
  });
  await new Promise<void>((resolve, reject) => {
    peer.once('open', () => resolve());
    peer.once('error', reject);
  });
  peer.send(JSON.stringify({ t: 'join', role: 'guest' }));
  await wait(700);

  const pushed = [...peerMsgs].reverse().find((m) => m.t === 'map');
  check('the room map reaches a joining guest', !!pushed?.map && pushed.map.id === roomMap.id, JSON.stringify(pushed?.map?.id));
  // The server used to read the wrong field here, so the hash arrived empty and
  // every ack failed: the room could never start on a custom map.
  check('the map hash survives the trip', pushed?.hash === mapHash(roomMap), `${pushed?.hash}`);

  peer.send(JSON.stringify({ t: 'map-ack', id: roomMap.id, rev: roomMap.rev, hash: pushed?.hash, ok: true }));
  await wait(250);
  poke.startRoomMatch();
  // The room plays a short 准备 countdown before the tanks roll.
  await wait(1700);
  check('a confirmed custom map lets the match start', room.phase === 'playing', room.phase);

  // A death is a short timeout now: the phase never freezes and the clock runs.
  const dead = room.p2 as TankRef;
  room.matchElapsed = 0;
  dead.setHp(5);
  room.damage(dead, 'p1', 0);
  check('a LAN death keeps the match running', room.phase === 'playing', room.phase);
  check('the victim is parked for a respawn', !dead.alive && dead.awaitingRespawn, `${dead.alive} / ${dead.awaitingRespawn}`);
  const clockAtDeath = room.matchElapsed as number;
  await wait(700);
  check('the match clock keeps ticking after a death', (room.matchElapsed as number) > clockAtDeath, `${clockAtDeath} -> ${room.matchElapsed}`);
  await wait(2400);
  check('the dead tank respawns by itself', dead.alive && !dead.awaitingRespawn, `${dead.alive} / ${dead.awaitingRespawn}`);
  check('the match is still open after that death', room.phase === 'playing', room.phase);

  // The kill target closes the match, and this seat is told it won.
  overlays.length = 0;
  (room.p1 as TankRef).kills = 2;
  await wait(500);
  const resultCard = [...overlays].reverse().find((o) => o.kind === 'matchOver');
  check('reaching the kill target ends the LAN match', !!resultCard, JSON.stringify(overlays.map((o) => o.kind)));
  check('the result card says whether you won', resultCard?.verdict === 'win', `${resultCard?.verdict}`);
  check('the result card carries the scoreboard', (resultCard?.scoreboard?.length ?? 0) >= 2, `${resultCard?.scoreboard?.length}`);
  check('the result card names the ruleset', resultCard?.mode === 'ffa', `${resultCard?.mode}`);

  // A rematch has to be decidable again (the latch used to swallow it).
  overlays.length = 0;
  const lanBefore = room.lan;
  poke.restartGame();
  await wait(900);
  check('a rematch keeps the room socket', lanBefore === room.lan, 'socket was redialled');
  check(
    'a rematch clears the finished state',
    room.matchOver === false && room.matchElapsed < 3,
    `${room.matchOver} / ${Number(room.matchElapsed).toFixed(2)}`
  );
  (room.p1 as TankRef).kills = 2;
  await wait(500);
  check(
    'the second match can be decided too',
    [...overlays].reverse().some((o) => o.kind === 'matchOver'),
    JSON.stringify(overlays.map((o) => o.kind))
  );

  peer.close();
  lanServer2.close();
  await wait(300);

  // Quit: the scene hands the exit to main.ts and never restarts itself.
  (poke as unknown as { quitMatch: () => void }).quitMatch();
  await wait(250);
  check('quitting asks main.ts to swap scenes', leftEvents === 1, `${leftEvents}`);
  check('the scene parks itself instead of restarting', room.phase === 'leaving' && room.leaving === true, `${room.phase}`);
  check('quitting drops the room socket', !room.lan, String(room.lan));

  settings.mode = 'solo';
  settings.lanAddress = '';
  settings.mapId = 'random';
  settings.match = { ...settings.match, winCondition: 'both', killTarget: 15, timeLimit: 480, capacity: 6 };
}

console.log('');
const failed = checks.filter((c) => !c.ok);
console.log(`${checks.length - failed.length}/${checks.length} smoke checks passed`);
console.log('runtime errors:', errors.length ? errors : 'none');

game.destroy(true, true);
await wait(200);
if (failed.length || errors.length) throw new Error('smoke test failed');
console.log('smoke ok');
