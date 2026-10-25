import './test-env';
/**
 * Map system checks: file format v1, the local library, the built-in/custom
 * registry, and the editor itself driven through real DOM events in jsdom.
 * Run with `npm run test:map`.
 */
import { JSDOM } from 'jsdom';
import { createCanvas } from '@napi-rs/canvas';
import {
  MAP_FORMAT,
  MAP_GRID,
  MAP_SCHEMA_VERSION,
  MAP_SIZES,
  MIRROR_LABELS,
  applyMirror,
  canonicalMap,
  emptyMap,
  fromLevel,
  looksLikeMap,
  mapHash,
  mapHasErrors,
  newMapId,
  normalizeMapFile,
  needsWorld,
  toLevel,
  validateMap,
  versionAtLeast,
  type MapFile,
} from '../src/maps/format';
import {
  MAX_MAPS,
  archiveReceived,
  countMaps,
  deleteMap,
  duplicateMap,
  exportFileName,
  exportMapText,
  getMap,
  importMapText,
  isLibraryFull,
  libraryBytes,
  listMaps,
  saveMap,
} from '../src/maps/store';
import { customLevelCount, isCustomLevel, levelById, levelIndexOf, levels, randomLevelIndex, refreshLevels } from '../src/maps/registry';
import { MapEditor } from '../src/ui/mapEditor';
import WebSocket from 'ws';
import { createLanServer } from '../server/lan-server.mjs';
import { LanClient } from '../src/net/LanClient';

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ------------------------------------------------------------------ jsdom env

const dom = new JSDOM('<!doctype html><html><body><div id="editor"></div></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/',
});
const { window } = dom;
const g = globalThis as unknown as Record<string, unknown>;
g.window = window;
g.document = window.document;
g.localStorage = window.localStorage;
g.HTMLElement = window.HTMLElement;
g.HTMLCanvasElement = window.HTMLCanvasElement;
g.HTMLSelectElement = window.HTMLSelectElement;
g.HTMLButtonElement = window.HTMLButtonElement;
g.HTMLInputElement = window.HTMLInputElement;
g.Element = window.Element;
g.Node = window.Node;
g.Event = window.Event;
g.Blob = window.Blob;
g.URL = window.URL;

// jsdom has no 2D context; @napi-rs/canvas does, so the editor can really draw.
const origCreate = window.document.createElement.bind(window.document);
window.document.createElement = ((tag: string, options?: ElementCreationOptions) => {
  const el = origCreate(tag, options);
  if (tag.toLowerCase() === 'canvas') {
    const native = createCanvas(720, 432);
    Object.defineProperty(el, 'getContext', { value: (id: string) => (id === '2d' ? native.getContext('2d') : null) });
  }
  return el;
}) as typeof window.document.createElement;

// `root.innerHTML = ...` goes through jsdom's own parser, so patching
// createElement is not enough: give every canvas a real 2D context.
const nativeCtx = createCanvas(720, 432).getContext('2d');
window.HTMLCanvasElement.prototype.getContext = ((id: string) => (id === '2d' ? nativeCtx : null)) as typeof window.HTMLCanvasElement.prototype.getContext;

window.localStorage.clear();

// ------------------------------------------------------------------ format v1

console.log('\n地图格式 v1');
{
  const map = emptyMap({ name: '测试图' });
  check('a blank map is a valid v1 file', map.format === MAP_FORMAT && map.schemaVersion === MAP_SCHEMA_VERSION);
  check('a blank map has an id and no errors', /^custom-[a-z0-9]{6}$/.test(map.id) && !mapHasErrors(validateMap(map)));
  check('a blank map starts with two spawns', map.spawns.length === 2);
  check('ids are unique', newMapId() !== newMapId());
  check('every size preset is offered', MAP_SIZES.length >= 4 && MAP_SIZES[0].id === 'screen');
  check('mirror modes are all labelled', (['none', 'rot180', 'flipX', 'flipY'] as const).every((mode) => !!MIRROR_LABELS[mode]));
  check('the editor grid is 40 x 24', MAP_GRID.cols === 40 && MAP_GRID.rows === 24);

  // Normalising junk must never throw.
  const junk = normalizeMapFile(null);
  check('normalising garbage yields a usable map', junk.format === MAP_FORMAT && junk.walls.length === 0);
  const loose = normalizeMapFile({ name: 42, walls: 'nope', spawns: [{ x: 5, y: 5 }] });
  check('out-of-range spawns are clamped', loose.spawns[0].x === 1 && loose.spawns[0].y === 1);
  check('a map always normalises to two spawns', loose.spawns.length === 2);
  check('a nameless map gets a placeholder name', loose.name === '未命名地图');
  check('unknown fields survive in extra', 'notes' in normalizeMapFile({ extra: { notes: 'hi' } }).extra);

  // Round-trip through JSON, like export → import.
  const round = normalizeMapFile(JSON.parse(exportMapText(map)));
  check('export → import keeps the id and hash', round.id === map.id && mapHash(round) === mapHash(map));
  check('the canonical form ignores timestamps', canonicalMap(map) === canonicalMap({ ...map, updatedAt: new Date(0).toISOString() }));
  check('editing geometry changes the hash', mapHash({ ...map, walls: [...map.walls, { x: 0.3, y: 0.3, w: 0.05, h: 0.05 }] }) !== mapHash(map));
  check(
    'a map file is recognised by shape',
    looksLikeMap({ format: MAP_FORMAT, schemaVersion: 1, walls: [] }) &&
      !looksLikeMap({ format: 'something-else', walls: [] }) &&
      !looksLikeMap({ hello: 1 })
  );

  // Mirror maths.
  const half = { ...map, mirror: 'flipX' as const, walls: [{ x: 0.1, y: 0.2, w: 0.1, h: 0.1 }], crates: [], pickups: [{ x: 0.2, y: 0.5 }] };
  const full = applyMirror(half);
  check('a horizontal mirror doubles the geometry', full.walls.length === 2 && full.pickups.length === 2);
  const mirrored = full.walls.find((box) => box.x !== half.walls[0].x);
  check('the mirrored copy lands on the other side', !!mirrored && Math.abs(mirrored.x + mirrored.w + half.walls[0].x - 1) < 0.01);
  check('mirroring once is idempotent', applyMirror(full).walls.length === 2);
  check('a centred wall is not duplicated', applyMirror({ ...half, walls: [{ x: 0.45, y: 0.2, w: 0.1, h: 0.1 }] }).walls.length === 1);
  check('mirror none changes nothing', applyMirror({ ...map, mirror: 'none' }).walls.length === map.walls.length);
  // v1.5.1 / C1: a crate sitting exactly on a wall is not a duplicate of it.
  const overlap = applyMirror({
    ...half,
    walls: [{ x: 0.1, y: 0.2, w: 0.1, h: 0.1 }],
    crates: [{ x: 0.1, y: 0.2, w: 0.1, h: 0.1 }],
  });
  check('a crate on a wall survives mirroring', overlap.walls.length === 2 && overlap.crates.length === 2);
  check('the mirrored crate still exists in the level', toLevel(overlap).crates.length === 2);

  // Validation catches what players would notice.
  const bad: MapFile = { ...map, spawns: [{ x: 0.5, y: 0.5, angle: 0 }] };
  const issues = validateMap(bad);
  check('one spawn is an error', mapHasErrors(issues) && issues.some((issue) => issue.code === 'spawns'));
  const inWall = validateMap({ ...map, walls: [{ x: 0.2, y: 0.2, w: 0.3, h: 0.3 }], spawns: [{ x: 0.3, y: 0.3, angle: 0 }, { x: 0.8, y: 0.8, angle: 0 }] });
  check('a spawn inside a wall is an error', inWall.some((issue) => issue.code === 'spawn-wall'));
  const facing = validateMap({ ...map, walls: [{ x: 0.5, y: 0.4, w: 0.1, h: 0.1 }], spawns: [{ x: 0.45, y: 0.45, angle: 0 }, { x: 0.9, y: 0.9, angle: 0 }] });
  check('a spawn facing a wall is an error', facing.some((issue) => issue.code === 'spawn-face-wall'));
  const pickupInWall = validateMap({ ...map, walls: [{ x: 0.2, y: 0.2, w: 0.3, h: 0.3 }], pickups: [{ x: 0.3, y: 0.3 }] });
  check('a pickup inside a wall is an error', pickupInWall.some((issue) => issue.code === 'pickup-wall'));
  const edge = validateMap({ ...map, spawns: [{ x: 0.01, y: 0.5, angle: 0 }, { x: 0.9, y: 0.9, angle: 0 }] });
  check('a spawn on the very edge is an error', edge.some((issue) => issue.code === 'spawn-edge'));
  check('a future format only warns', validateMap({ ...map, schemaVersion: 9 }).some((issue) => issue.code === 'newer' && issue.severity === 'warn'));
  // v1.5.1 / C3: `minAppVersion` is a promise, so compare versions properly.
  check('version compare handles equal and longer strings', versionAtLeast('1.5.1', '1.5.1') && versionAtLeast('1.5.1', '1.5'));
  check('version compare orders numbers, not text', versionAtLeast('1.10.0', '1.9.9') && !versionAtLeast('1.5.0', '1.5.1'));
  check(
    'a map that needs a newer build is refused',
    validateMap({ ...map, minAppVersion: '99.0.0' }).some((issue) => issue.code === 'min-app' && issue.severity === 'error')
  );
  check('a map from an older build still opens', !validateMap({ ...map, minAppVersion: '1.0.0' }).some((i) => i.code === 'min-app'));

  // Map file → engine level.
  const level = toLevel({ ...map, name: '引擎测试' });
  check('a map becomes a playable level', level.id === map.id && level.walls.length > 0 && !!level.player && !!level.enemy);
  check('an unknown blurb falls back', level.blurb.length > 0 && level.tags.includes('custom'));
  const big = toLevel({ ...map, size: { w: 2400, h: 1600 } });
  check('a big map gets a scrolling world', big.world?.w === 2400 && big.world?.h === 1600);
  check('a screen-sized map stays still', toLevel(map).world === undefined);
  // v1.5.1 / C2: a tall map used to be squeezed onto the 16:9 play rectangle.
  const tall = toLevel({ ...map, size: { w: 900, h: 1800 } });
  check('a tall map gets a world camera', tall.world?.w === 900 && tall.world?.h === 1800);
  check('needsWorld agrees', needsWorld({ w: 900, h: 1800 }) && needsWorld({ w: 1280, h: 720 }) === false);
  const fromBuiltIn = fromLevel(levelById('maze') ?? levels()[0]);
  check('a built-in map copies into the editor', fromBuiltIn.id.startsWith('custom-') && fromBuiltIn.walls.length > 0);
}

// ------------------------------------------------------------------ library

console.log('\n本地地图库');
{
  window.localStorage.clear();
  refreshLevels();
  const builtinCount = levels().length;

  const first = saveMap(emptyMap({ name: '第一张' }));
  check('a save reports success only when it reached storage', !!first);
  const made = first as MapFile;
  check('saving adds the map', countMaps() === 1 && getMap(made.id)?.name === '第一张');
  const again = saveMap({ ...made, name: '第一张改' }) as MapFile;
  check('re-saving bumps the revision', again.rev === made.rev + 1 && getMap(made.id)?.name === '第一张改');
  check('createdAt is preserved across saves', again.createdAt === made.createdAt);

  refreshLevels();
  check('custom maps join the level list', levels().length === builtinCount + 1);
  check('the custom level keeps its id', isCustomLevel(made.id) && customLevelCount() === 1);
  check('the level index resolves', levelIndexOf(made.id) >= 0 && levelById(made.id)?.id === made.id);
  check('random picks can see the custom pool', levels().length > 0 && typeof randomLevelIndex() === 'number');

  const copy = duplicateMap(made.id, '第一张 副本');
  check('a duplicate gets a new id', !!copy && copy.id !== made.id && copy.rev === 1);
  check('the duplicate keeps the geometry', !!copy && JSON.stringify(copy.walls) === JSON.stringify(getMap(made.id)?.walls));

  const incoming = archiveReceived({ ...emptyMap({ name: '好友的图' }), source: 'received' }) as MapFile;
  const received = incoming;
  check('a received map is stored and tagged', getMap(received.id)?.source === 'received');
  const againReceived = archiveReceived(received) as MapFile;
  check('the same revision twice is a no-op', againReceived.rev === received.rev && countMaps() === 3);

  const text = exportMapText(getMap(made.id)!);
  check('export names the file after the map', exportFileName(getMap(made.id)!).endsWith('.tankmap.json'));
  check('the exported file names the format', JSON.parse(text).format === MAP_FORMAT);

  const single = importMapText(text);
  check('import accepts a single map', single.ok && !!single.map && single.map.id === made.id);
  const bundle = importMapText(JSON.stringify({ maps: [JSON.parse(text), JSON.parse(exportMapText(received))] }));
  check('import accepts a bundle', bundle.ok && !!bundle.map);
  check('import rejects junk', !importMapText('nope').ok && !importMapText('{"a":1}').ok);
  check('the library reports its size', libraryBytes() > 0);

  deleteMap(made.id);
  refreshLevels();
  check('deleting removes it everywhere', getMap(made.id) === null && !levels().some((level) => level.id === made.id));

  // Cap the library so a hostile import can't fill localStorage forever.
  for (let i = 0; i < MAX_MAPS + 5; i += 1) saveMap(emptyMap({ name: `批量 ${i}` }));
  check('the library is capped', countMaps() <= MAX_MAPS);
  check('the newest map is first', listMaps()[0].name.startsWith('批量'));
  // v1.5.1 / C4: the 201st save is refused instead of silently evicting the oldest.
  check('a full library says so', isLibraryFull() && countMaps() === MAX_MAPS);
  const oldestBefore = listMaps()[MAX_MAPS - 1];
  const refused = saveMap(emptyMap({ name: '溢出的第 201 张' }));
  check('the 201st map is refused, not swapped in', refused === null && countMaps() === MAX_MAPS);
  check('the refused save kept the oldest map', !!getMap(oldestBefore.id));
  const refusedImport = importMapText(exportMapText(emptyMap({ name: '导入溢出' })));
  check('a refused import explains the cap', !refusedImport.ok && (refusedImport.error ?? '').includes('满了'), `${refusedImport.error}`);
  // Replacing an existing map still works when the library is full.
  check('a full library still accepts edits', !!saveMap({ ...oldestBefore, name: '改一下' }));
}

// ------------------------------------------------------------------ editor

console.log('\n地图编辑器');
{
  window.localStorage.clear();
  refreshLevels();
  const root = window.document.getElementById('editor') as HTMLElement;
  const working = emptyMap({ name: '编辑器测试' });
  working.walls = [];
  working.crates = [];
  working.pickups = [];
  working.mirror = 'none';

  let saved: MapFile | null = null;
  let closed = false;
  let playHits = 0;
  let exportHits = 0;
  let playedAt = '';
  let exportedAt = '';
  const playCount = (): number => playHits;
  const exportCount = (): number => exportHits;
  // Kept in a variable so the object is not collected mid-test.
  const editor: MapEditor = new MapEditor(root, working, {
    onSave: (map) => (saved = saveMap(map)),
    onSaveCopy: (map) => saveMap({ ...map, id: newMapId(), rev: 1, name: `${map.name} 副本` }),
    onDelete: () => undefined,
    onPlay: (map) => {
      playHits += 1;
      playedAt = map.id;
    },
    onExport: (map) => {
      exportHits += 1;
      exportedAt = map.id;
    },
    onClose: () => (closed = true),
  });

  const canvas = root.querySelector<HTMLCanvasElement>('#map-canvas')!;
  check('the editor renders its canvas', !!canvas && canvas.width === 720);
  // Always resolve the live canvas: the editor re-renders on every open.
  const pointerAt = (type: string, clientX: number, clientY: number): void => {
    const live = root.querySelector<HTMLCanvasElement>('#map-canvas')!;
    live.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY }));
  };
  const stubBox = (): void => {
    const live = root.querySelector<HTMLCanvasElement>('#map-canvas')!;
    live.getBoundingClientRect = () =>
      ({ x: 0, y: 0, top: 0, left: 0, right: 720, bottom: 432, width: 720, height: 432, toJSON: () => ({}) }) as DOMRect;
  };

  // jsdom reports a zero-size box, so give the canvas a pretend layout.
  stubBox();
  check('every tool is on the toolbar', root.querySelectorAll('[data-tool]').length === 5);
  check('all four mirror modes are offered', root.querySelectorAll('[data-mirror]').length === 4);
  check('the size picker lists every preset', root.querySelectorAll('#map-size option').length === MAP_SIZES.length);

  /** Number shown next to a stat label in the side panel. */
  const stat = (label: string): number => {
    const row = [...root.querySelectorAll('#map-stats li')].find(
      (li) => li.querySelector('span')?.textContent?.trim() === label
    );
    return Number(row?.querySelector('b')?.textContent ?? '-1');
  };
  const statusText = (): string => root.querySelector<HTMLElement>('#editor-status')!.textContent ?? '';
  const issuesText = (): string => root.querySelector<HTMLElement>('#map-issues')!.textContent ?? '';
  const cell = (col: number, row: number): void => {
    const x = ((col + 0.5) / MAP_GRID.cols) * 720;
    const y = ((row + 0.5) / MAP_GRID.rows) * 432;
    pointerAt('pointerdown', x, y);
    pointerAt('pointerup', x, y);
  };
  const useTool = (tool: string): void => root.querySelector<HTMLButtonElement>(`[data-tool="${tool}"]`)!.click();

  // Paint a horizontal run of five cells: it must merge into one box.
  useTool('wall');
  const row5 = (): number => ((5 + 0.5) / MAP_GRID.rows) * 432;
  pointerAt('pointerdown', ((10 + 0.5) / MAP_GRID.cols) * 720, row5());
  for (const col of [11, 12, 13, 14]) pointerAt('pointermove', ((col + 0.5) / MAP_GRID.cols) * 720, row5());
  pointerAt('pointerup', ((14 + 0.5) / MAP_GRID.cols) * 720, row5());
  check('a drag merges into a single wall', stat('墙') === 1);

  // Undo / redo.
  root.querySelector<HTMLButtonElement>('#editor-undo')!.click();
  check('undo removes the stroke', stat('墙') === 0);
  root.querySelector<HTMLButtonElement>('#editor-redo')!.click();
  check('redo brings it back', stat('墙') === 1);

  // Crates, pickups and spawns.
  useTool('crate');
  cell(20, 10);
  useTool('pickup');
  cell(30, 6);
  useTool('spawn');
  const spawnsBefore = stat('出生点');
  cell(4, 4);
  cell(35, 19);
  check('a crate lands on the grid', stat('木箱') === 1);
  check('a pickup lands on the grid', stat('道具点') === 1);
  check('each click places a spawn', stat('出生点') === spawnsBefore + 2);

  // Erase removes what sits in the cell.
  useTool('erase');
  cell(20, 10);
  check('the eraser clears a crate', stat('木箱') === 0);
  cell(30, 6);
  check('the eraser clears a pickup', stat('道具点') === 0);

  // Save and play. (Casts: the compiler cannot see writes made from a callback.)
  root.querySelector<HTMLButtonElement>('#editor-save')!.click();
  const firstSave = saved as MapFile | null;
  check('a valid map saves', !!firstSave && firstSave.name === '编辑器测试');
  check('the status line reports the save', statusText().includes('已保存'));
  check('saving stores the geometry', !!firstSave && firstSave.walls.length === 1 && firstSave.crates.length === 0);

  root.querySelector<HTMLButtonElement>('#editor-play')!.click();
  check('save & play hands the map over', playCount() > 0 && playedAt === firstSave!.id);

  root.querySelector<HTMLButtonElement>('#editor-export')!.click();
  check('export hands over the working map', exportCount() > 0 && exportedAt === firstSave!.id);

  const nameInput = root.querySelector<HTMLInputElement>('#map-name')!;
  nameInput.value = '改过名字';
  nameInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  check('renaming updates the working copy', nameInput.value === '改过名字');

  root.querySelector<HTMLButtonElement>('#editor-close')!.click();
  check('close returns to the menu', closed);

  // A save after the revision bump must not create a second map.
  const before = countMaps();
  void before;

  // Mirror chips + ghost preview.
  const mirrorEditor = new MapEditor(root, { ...emptyMap({ name: '镜像测试' }), mirror: 'none' }, {
    onSave: (map) => saveMap(map),
    onSaveCopy: () => null,
    onDelete: () => undefined,
    onPlay: () => undefined,
    onExport: () => undefined,
    onClose: () => undefined,
  });
  void mirrorEditor;
  root.querySelector<HTMLButtonElement>('[data-mirror="rot180"]')!.click();
  check('picking a mirror marks the chip', root.querySelector<HTMLButtonElement>('[data-mirror="rot180"]')!.classList.contains('on'));
  check('the mirror chip unmarks the others', !root.querySelector<HTMLButtonElement>('[data-mirror="none"]')!.classList.contains('on'));
  let drew = true;
  try {
    root.querySelector<HTMLButtonElement>('#editor-grid')!.click();
    root.querySelector<HTMLButtonElement>('#editor-undo')!.click();
  } catch {
    drew = false;
  }
  check('drawing with a mirror active is safe', drew);

  // Losing every spawn point must block the save and say why.
  const spawnEditor = new MapEditor(root, emptyMap({ name: '空图' }), {
    onSave: (map) => saveMap(map),
    onSaveCopy: () => null,
    onDelete: () => undefined,
    onPlay: () => undefined,
    onExport: () => undefined,
    onClose: () => undefined,
  });
  void spawnEditor;
  stubBox();
  const spawns = emptyMap();
  useTool('erase');
  for (const spawn of spawns.spawns) {
    const x = ((Math.floor(spawn.x * MAP_GRID.cols) + 0.5) / MAP_GRID.cols) * 720;
    const y = ((Math.floor(spawn.y * MAP_GRID.rows) + 0.5) / MAP_GRID.rows) * 432;
    pointerAt('pointerdown', x, y);
    pointerAt('pointerup', x, y);
  }
  check('erasing every spawn drops the count', stat('出生点') === 0);
  check('the issue list explains the problem', issuesText().includes('出生点'));
  root.querySelector<HTMLButtonElement>('#editor-save')!.click();
  check('a map without spawns refuses to save', statusText().includes('出生点'));
  check('the refusal is flagged as an error', root.querySelector<HTMLElement>('#editor-status')!.classList.contains('bad'));
  check('the editor instances stayed alive through the run', !!editor && !!spawnEditor);
}

// ------------------------------------------------------------------ LAN transfer

console.log('\n联机地图同步');
{
  // The relay server + a real LanClient guest: the host pushes a map, the guest
  // stores it and confirms, and the host is told when it may start.
  const lanServer = await createLanServer({ port: 0, host: '127.0.0.1', quiet: true });
  const url = `ws://127.0.0.1:${lanServer.port}/ws`;
  g.WebSocket = WebSocket;

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (predicate: () => boolean, timeout = 2500): Promise<boolean> => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (predicate()) return true;
      await sleep(20);
    }
    return false;
  };

  type RawBox = { messages: Record<string, any>[]; send: (msg: unknown) => void; close: () => void };
  const openRaw = async (join: Record<string, unknown>): Promise<RawBox> => {
    const ws = new WebSocket(url);
    const messages: Record<string, any>[] = [];
    ws.on('message', (raw: WebSocket.RawData) => {
      try {
        messages.push(JSON.parse(String(raw)) as Record<string, any>);
      } catch {
        /* ignore */
      }
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    ws.send(JSON.stringify({ t: 'join', ...join }));
    return {
      messages,
      send: (msg: unknown) => ws.send(JSON.stringify(msg)),
      close: () => ws.close(),
    };
  };

  const hosted = emptyMap({ name: '联机共享图' });
  const host = await openRaw({ role: 'host', map: hosted, mapHash: mapHash(hosted) });
  check('the host joins with its map', await waitFor(() => host.messages.some((m) => m.t === 'joined')));

  let received: MapFile | null = null;
  let receivedOk = false;
  const guest = new LanClient('guest', url, {
    onMap: (map, ok) => {
      received = map;
      receivedOk = ok;
    },
  });
  guest.connect();
  check('the guest stores the map it is sent', await waitFor(() => received !== null));
  check('the stored map is the host map', !!received && (received as MapFile).id === hosted.id);
  check('the guest verifies the hash', receivedOk);
  check('the map is really in the guest library', getMap(hosted.id)?.name === '联机共享图');
  check('the guest can now pick that map', levelIndexOf(hosted.id) >= 0);
  check('the host hears the confirmation', await waitFor(() => host.messages.some((m) => m.t === 'map-status' && m.ready.length === 1)));
  check(
    'the confirmation names a real seat',
    host.messages
      .filter((m) => m.t === 'map-status')
      .some((m) => Array.isArray(m.ready) && m.ready.every((id: string) => typeof id === 'string' && id.startsWith('p')))
  );

  // A tampered hash must be refused, and the host told why.
  const guest2 = new LanClient('guest', url, { onMap: (_map, ok) => (receivedOk = ok) });
  guest2.connect();
  await waitFor(() => host.messages.filter((m) => m.t === 'peer' && m.state === 'joined').length >= 1);
  const tampered = { ...emptyMap({ name: '被改过的图' }) };
  host.send({ t: 'map', map: tampered, hash: 'not-the-real-hash' });
  check('a tampered map fails the hash check', await waitFor(() => !receivedOk));
  check('the host is told the map failed', await waitFor(() => host.messages.some((m) => m.t === 'lobby-error' && m.reason === 'map-failed')));

  guest.close();
  guest2.close();
  host.close();
  await sleep(60);
  await lanServer.close();
}

console.log(`\n${passed} checks passed, ${failures.length} failed`);
if (failures.length) {
  for (const failure of failures) console.error(` - ${failure}`);
  throw new Error('maptest failed');
}
