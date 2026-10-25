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

// The menu must actually expose the new systems (pure DOM wiring in main.ts).
const lanButton = doc.querySelector('[data-mode="lan"]') as HTMLElement | null;
lanButton?.click();
await new Promise((r) => setTimeout(r, 150));
const hostRoom = doc.getElementById('lan-room');
const roleButtons = doc.querySelectorAll('[data-lanrole]');

const guestButton = doc.querySelector('[data-lanrole="guest"]') as HTMLElement | null;
guestButton?.click();
await new Promise((r) => setTimeout(r, 150));
const lanAddress = doc.getElementById('lan-address') as HTMLInputElement | null;
const guestHint = (doc.querySelector('.lan-panel .lan-hint')?.textContent ?? '').trim();

// The IP field must swallow full-width IME punctuation, otherwise "。" breaks it.
if (lanAddress) {
  lanAddress.value = '１９２。１６８。１。１０';
  lanAddress.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
}
await new Promise((r) => setTimeout(r, 60));

(doc.querySelector('[data-mode="solo"]') as HTMLElement | null)?.click();
await new Promise((r) => setTimeout(r, 120));

// Rebinding: click a key button, press a key, the label must change.
const firstKey = doc.querySelector('.key-btn') as HTMLButtonElement | null;
let rebindLabel = '';
let captureStarted = false;
if (firstKey) {
  firstKey.click();
  captureStarted = firstKey.classList.contains('capturing');
  dom.window.dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', keyCode: 90, bubbles: true })
  );
  await new Promise((r) => setTimeout(r, 80));
  rebindLabel = (firstKey.textContent ?? '').trim();
}

const checks: [string, boolean, string?][] = [
  ['a canvas was created', !!canvas],
  ['the title card rendered', cardText.includes('坦克大作战'), cardText.slice(0, 60)],
  ['the start button exists', !!doc.getElementById('btn-start')],
  ['no page errors', errors.length === 0, errors.slice(0, 2).join(' | ')],
  ['the LAN mode button exists', !!lanButton],
  ['the host role shows the room address block', !!hostRoom],
  ['both host and guest roles are offered', roleButtons.length === 2, `${roleButtons.length} buttons`],
  ['the guest role offers an address field', !!lanAddress],
  ['the guest field normalises full-width input', lanAddress?.value === '192.168.1.10', lanAddress?.value ?? 'gone'],
  ['the guest panel explains how to find the host', guestHint.includes('IP'), guestHint.slice(0, 50)],
  ['every map is offered in the picker', doc.querySelectorAll('[data-map]').length >= 9, `${doc.querySelectorAll('[data-map]').length}`],
  ['the picker includes a random option', !!doc.querySelector('[data-map="random"]')],
  ['map previews draw from level data', doc.querySelectorAll('.map-svg').length >= 8],
  ['all four summoner skills are offered', doc.querySelectorAll('[data-skill]').length === 4],
  ['the key editor lists every action', doc.querySelectorAll('.key-btn').length >= 9, `${doc.querySelectorAll('.key-btn').length}`],
  ['clicking a key starts capture', captureStarted],
  ['pressing a key rebinds it', rebindLabel === 'Z', rebindLabel],
  ['capture mode ends after rebinding', !!firstKey && !firstKey.classList.contains('capturing')],
];

let failed = 0;
for (const [name, ok, detail] of checks) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail && !ok ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
}

dom.window.close();
console.log(failed ? 'single-file build FAILED' : 'single-file build ok');
if (failed) throw new Error('single-file verification failed');
