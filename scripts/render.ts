/**
 * Offline renderer: boots the game with Phaser's canvas renderer inside jsdom
 * (with a software 2D canvas) and writes PNG frames. Handy for eyeballing the
 * hand-drawn look without a browser.
 *
 *   npx tsx scripts/render.ts [outDir]
 */
import { writeFileSync } from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';
import { JSDOM } from 'jsdom';

const outDir = process.argv[2] ?? '/tmp/tank-shots';

const dom = new JSDOM('<!doctype html><html><body><div id="game"></div></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/',
});
const { window } = dom;

type NativeCanvas = {
  width: number;
  height: number;
  getContext: (id: string) => unknown;
  toBuffer: (mime: string) => Buffer;
};

/** jsdom canvas -> software canvas, so Phaser gets a real 2D context. */
const origCreateElement = window.document.createElement.bind(window.document);
window.document.createElement = ((tag: string, options?: ElementCreationOptions) => {
  const el = origCreateElement(tag, options);
  if (tag.toLowerCase() === 'canvas') {
    const native = createCanvas(300, 150) as unknown as NativeCanvas;
    const ctx = native.getContext('2d') as object;
    Object.defineProperty(el, 'getContext', { value: (id: string) => (id === '2d' ? ctx : null) });
    Object.defineProperty(el, 'toDataURL', { value: () => native.toBuffer('image/png').toString('base64') });
    (el as unknown as { __native: NativeCanvas }).__native = native;
  }
  return el;
}) as typeof window.document.createElement;

for (const dim of ['width', 'height'] as const) {
  Object.defineProperty(window.HTMLCanvasElement.prototype, dim, {
    configurable: true,
    get(this: HTMLCanvasElement) {
      return Number(this.getAttribute(dim)) || (dim === 'width' ? 300 : 150);
    },
    set(this: HTMLCanvasElement, value: number) {
      this.setAttribute(dim, String(value));
      const native = (this as unknown as { __native?: NativeCanvas }).__native;
      if (native) native[dim] = Number(value) || 1;
    },
  });
}

class FakeImage {
  width = 2;
  height = 2;
  /** So drawImage() has something real to draw. */
  __native = createCanvas(8, 8);
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

// jsdom does not expose a 2D context constructor, but Phaser's feature
// detection keys off it.
const probeCtx = createCanvas(1, 1).getContext('2d') as object;
const CtxCtor = Object.getPrototypeOf(probeCtx).constructor as unknown;
(window as unknown as { CanvasRenderingContext2D: unknown }).CanvasRenderingContext2D = CtxCtor;

const define = (key: string, value: unknown): void => {
  Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
};

define('self', window);
define('window', window);
define('document', window.document);
define('navigator', window.navigator);
define('HTMLCanvasElement', window.HTMLCanvasElement);
define('HTMLImageElement', FakeImage);
define('HTMLVideoElement', window.HTMLVideoElement);
define('Image', FakeImage);
define('ImageData', window.ImageData);
define('CanvasRenderingContext2D', CtxCtor);
define('Element', window.Element);
define('HTMLElement', window.HTMLElement);
define('Event', window.Event);
define('EventTarget', window.EventTarget);
define('KeyboardEvent', window.KeyboardEvent);
define('MouseEvent', window.MouseEvent);
define('TouchEvent', window.TouchEvent);
define('screen', window.screen);
define('location', window.location);
define('focus', window.focus.bind(window));
define('getComputedStyle', window.getComputedStyle.bind(window));
define('requestAnimationFrame', (cb: FrameRequestCallback) => window.setTimeout(() => cb(Date.now()), 16));
define('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
define('devicePixelRatio', 1);
define('localStorage', window.localStorage);
define('XMLHttpRequest', window.XMLHttpRequest);
define('CustomEvent', window.CustomEvent);
define('MutationObserver', window.MutationObserver);
define('DOMParser', window.DOMParser);
define('Node', window.Node);

// drawImage() must receive a software canvas, not a jsdom element.
const sampleCtx = createCanvas(1, 1).getContext('2d') as unknown as {
  drawImage: (...args: unknown[]) => void;
};
const ctxProto = Object.getPrototypeOf(sampleCtx) as { drawImage: (...args: unknown[]) => void };
const originalDrawImage = ctxProto.drawImage;
ctxProto.drawImage = function patched(this: unknown, image: unknown, ...rest: unknown[]) {
  const unwrapped = (image as { __native?: unknown } | null)?.__native ?? image;
  return originalDrawImage.call(this, unwrapped, ...rest);
};

const patternHost = ctxProto as unknown as { createPattern: (...args: unknown[]) => unknown };
const originalCreatePattern = patternHost.createPattern;
patternHost.createPattern = function patched(this: unknown, image: unknown, ...rest: unknown[]) {
  const unwrapped = (image as { __native?: unknown } | null)?.__native ?? image;
  return originalCreatePattern.call(this, unwrapped, ...rest);
};

const Phaser = (await import('phaser')).default;
const { GameScene } = await import('../src/game/GameScene');
const { MenuScene } = await import('../src/game/MenuScene');

const game = new Phaser.Game({
  type: Phaser.CANVAS,
  parent: 'game',
  width: 1280,
  height: 720,
  backgroundColor: '#f3ead9',
  audio: { noAudio: true },
  banner: false,
  scale: { mode: Phaser.Scale.NONE, width: 1280, height: 720 },
  scene: [MenuScene, GameScene],
});

const errors: string[] = [];
window.addEventListener('error', (e: ErrorEvent) => errors.push(String(e.error?.stack ?? e.message)));

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const shoot = async (name: string): Promise<void> => {
  const canvas = game.canvas as unknown as { __native?: NativeCanvas };
  if (!canvas.__native) {
    console.log('no native canvas');
    return;
  }
  const buffer = canvas.__native.toBuffer('image/png');
  writeFileSync(`${outDir}/${name}.png`, buffer);
  if (process.env.CROP) {
    const [cx, cy, cw, ch] = process.env.CROP.split(',').map(Number);
    const { loadImage } = await import('@napi-rs/canvas');
    const full = await loadImage(buffer);
    const out = createCanvas(cw * 2, ch * 2);
    const octx = out.getContext('2d');
    octx.imageSmoothingEnabled = false;
    octx.drawImage(full as unknown as never, cx, cy, cw, ch, 0, 0, cw * 2, ch * 2);
    const zoomed = out.toBuffer('image/png');
    writeFileSync(`${outDir}/${name}-zoom.png`, zoomed);
  }
  console.log('wrote', `${outDir}/${name}.png`, buffer.length, 'bytes');
};

await wait(1200);
await shoot('01-menu');
console.log('menu frame captured');

game.scene.stop('Menu');
game.scene.start('Game');
await wait(2400);

const scene = game.scene.getScene('Game') as InstanceType<typeof GameScene>;
const pointer = scene.input.activePointer;
const poked = scene as unknown as {
  firePlayer: () => void;
  player: { x: number; y: number; turretAngle: number };
  enemy: { x: number; y: number };
  bullets: unknown[];
};

// Point the reticle at the wall above the enemy so the guide shows a bank shot.
poked.player.turretAngle = -0.95;
pointer.worldX = 690;
pointer.worldY = 250;
pointer.x = 690;
pointer.y = 250;
await wait(500);
await shoot('02-aim-and-guide');

// A few shells in flight, ricocheting between the walls.
poked.player.turretAngle = -0.62;
for (let i = 0; i < 3; i++) {
  poked.firePlayer();
  await wait(80);
}
await wait(220);
await shoot('03-bullets-in-flight');

await wait(1100);
await shoot('04-combat');

// A compact JPEG for the README.
{
  const { loadImage } = await import('@napi-rs/canvas');
  const canvas = game.canvas as unknown as { __native?: NativeCanvas };
  const src = await loadImage(canvas.__native!.toBuffer('image/png'));
  const jpg = createCanvas(1280, 720);
  jpg.getContext('2d').drawImage(src as unknown as never, 0, 0, 1280, 720);
  writeFileSync(`${outDir}/preview.jpg`, jpg.toBuffer('image/jpeg', 82));
  console.log('wrote', `${outDir}/preview.jpg`);
}

console.log('errors:', errors.length ? errors : 'none');
game.destroy(true, true);
await wait(150);
