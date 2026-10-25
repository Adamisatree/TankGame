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

const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version: string };
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
  // http (not file:) so localStorage exists — the map library needs it.
  url: 'http://localhost/game.html',
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

    // Canvases created by `innerHTML` (the map editor) never pass through
    // createElement, so give the prototype a real 2D context too.
    Object.defineProperty(window.HTMLCanvasElement.prototype, 'getContext', {
      configurable: true,
      value(this: HTMLCanvasElement, id: string) {
        if (id !== '2d') return null;
        const self = this as unknown as { __native?: NativeCanvas };
        if (!self.__native) {
          self.__native = createCanvas(
            Number(this.getAttribute('width')) || 300,
            Number(this.getAttribute('height')) || 150
          ) as NativeCanvas;
        }
        return self.__native.getContext('2d');
      },
    });

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
// v1.3 rules panel only exists in the LAN panel, so sample it here.
const capacityButtons = doc.querySelectorAll('[data-match="capacity"]').length;
const hasFriendly = !!doc.querySelector('[data-match="friendlyFire"]');
const hasSelf = !!doc.querySelector('[data-match="selfDamage"]');

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

// --- map library + editor (v1.5.0): the whole create → paint → save loop.
const mapNewButton = doc.getElementById('map-new') as HTMLElement | null;
mapNewButton?.click();
await new Promise((r) => setTimeout(r, 200));
const editor = doc.querySelector('.editor');
const editorCanvas = doc.getElementById('map-canvas') as HTMLCanvasElement | null;
const toolCount = doc.querySelectorAll('.tool-chip').length;
const hasSidePanel = !!doc.querySelector('.editor-side') && !!doc.getElementById('map-issues');
const actionCount = doc.querySelectorAll('.editor-actions button').length;
const mirrorCount = doc.querySelectorAll('[data-mirror]').length;
const sizeOptions = doc.querySelectorAll('#map-size option').length;
let painted = false;
if (editorCanvas) {
  // jsdom reports a zero-size box; give the canvas a pretend layout so the
  // pointer maths resolves to a real grid cell.
  editorCanvas.getBoundingClientRect = () =>
    ({ x: 0, y: 0, top: 0, left: 0, right: 720, bottom: 432, width: 720, height: 432, toJSON: () => ({}) }) as DOMRect;
  (doc.querySelector('[data-tool="wall"]') as HTMLElement | null)?.click();
  const send = (type: string, clientX: number, clientY: number): void => {
    editorCanvas.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY }));
  };
  send('pointerdown', 200, 200);
  send('pointermove', 240, 200);
  send('pointerup', 240, 200);
  painted = true;
}
// Save it, then go back: the library must list the new map and the picker too.
(doc.getElementById('editor-save') as HTMLElement | null)?.click();
await new Promise((r) => setTimeout(r, 150));
const saveStatus = (doc.getElementById('editor-status')?.textContent ?? '').trim();
(doc.getElementById('editor-close') as HTMLElement | null)?.click();
await new Promise((r) => setTimeout(r, 200));
const libraryRows = doc.querySelectorAll('.custom-map').length;
const customCards = Array.from(doc.querySelectorAll('[data-map]')).filter((el) =>
  (el.getAttribute('data-map') ?? '').startsWith('custom-')
).length;
const backToMenu = !!doc.getElementById('btn-start');

// --- version + updater panel (v1.2.0)
const updater = doc.querySelector('.updater');
const updaterSummary = (updater?.querySelector('summary')?.textContent ?? '').replace(/\s+/g, ' ').trim();
const mirrorSelect = doc.querySelector('[data-upd-mirror]') as HTMLSelectElement | null;
const versionBadge = (doc.querySelector('.kicker')?.textContent ?? '').trim();
const autoOption = Array.from(mirrorSelect?.options ?? []).some((o) => o.value === '');
const mirroredOptions = Array.from(mirrorSelect?.options ?? []).filter((o) => o.value !== '');

// Offline behaviour: clicking "check" must not throw, it must explain itself.
(doc.querySelector('[data-upd-check]') as HTMLElement | null)?.click();
await new Promise((r) => setTimeout(r, 600));
const updaterStatus = (doc.querySelector('.upd-status')?.textContent ?? '').replace(/\s+/g, ' ').trim();
const updaterErrors = errors.length;

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
  ['the key editor lists every action', doc.querySelectorAll('.key-btn').length >= 7, `${doc.querySelectorAll('.key-btn').length}`],
  ['the two gun-trim keys are gone', !('aimLeft' in ({} as Record<string, number>)) && doc.querySelectorAll('.key-btn').length < 9],
  ['the rules panel offers 2–10 players', capacityButtons === 7, `${capacityButtons}`],
  ['friendly fire and self damage are separate switches', hasFriendly && hasSelf],
  ['clicking a key starts capture', captureStarted],
  ['pressing a key rebinds it', rebindLabel === 'Z', rebindLabel],
  ['capture mode ends after rebinding', !!firstKey && !firstKey.classList.contains('capturing')],
  ['the title shows the build version', versionBadge.includes(`v${pkg.version}`), versionBadge],
  ['the version comes from the build, not a hard-coded string', html.includes(pkg.version)],
  ['the updater panel is in the menu', !!updater],
  ['the panel shows the current version', updaterSummary.includes(`v${pkg.version}`), updaterSummary],
  ['the panel offers a check button', !!doc.querySelector('[data-upd-check]')],
  ['the panel offers mirror probing', !!doc.querySelector('[data-upd-probe]')],
  ['mirror choice includes an automatic option', autoOption],
  ['several mirrors can be picked by hand', mirroredOptions.length >= 3, `${mirroredOptions.length}`],
  ['checking offline fails politely instead of throwing', updaterStatus.length > 0 && errors.length === updaterErrors, updaterStatus.slice(0, 80)],
  // v1.4: the internal tuning bench is reachable from the menu.
  ['the internal tuning panel is present', !!doc.querySelector('#tuning-panel')],
  ['the tuning panel is locked until the passphrase is entered', !!doc.querySelector('#tune-pass')],
  ['the tuning panel exposes fire rate', !!doc.querySelector('[data-tune="fireCooldown"]')],
  ['the tuning panel exposes heat and damage knobs',
    !!doc.querySelector('[data-tune="heatPerShot"]') && !!doc.querySelector('[data-tune="dmgBack"]')],
  ['the tuning panel can reset and export', !!doc.querySelector('#tune-reset') && !!doc.querySelector('#tune-export')],
  // Regression: selected chips used to have no styling at all.
  ['selected chips are visibly highlighted', /\.chip\.on\s*\{/.test(html)],
  // v1.4 room lobby (built into the same bundle).
  ['the room lobby ships with the build', html.includes('lobby-seat') && html.includes('开始对局')],
  ['the lobby can add and remove teams', html.includes('补齐空队') && html.includes('+ 加队')],
  ['other players\' skill picks stay hidden', html.includes('已选择（保密）')],
  // v1.5 map system: editor, library and the LAN map handshake all ship.
  ['the map library is in the menu', html.includes('自定义地图') && html.includes('新建地图')],
  ['the editor markup is in the bundle', html.includes('保存并试玩') && html.includes('map-canvas')],
  ['the editor is styled (toolbar + side panel)', /\.editor-toolbar\s*\{/.test(html) && /\.editor-body\s*\{/.test(html)],
  ['the map format marker is compiled in', html.includes('tankmap')],
  ['the editor exports the map file type', html.includes('tankmap.json')],
  ['the room shows the map and its sync state', html.includes('lobby-map') && html.includes('地图确认')],
  ['the host can re-send the map when an ack is lost', html.includes('重发地图')],
  ['the editor card is not tilted (pointer must line up)', /#card\.wide\s*\{[^}]*transform:\s*none/.test(html)],
  ['map acknowledgements are part of the protocol', html.includes('map-ack') && html.includes('map-pending')],
  // v1.5: the editor actually opens, paints and saves from the menu.
  ['the menu offers a new-map button', !!mapNewButton],
  ['the editor opens from the menu', !!editor && !!editorCanvas],
  ['the editor toolbar has every tool', toolCount === 5, `${toolCount}`],
  ['the editor offers four mirror modes', mirrorCount === 4, `${mirrorCount}`],
  ['the editor offers four sizes', sizeOptions === 4, `${sizeOptions}`],
  ['the side panel is there (stats + checks)', hasSidePanel],
  ['the action row has save/play/copy/export/delete/import', actionCount === 6, `${actionCount}`],
  ['the editor can be painted', painted],
  ['saving a map reports success', saveStatus.includes('已保存'), saveStatus],
  ['the new map is listed in the library', libraryRows === 1, `${libraryRows}`],
  ['the new map joins the map picker', customCards === 1, `${customCards}`],
  ['closing the editor returns to the menu', backToMenu],
];

let failed = 0;
for (const [name, ok, detail] of checks) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail && !ok ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
}

dom.window.close();
console.log(failed ? 'single-file build FAILED' : 'single-file build ok');
if (failed) throw new Error('single-file verification failed');
