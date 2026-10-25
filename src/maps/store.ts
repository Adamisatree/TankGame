/**
 * Local map library.
 *
 * Every map the player makes **or receives over LAN** is archived here
 * permanently, so the next session can pick it again. Storage is localStorage:
 * a map is a couple of KB, so a few hundred of them fit comfortably.
 *
 * Everything is defensive – private-mode browsers throw on `localStorage`, and
 * a corrupt blob must never stop the game from booting.
 */

import {
  MAP_FORMAT,
  MAP_SCHEMA_VERSION,
  looksLikeMap,
  mapHash,
  newMapId,
  normalizeMapFile,
  type MapFile,
} from './format';

const STORAGE_KEY = 'tankduel.maps';
const STORE_VERSION = 1;
/** Keep the library bounded so a shared machine cannot fill local storage. */
export const MAX_MAPS = 200;

interface StoreShape {
  version: number;
  maps: MapFile[];
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function readStore(): StoreShape {
  const store = storage();
  if (!store) return { version: STORE_VERSION, maps: [] };
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return { version: STORE_VERSION, maps: [] };
    const parsed = JSON.parse(raw) as Partial<StoreShape>;
    const maps = Array.isArray(parsed.maps) ? parsed.maps.filter(looksLikeMap).map(normalizeMapFile) : [];
    return { version: STORE_VERSION, maps };
  } catch {
    return { version: STORE_VERSION, maps: [] };
  }
}

/**
 * Writes the library back. False means the browser refused (private mode, quota,
 * disabled storage) — callers surface that instead of pretending it saved.
 */
function writeStore(shape: StoreShape): boolean {
  const store = storage();
  if (!store) return false;
  try {
    store.setItem(STORAGE_KEY, JSON.stringify({ version: STORE_VERSION, maps: shape.maps.slice(0, MAX_MAPS) }));
    return true;
  } catch {
    return false;
  }
}

/** Newest first. */
export function listMaps(): MapFile[] {
  return readStore().maps.slice().sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}

export function getMap(id: string): MapFile | null {
  return readStore().maps.find((map) => map.id === id) ?? null;
}

export function countMaps(): number {
  return readStore().maps.length;
}

/**
 * Adds or replaces a map. Saving an existing id bumps `rev`, so two machines
 * can tell "the same map" from "a newer version of it".
 */
export function saveMap(raw: MapFile, options: { bumpRev?: boolean } = {}): MapFile | null {
  const shape = readStore();
  const incoming = normalizeMapFile(raw);
  const existing = shape.maps.findIndex((map) => map.id === incoming.id);
  const now = new Date().toISOString();
  let saved: MapFile;

  if (existing >= 0) {
    const previous = shape.maps[existing];
    saved = {
      ...incoming,
      // Keep forward-compatible payloads that came from a newer build.
      extra: { ...previous.extra, ...incoming.extra },
      rev: options.bumpRev === false ? previous.rev : Math.max(previous.rev + 1, incoming.rev),
      createdAt: previous.createdAt,
      updatedAt: now,
    };
    shape.maps[existing] = saved;
  } else {
    saved = { ...incoming, rev: Math.max(1, incoming.rev), createdAt: incoming.createdAt, updatedAt: now };
    shape.maps.unshift(saved);
  }

  return writeStore(shape) ? saved : null;
}

/** Stores a map received from another player without touching its revision. */
export function archiveReceived(raw: MapFile): MapFile | null {
  const shape = readStore();
  const incoming = normalizeMapFile({ ...raw, source: 'received' });
  const existing = shape.maps.findIndex((map) => map.id === incoming.id);
  if (existing >= 0) {
    const previous = shape.maps[existing];
    // Same revision and same bytes: nothing to do.
    if (previous.rev === incoming.rev && mapHash(previous) === mapHash(incoming)) return previous;
    // (writing below may fail; the caller decides what to tell the host)
    shape.maps[existing] = {
      ...incoming,
      rev: Math.max(previous.rev, incoming.rev),
      createdAt: previous.createdAt,
      updatedAt: new Date().toISOString(),
      source: previous.source === 'local' ? 'local' : 'received',
    };
    return writeStore(shape) ? shape.maps[existing] : null;
  }
  shape.maps.unshift({ ...incoming, updatedAt: new Date().toISOString() });
  return writeStore(shape) ? shape.maps[0] : null;
}

export function deleteMap(id: string): void {
  const shape = readStore();
  shape.maps = shape.maps.filter((map) => map.id !== id);
  writeStore(shape);
}

/** Duplicate with a new id, so "保存副本" never overwrites the original. */
export function duplicateMap(id: string, name?: string): MapFile | null {
  const source = getMap(id);
  if (!source) return null;
  const now = new Date().toISOString();
  const copy = normalizeMapFile({
    ...source,
    id: newMapId(),
    rev: 1,
    name: name ?? `${source.name} 副本`,
    createdAt: now,
    updatedAt: now,
    source: 'local',
  });
  return saveMap(copy);
}

// ------------------------------------------------------------------ files

/** Pretty JSON, ready to save as `<name>.tankmap.json`. */
export function exportMapText(map: MapFile): string {
  return JSON.stringify({ ...map, format: MAP_FORMAT, schemaVersion: map.schemaVersion }, null, 2);
}

export function exportFileName(map: MapFile): string {
  const safe = map.name.replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 40) || 'map';
  return `${safe}.tankmap.json`;
}

export interface ImportResult {
  ok: boolean;
  map?: MapFile;
  error?: string;
}

/** Reads a `.tankmap.json` (or a bare map object) into the library. */
export function importMapText(text: string): ImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: '不是有效的 JSON 文件' };
  }
  // Accept both a single map and a bundle { maps: [...] }.
  const bundle = parsed as { maps?: unknown };
  const candidate = Array.isArray(bundle?.maps) ? bundle.maps[0] : parsed;
  if (!looksLikeMap(candidate)) return { ok: false, error: '这看起来不是地图文件（缺少 walls / spawns）' };
  const map = normalizeMapFile({ ...(candidate as MapFile), source: 'local' });
  const stored = saveMap(map);
  if (!stored) return { ok: false, error: '本机存储写不进去（可能是隐私模式或已满）' };
  if (map.schemaVersion > MAP_SCHEMA_VERSION) {
    // Still load it – unknown fields are preserved – but say so.
    return { ok: true, map: stored, error: `这张图来自更新的格式 v${map.schemaVersion}，可能显示不全` };
  }
  return { ok: true, map: stored };
}

/** Rough storage footprint, for the "库已用 / 上限" line. */
export function libraryBytes(): number {
  const store = storage();
  try {
    return store?.getItem(STORAGE_KEY)?.length ?? 0;
  } catch {
    return 0;
  }
}
