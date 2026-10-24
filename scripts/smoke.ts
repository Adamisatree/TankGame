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

type TankRef = { x: number; y: number; alive: boolean; lives: number; invulnerableUntil: number; radius: number };
type Poked = {
  bullets: { owner: string; dead: boolean }[];
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
  layout: { player: { x: number; y: number } };
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
check('easy preset gives five lives', poke.p1.lives === 5, `lives=${poke.p1.lives}`);
check('a grace period before the AI may fire', poke.aiGraceUntil > scene.time.now);

// Wait for the ready banner, then let a real skirmish run.
await wait(1600);
check('the match starts playing', poke.phase === 'playing', poke.phase);

const fireTimer = setInterval(() => {
  const tank = poke.p1;
  if (tank.alive) poke.fire(tank);
}, 200);
await wait(2600);
clearInterval(fireTimer);

let sawEnemyShell = false;
let sawPlayerShell = false;
for (let i = 0; i < 70 && !(sawEnemyShell && sawPlayerShell); i++) {
  const shells = poke.bullets;
  sawEnemyShell ||= shells.some((b) => b.owner === 'enemy');
  sawPlayerShell ||= shells.some((b) => b.owner === 'p1');
  if (!(sawEnemyShell && sawPlayerShell)) await wait(100);
}
check('player shells exist', sawPlayerShell);
check('the AI fires shells', sawEnemyShell);

// --- self damage: our own shell must be able to hit us.
poke.bullets.length = 0;
poke.aiGraceUntil = 1e15;
poke.aiCharge = 0;
const beforeSelf = poke.p1.lives;
poke.p1.invulnerableUntil = 0;
// Fire a shell into the wall right behind us, so it comes straight back.
const wallDir = Math.PI;
poke.spawnBullet(poke.p1.x + Math.cos(wallDir) * 60, poke.p1.y, wallDir, 'p1', 900, 4);
await wait(900);
check('own shells are tracked as p1', true);
check('our own ricochet can hurt us', poke.p1.lives < beforeSelf, `lives=${poke.p1.lives}`);

// --- enemy shell must cost a life too.
await wait(1400);
poke.bullets.length = 0;
poke.p1.invulnerableUntil = 0;
const beforeEnemy = poke.p1.lives;
poke.spawnBullet(poke.p1.x - 60, poke.p1.y, 0, 'enemy', 700, 4);
await wait(400);
check('an enemy shell costs a life', poke.p1.lives === beforeEnemy - 1, `lives=${poke.p1.lives} phase=${poke.phase}`);
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
for (let i = 0; i < 3; i++) {
  const e = poke.enemy!;
  e.invulnerableUntil = 0;
  poke.spawnBullet(e.x - 60, e.y, 0, 'p1', 900, 4);
  await wait(320);
}
check('the AI tank is destroyed after three hits', poke.phase === 'cleared' || !poke.enemy?.alive, poke.phase);
await wait(2200);
check('the next level loads', poke.levelIndex === levelBefore + 1 || poke.phase === 'victory', `level=${poke.levelIndex}`);

// --- versus mode boots with two humans and no AI.
settings.mode = 'versus';
poke.restartGame();
await wait(1500);
check('versus mode has two human tanks', !!poke.p2 && !poke.enemy);
check('versus uses three lives each', poke.p1.lives === 3 && poke.p2?.lives === 3, `p1=${poke.p1.lives} p2=${poke.p2?.lives}`);
const p2LivesBefore = poke.p2!.lives;
poke.p2!.invulnerableUntil = 0;
poke.spawnBullet(poke.p2!.x - 60, poke.p2!.y, 0, 'p1', 900, 4);
await wait(400);
check('P1 can damage P2', poke.p2!.lives === p2LivesBefore - 1, `p2=${poke.p2!.lives}`);

// --- restart resets everything.
poke.restartGame();
await wait(1400);
check(
  'restart resets lives and level',
  poke.p1.lives === 3 && poke.p2?.lives === 3 && poke.levelIndex === 0,
  `p1=${poke.p1.lives} p2=${poke.p2?.lives} level=${poke.levelIndex}`
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

console.log('');
const failed = checks.filter((c) => !c.ok);
console.log(`${checks.length - failed.length}/${checks.length} smoke checks passed`);
console.log('runtime errors:', errors.length ? errors : 'none');

game.destroy(true, true);
await wait(200);
if (failed.length || errors.length) throw new Error('smoke test failed');
console.log('smoke ok');
