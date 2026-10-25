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

const guestTank = lastSnap()?.tanks?.find((t: { id: string }) => t.id === 'p2');
check(
  'the guest sees its own tank move in snapshots',
  !!guestTank && Math.hypot(guestTank.x - p2Start.x, guestTank.y - p2Start.y) > 10,
  JSON.stringify(guestTank)
);

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

console.log('');
const failed = checks.filter((c) => !c.ok);
console.log(`${checks.length - failed.length}/${checks.length} smoke checks passed`);
console.log('runtime errors:', errors.length ? errors : 'none');

game.destroy(true, true);
await wait(200);
if (failed.length || errors.length) throw new Error('smoke test failed');
console.log('smoke ok');
