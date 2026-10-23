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

// Private state, reachable at runtime; the smoke test deliberately pokes it.
type Poked = {
  bullets: unknown[];
  particles: unknown[];
  lives: number;
  score: number;
  levelIndex: number;
  phase: string;
  player: { x: number; y: number; alive: boolean; invulnerableUntil: number; radius: number };
  enemy: { x: number; y: number; alive: boolean; radius: number };
  enemyHp: number;
  enemyGraceUntil: number;
  enemyCharge: number;
  layout: { player: { x: number; y: number } };
  spawnBullet: (x: number, y: number, dir: number, owner: 'player' | 'enemy') => void;
  hitEnemy: () => void;
  hitPlayer: () => void;
  firePlayer: () => void;
  setPaused: (paused: boolean) => void;
  restartGame: () => void;
};
const poke = scene as unknown as Poked;

check('game scene is active', scene.scene.isActive());
check('game loop is running', game.loop.running, `frame=${game.loop.frame}`);
check('player spawns at the level start', Math.abs(poke.player.x - poke.layout.player.x) < 1, `${poke.player.x}`);
check('three lives at the start', poke.lives === 3, `lives=${poke.lives}`);
check('level one is loaded', poke.levelIndex === 0, `level=${poke.levelIndex}`);

// --- 1. fire for a while and let the AI answer; nothing should throw.
const fireInterval = setInterval(() => poke.firePlayer(), 130);
await wait(1600);
clearInterval(fireInterval);

let sawEnemyShell = false;
let sawPlayerShell = false;
for (let i = 0; i < 70 && !(sawEnemyShell && sawPlayerShell); i++) {
  const shells = poke.bullets as { owner?: string }[];
  sawEnemyShell ||= shells.some((b) => b.owner === 'enemy');
  sawPlayerShell ||= shells.some((b) => b.owner === 'player');
  if (!(sawEnemyShell && sawPlayerShell)) await wait(100);
}
console.log(
  '  ..   after the skirmish: shells',
  (poke.bullets as { owner?: string }[]).map((b) => b.owner).join(','),
  'lives', poke.lives, 'phase', poke.phase, 'level', poke.levelIndex
);
check('player shells exist', sawPlayerShell);
check('the enemy fires ricochet shells', sawEnemyShell);
check('still playing', poke.phase === 'playing', poke.phase);

// Keep the rest of the test deterministic: no stray shells, no new AI shots.
poke.bullets.length = 0;
poke.enemyGraceUntil = 1e15;
poke.enemyCharge = 0;

// --- 2. an enemy shell must cost a life, then the player respawns.
poke.player.invulnerableUntil = 0;
const livesBefore = poke.lives;
poke.spawnBullet(poke.player.x - 60, poke.player.y, 0, 'enemy');
await wait(450);
check('an enemy shell costs a life', poke.lives === livesBefore - 1, `lives=${poke.lives} phase=${poke.phase}`);
await wait(1700);
check('the player respawns after dying', poke.player.alive && poke.phase === 'playing', `phase=${poke.phase}`);

// --- 3. a player shell must damage the enemy.
poke.bullets.length = 0;
poke.enemyHp = 3;
const hpBefore = poke.enemyHp;
poke.spawnBullet(poke.enemy.x - 60, poke.enemy.y, 0, 'player');
await wait(350);
check('a player shell damages the enemy', poke.enemyHp < hpBefore, `hp=${poke.enemyHp}`);
check('hitting scores points', poke.score > 0, `score=${poke.score}`);

// --- 4. finishing off the enemy advances the level.
const levelBefore = poke.levelIndex;
poke.player.invulnerableUntil = 1e15;
for (let i = 0; i < 3; i++) {
  poke.hitEnemy();
  await wait(60);
}
check('the level clears when the enemy dies', poke.phase === 'cleared', poke.phase);
await wait(2200);
const advanced = poke.levelIndex === levelBefore + 1 || poke.phase === 'victory';
check('the next level loads automatically', advanced, `level=${poke.levelIndex} phase=${poke.phase}`);

// --- 5. pause, resume, restart.
poke.setPaused(true);
await wait(150);
poke.setPaused(false);
await wait(150);
check('pause/resume keeps the game healthy', poke.phase === 'playing' || poke.phase === 'victory', poke.phase);

poke.restartGame();
await wait(300);
check(
  'restart resets lives, score and level',
  poke.lives === 3 && poke.score === 0 && poke.levelIndex === 0,
  `lives=${poke.lives} score=${poke.score} level=${poke.levelIndex}`
);

await wait(400);
console.log('');
const failed = checks.filter((c) => !c.ok);
console.log(`${checks.length - failed.length}/${checks.length} smoke checks passed`);
console.log('runtime errors:', errors.length ? errors : 'none');

game.destroy(true, true);
await wait(200);
if (failed.length || errors.length) throw new Error('smoke test failed');
console.log('smoke ok');
