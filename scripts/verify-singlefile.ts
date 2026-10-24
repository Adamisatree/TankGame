/**
 * Boots release/坦克大作战.html in jsdom (with a software canvas) to prove the
 * single-file build really runs: Phaser must create a canvas and no page error
 * may fire.
 *
 *   npm run verify:single
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { JSDOM, VirtualConsole } from 'jsdom';

const file = resolve('release/坦克大作战.html');
const html = readFileSync(file, 'utf8');
console.log(`file: ${file} (${(Buffer.byteLength(html) / 1024 / 1024).toFixed(2)} MB)`);

const errors: string[] = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (err) => {
  const text = String(err?.stack ?? err);
  if (/drawImage|createPattern|Not implemented/.test(text)) return;
  errors.push(text);
});
virtualConsole.on('error', (msg) => { console.log('[console.error]', String(msg).slice(0, 200)); errors.push(String(msg)); });
virtualConsole.on('warn', (msg) => console.log('[console.warn]', String(msg).slice(0, 120)));

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'file:///game.html',
  virtualConsole,
  beforeParse(window) {
    type NativeCanvas = { width: number; height: number; getContext: (id: string) => unknown };
    // Give every <canvas> a real 2D context.
    const origCreate = window.document.createElement.bind(window.document);
    (window.document as unknown as { createElement: typeof origCreate }).createElement = ((tag: string, opts?: ElementCreationOptions) => {
      const el = origCreate(tag, opts);
      if (tag.toLowerCase() === 'canvas') {
        const native = createCanvas(300, 150) as unknown as NativeCanvas;
        const ctx = native.getContext('2d') as object;
        Object.defineProperty(el, 'getContext', { value: (id: string) => (id === '2d' ? ctx : null) });
        (el as unknown as { __native: NativeCanvas }).__native = native;
      }
      return el;
    }) as typeof origCreate;

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

    const ctxProto = Object.getPrototypeOf(createCanvas(1, 1).getContext('2d')) as {
      drawImage: (...a: unknown[]) => unknown;
      createPattern: (...a: unknown[]) => unknown;
    };
    for (const fn of ['drawImage', 'createPattern'] as const) {
      const original = ctxProto[fn];
      ctxProto[fn] = function patched(this: unknown, image: unknown, ...rest: unknown[]) {
        const unwrapped = (image as { __native?: unknown } | null)?.__native ?? image;
        return original.call(this, unwrapped, ...rest);
      };
    }

    class FakeImage {
      width = 2;
      height = 2;
      naturalWidth = 2;
      naturalHeight = 2;
      complete = true;
      crossOrigin = '';
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      src = 'data:,';
      decode(): Promise<void> {
        return Promise.resolve();
      }
      addEventListener(): void {}
      removeEventListener(): void {}
    }
    (window as unknown as { Image: unknown }).Image = FakeImage;
    (window as unknown as { CanvasRenderingContext2D: unknown }).CanvasRenderingContext2D =
      Object.getPrototypeOf(createCanvas(1, 1).getContext('2d'))!.constructor;
    (window as unknown as { AudioContext: unknown }).AudioContext = undefined;
  },
});

await new Promise((r) => setTimeout(r, 2500));

const doc = dom.window.document;
const canvas = doc.querySelector('#game canvas') ?? doc.querySelector('canvas');
const card = doc.getElementById('card');
const cardText = (card?.textContent ?? '').replace(/\s+/g, ' ').trim();
console.log('card html length:', card?.innerHTML.length ?? -1);
console.log('card text:', JSON.stringify(cardText.slice(0, 120)));
console.log('overlay classes:', doc.getElementById('overlay')?.className);
console.log('body length:', doc.body.textContent?.length ?? -1);

const checks: [string, boolean, string?][] = [
  ['a canvas was created', !!canvas],
  ['the title card rendered', cardText.includes('坦克大作战'), cardText.slice(0, 60)],
  ['the start button exists', !!doc.getElementById('btn-start')],
  ['no page errors', errors.length === 0, errors.slice(0, 2).join(' | ')],
];

let failed = 0;
for (const [name, ok, detail] of checks) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail && !ok ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
}

dom.window.close();
console.log(failed ? 'single-file build FAILED' : 'single-file build ok');
if (failed) throw new Error('single-file verification failed');
