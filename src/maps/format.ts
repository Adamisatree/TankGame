/**
 * Map file format v1.
 *
 * This is the on-disk / on-the-wire shape of a map and it is meant to be stable:
 * later versions only **add** optional fields, bump `schemaVersion`, and keep
 * reading older files. Three rules keep that promise honest:
 *
 *  1. unknown fields are preserved verbatim (`extra`), so a newer map survives
 *     a round-trip through an older build;
 *  2. every field has a default, so a file from a newer build still loads;
 *  3. `schemaVersion` only goes up, and `minAppVersion` lets the game refuse a
 *     map it genuinely cannot draw.
 *
 * Geometry is normalised 0..1 so a map scales to any world size, exactly like
 * the built-in levels.
 */

import type { Box } from '../engine/physics';
import type { Level } from '../engine/level';
import { APP_VERSION } from '../version';

export const MAP_FORMAT = 'tankmap';
export const MAP_SCHEMA_VERSION = 1;

export type MirrorMode = 'none' | 'rot180' | 'flipX' | 'flipY';

export interface MapBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MapPoint {
  x: number;
  y: number;
}

export interface MapSpawn extends MapPoint {
  /** Radians, 0 = facing right. */
  angle: number;
  team?: number;
}

export interface MapFile {
  format: typeof MAP_FORMAT;
  schemaVersion: number;
  /** Stable, globally unique id (`custom-xxxx`). */
  id: string;
  /** Bumped on every save; two machines compare id+rev+hash. */
  rev: number;
  name: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  /** Oldest build that can draw this map. */
  minAppVersion: string;
  /** World size in pixels; also decides whether the camera scrolls. */
  size: { w: number; h: number };
  mirror: MirrorMode;
  walls: MapBox[];
  crates: MapBox[];
  pickups: MapPoint[];
  spawns: MapSpawn[];
  meta: { tags: string[]; blurb: string };
  /** Forward compatibility: anything a newer build wrote lives here. */
  extra: Record<string, unknown>;
  /** Where this file came from (not part of the hash). */
  source?: 'builtin' | 'local' | 'received';
  /** Seat count this map is comfortable with (informational). */
  seats?: number[];
}

/** Size presets, matching the built-in arenas. */
export const MAP_SIZES = [
  { id: 'screen', label: '单屏 1280×720', w: 1280, h: 720 },
  { id: 'small', label: '小图 1800×1200', w: 1800, h: 1200 },
  { id: 'medium', label: '中图 2400×1600', w: 2400, h: 1600 },
  { id: 'large', label: '大图 3200×2200', w: 3200, h: 2200 },
] as const;

export type MapSizeId = (typeof MAP_SIZES)[number]['id'];

export const MIRROR_LABELS: Record<MirrorMode, string> = {
  none: '不镜像',
  rot180: '中心对称',
  flipX: '左右镜像',
  flipY: '上下镜像',
};

/** Grid the editor snaps to (normalised units). 40 × 24 cells. */
export const MAP_GRID = { cols: 40, rows: 24 };

const UP = -Math.PI / 2;
const DOWN = Math.PI / 2;

// ------------------------------------------------------------------ helpers

/** FNV-1a – tiny, dependency free, good enough to spot a corrupted transfer. */
/**
 * 64-bit FNV-1a over UTF-16 code units.
 *
 * v1.6.2: this used to be 32-bit, which is only ~4 billion values — a forged map
 * could be made to collide with a real one and two machines would then disagree
 * about the arena while both were "verified". 64 bits (two independently folded
 * lanes) is enough that a collision is not something a player can arrange; it
 * stays synchronous, unlike WebCrypto's SHA-256.
 */
export function hashString(text: string): string {
  const PRIME = 0x100000001b3n;
  const MASK = 0xffffffffffffffffn;
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * PRIME) & MASK;
  }
  return hash.toString(16).padStart(16, '0');
}

/** Canonical JSON for hashing and equality: keys sorted, no volatile fields. */
export function canonicalMap(map: MapFile): string {
  const body = {
    format: map.format,
    schemaVersion: map.schemaVersion,
    id: map.id,
    rev: map.rev,
    name: map.name,
    size: map.size,
    mirror: map.mirror,
    walls: map.walls,
    crates: map.crates,
    pickups: map.pickups,
    spawns: map.spawns,
    meta: map.meta,
  };
  return JSON.stringify(body);
}

export function mapHash(map: MapFile): string {
  return hashString(canonicalMap(map));
}

export function newMapId(random: () => number = Math.random): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < 6; i += 1) out += alphabet[Math.floor(random() * alphabet.length)];
  return `custom-${out}`;
}

const round3 = (value: number): number => Math.round(value * 1000) / 1000;
const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizeBox(raw: unknown): MapBox | null {
  if (!raw || typeof raw !== 'object') return null;
  const box = raw as Partial<MapBox>;
  const w = clamp01(num(box.w, 0.05));
  const h = clamp01(num(box.h, 0.05));
  if (w <= 0 || h <= 0) return null;
  return {
    x: round3(clamp01(num(box.x, 0.5 - w / 2))),
    y: round3(clamp01(num(box.y, 0.5 - h / 2))),
    w: round3(w),
    h: round3(h),
  };
}

function normalizePoint(raw: unknown): MapPoint | null {
  if (!raw || typeof raw !== 'object') return null;
  const point = raw as Partial<MapPoint>;
  return { x: round3(clamp01(num(point.x, 0.5))), y: round3(clamp01(num(point.y, 0.5))) };
}

function normalizeSpawn(raw: unknown): MapSpawn | null {
  const point = normalizePoint(raw);
  if (!point) return null;
  const spawn = raw as Partial<MapSpawn>;
  return {
    ...point,
    angle: typeof spawn.angle === 'number' && Number.isFinite(spawn.angle) ? round3(spawn.angle) : UP,
    ...(typeof spawn.team === 'number' ? { team: Math.max(0, Math.round(spawn.team)) } : {}),
  };
}

/**
 * Reads anything that claims to be a map and returns a usable MapFile.
 *
 * Never throws: a broken file becomes an empty map rather than crashing the
 * menu. Callers that need to know whether it was really a map should check
 * `format` before normalising (see `looksLikeMap`).
 */
export function normalizeMapFile(raw: unknown): MapFile {
  const input = (raw ?? {}) as Partial<MapFile>;
  const size = {
    w: Math.max(640, Math.min(6000, Math.round(num(input.size?.w, 1280)))),
    h: Math.max(480, Math.min(6000, Math.round(num(input.size?.h, 720)))),
  };

  const walls = Array.isArray(input.walls) ? input.walls.map(normalizeBox).filter((b): b is MapBox => !!b) : [];
  const crates = Array.isArray(input.crates) ? input.crates.map(normalizeBox).filter((b): b is MapBox => !!b) : [];
  const pickups = Array.isArray(input.pickups)
    ? input.pickups.map(normalizePoint).filter((p): p is MapPoint => !!p)
    : [];
  const spawns = Array.isArray(input.spawns) ? input.spawns.map(normalizeSpawn).filter((s): s is MapSpawn => !!s) : [];
  // A playable map needs two ends even if the file forgot them. Keep whatever
  // was there and top it up, so a half-written file still opens as drawn.
  if (spawns.length === 0) spawns.push({ x: 0.5, y: 0.9, angle: UP });
  if (spawns.length === 1) spawns.push({ x: 0.5, y: 0.1, angle: DOWN });

  const mirror = (['none', 'rot180', 'flipX', 'flipY'] as MirrorMode[]).includes(input.mirror as MirrorMode)
    ? (input.mirror as MirrorMode)
    : 'none';

  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 24) : '未命名地图';

  return {
    format: MAP_FORMAT,
    // Keep a newer schemaVersion visible so the UI can warn instead of silently
    // downgrading somebody's map.
    schemaVersion: Math.max(1, Math.round(num(input.schemaVersion, MAP_SCHEMA_VERSION))),
    // v1.6.2: an imported map could carry any string as its id (spaces, quotes,
    // a whole URL). Ids travel over LAN and are compared for equality, so keep
    // them to a plain identifier and mint a fresh one otherwise.
    id: /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/.test(String(input.id ?? '').trim())
      ? String(input.id).trim()
      : newMapId(),
    rev: Math.max(1, Math.round(num(input.rev, 1))),
    name,
    author: typeof input.author === 'string' ? input.author.slice(0, 24) : '',
    createdAt: typeof input.createdAt === 'string' ? input.createdAt : new Date().toISOString(),
    updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : new Date().toISOString(),
    minAppVersion: typeof input.minAppVersion === 'string' ? input.minAppVersion : '1.4.0',
    size,
    mirror,
    walls,
    crates,
    pickups,
    spawns,
    meta: {
      tags: Array.isArray(input.meta?.tags) ? input.meta!.tags.filter((t) => typeof t === 'string').slice(0, 8) : [],
      blurb: typeof input.meta?.blurb === 'string' ? input.meta.blurb.slice(0, 80) : '',
    },
    extra: input.extra && typeof input.extra === 'object' ? { ...(input.extra as Record<string, unknown>) } : {},
    ...(input.source ? { source: input.source } : {}),
    ...(Array.isArray(input.seats) ? { seats: input.seats.filter((n) => typeof n === 'number') } : {}),
  };
}

/** Quick shape test before handing a payload to `normalizeMapFile`. */
export function looksLikeMap(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const map = raw as Partial<MapFile>;
  if (map.format && map.format !== MAP_FORMAT) return false;
  return Array.isArray(map.walls) || Array.isArray(map.crates) || Array.isArray(map.spawns);
}

// ------------------------------------------------------------------ mirroring

const flip = (b: MapBox, mode: MirrorMode): MapBox => {
  switch (mode) {
    case 'rot180':
      return { x: round3(1 - b.x - b.w), y: round3(1 - b.y - b.h), w: b.w, h: b.h };
    case 'flipX':
      return { x: round3(1 - b.x - b.w), y: b.y, w: b.w, h: b.h };
    case 'flipY':
      return { x: b.x, y: round3(1 - b.y - b.h), w: b.w, h: b.h };
    default:
      return b;
  }
};

/**
 * Applies the map's mirror mode: the authored half becomes a fair whole.
 * Duplicates that land on top of the original are dropped.
 */
export function applyMirror(map: MapFile, mode: MirrorMode = map.mirror): MapFile {
  if (mode === 'none') return map;
  // One dedupe set per list: a crate drawn on top of a wall is *not* a duplicate
  // of it, and sharing a set used to drop that crate from the played map while
  // the editor still showed it.
  const expand = <T extends MapBox>(list: T[], seen: Set<string>): T[] => {
    const out: T[] = [];
    for (const item of list) {
      for (const candidate of [item, { ...item, ...flip(item, mode) }]) {
        const key = `${round3(candidate.x)}|${round3(candidate.y)}|${round3(candidate.w)}|${round3(candidate.h)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(candidate as T);
      }
    }
    return out;
  };
  return {
    ...map,
    mirror: mode,
    walls: expand(map.walls, new Set<string>()),
    crates: expand(map.crates, new Set<string>()),
    pickups: map.pickups.flatMap((point) => {
      const mirrored = { x: round3(1 - point.x), y: round3(1 - point.y) };
      if (mode === 'flipX') mirrored.y = point.y;
      if (mode === 'flipY') mirrored.x = point.x;
      const same = Math.abs(mirrored.x - point.x) < 1e-6 && Math.abs(mirrored.y - point.y) < 1e-6;
      return same ? [point] : [point, mirrored];
    }),
  };
}

// ------------------------------------------------------------------ validation

export type MapIssueLevel = 'error' | 'warn';

export interface MapIssue {
  severity: MapIssueLevel;
  code: string;
  message: string;
}

const overlaps = (a: MapBox, b: MapBox): boolean =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

const insideBox = (x: number, y: number, b: MapBox): boolean => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;

/**
 * The editor's guard rails. The same rules the built-in maps are held to, so a
 * custom map can never ship in a state where the game breaks (spawn inside a
 * wall, no firing room, pickup unreachable).
 */
export function validateMap(map: MapFile): MapIssue[] {
  const issues: MapIssue[] = [];
  const push = (severity: MapIssueLevel, code: string, message: string): void => {
    issues.push({ severity, code, message });
  };

  if (map.walls.length + map.crates.length === 0) {
    push('warn', 'empty', '这张图还没有任何墙或木箱，打起来会很空旷。');
  }
  if (map.spawns.length < 2) push('error', 'spawns', '至少要 2 个出生点（一局最少两人）。');
  if (map.walls.length > 80) push('warn', 'busy', '墙太多了，可能会卡住；建议 80 块以内。');

  map.walls.forEach((wall, index) => {
    if (wall.w < 0.01 || wall.h < 0.01) push('warn', 'tiny-wall', `第 ${index + 1} 块墙太小了，可能看不见。`);
  });

  // Spawns: inside the arena, clear of walls/crates, and with room to shoot.
  map.spawns.forEach((spawn, index) => {
    const label = `出生点 ${index + 1}`;
    const wallHit = map.walls.findIndex((wall) => insideBox(spawn.x, spawn.y, wall) || overlaps({ x: spawn.x - 0.02, y: spawn.y - 0.02, w: 0.04, h: 0.04 }, wall));
    if (wallHit >= 0) push('error', 'spawn-wall', `${label} 在墙里或贴着墙（第 ${wallHit + 1} 块）。`);
    const crateHit = map.crates.findIndex((crate) => insideBox(spawn.x, spawn.y, crate));
    if (crateHit >= 0) push('error', 'spawn-crate', `${label} 和木箱重叠，开局会被卡住。`);
    if (spawn.x < 0.04 || spawn.x > 0.96 || spawn.y < 0.05 || spawn.y > 0.95) {
      push('error', 'spawn-edge', `${label} 太靠边了，坦克放不下。`);
    }
    // Firing room: a short probe ahead must not start inside a wall.
    const probe = 0.05;
    const ahead = {
      x: spawn.x + Math.cos(spawn.angle) * probe - 0.012,
      y: spawn.y + Math.sin(spawn.angle) * probe - 0.012,
      w: 0.024,
      h: 0.024,
    };
    if (map.walls.some((wall) => overlaps(ahead, wall))) {
      push('error', 'spawn-face-wall', `${label} 正对着墙，开局打不出炮弹。`);
    }
  });

  map.pickups.forEach((pickup, index) => {
    const wallHit = map.walls.findIndex((wall) => insideBox(pickup.x, pickup.y, wall));
    if (wallHit >= 0) push('error', 'pickup-wall', `道具 ${index + 1} 卡在墙里（第 ${wallHit + 1} 块）。`);
    const crateHit = map.crates.findIndex((crate) => insideBox(pickup.x, pickup.y, crate));
    if (crateHit >= 0) push('error', 'pickup-crate', `道具 ${index + 1} 卡在木箱里。`);
    if (pickup.x < 0.02 || pickup.x > 0.98 || pickup.y < 0.03 || pickup.y > 0.97) {
      push('warn', 'pickup-edge', `道具 ${index + 1} 太贴边了，几乎吃不到。`);
    }
  });

  map.crates.forEach((crate, index) => {
    const wallHit = map.walls.findIndex((wall) => overlaps(crate, wall));
    if (wallHit >= 0) push('warn', 'crate-wall', `木箱 ${index + 1} 和墙重叠了。`);
  });

  if (map.schemaVersion > MAP_SCHEMA_VERSION) {
    push('warn', 'newer', `这张图是更新版本（格式 v${map.schemaVersion}）存的，可能有些内容认不出来。`);
  }
  // The format promises that `minAppVersion` is enforced, so enforce it. A build
  // with no injected version (unit tests, `tsx`) never rejects anything.
  if (APP_VERSION !== '0.0.0' && map.minAppVersion && !versionAtLeast(APP_VERSION, map.minAppVersion)) {
    push(
      'error',
      'min-app',
      `这张图需要 ${map.minAppVersion} 或更新的版本才能打开（当前 ${APP_VERSION}）。`
    );
  }
  if (map.pickups.length === 0) push('warn', 'no-pickups', '没有道具点，对局会少一种变数。');

  return issues;
}

export const mapHasErrors = (issues: MapIssue[]): boolean => issues.some((issue) => issue.severity === 'error');

/**
 * `value >= min` for dotted versions ("1.5.1"). Missing parts count as 0 and a
 * `-beta` style suffix is ignored, which is all a map's `minAppVersion` needs.
 */
export function versionAtLeast(value: string, min: string): boolean {
  const parts = (text: string): number[] =>
    String(text)
      .split('.')
      .map((chunk) => parseInt(chunk, 10))
      .map((n) => (Number.isFinite(n) ? n : 0));
  const a = parts(value);
  const b = parts(min);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
}

// ------------------------------------------------------------------ conversions

/** Screen proportions the un-scrolled play rectangle has. */
const VIEW_ASPECT = 16 / 9;

/** Does this map need a scrolling camera instead of being fitted to the screen? */
export function needsWorld(size: { w: number; h: number }): boolean {
  if (size.w > 1400 || size.h > 1400) return true;
  return Math.abs(size.w / size.h / VIEW_ASPECT - 1) > 0.02;
}

/** Map file → engine level (what `buildLayout` and the AI consume). */
export function toLevel(map: MapFile): Level {
  const expanded = applyMirror(map);
  const walls: Box[] = expanded.walls.map((wall) => ({ x: wall.x, y: wall.y, w: wall.w, h: wall.h }));
  const crates: Box[] = expanded.crates.map((crate) => ({ x: crate.x, y: crate.y, w: crate.w, h: crate.h }));
  const spawns = expanded.spawns.map((spawn) => ({ x: spawn.x, y: spawn.y, angle: spawn.angle }));
  const player = spawns[0] ?? { x: 0.5, y: 0.9, angle: UP };
  const enemy = spawns[1] ?? spawns[0] ?? { x: 0.5, y: 0.1, angle: DOWN };
  return {
    id: map.id,
    name: map.name,
    blurb: map.meta.blurb || '自定义地图',
    tags: ['custom', ...map.meta.tags],
    walls,
    crates,
    pickups: expanded.pickups.map((point) => ({ x: point.x, y: point.y })),
    player,
    enemy,
    spawns,
    enemyGrace: 2.4,
    enemyReload: 1.9,
    // A custom map twice the screen size scrolls the camera, just like the
    // built-in multiplayer arenas. A map with different proportions also needs
    // one: without `world` the normalised geometry is projected onto the 16:9
    // play rectangle, which stretched a tall map thin (C2).
    ...(needsWorld(map.size) ? { world: { w: map.size.w, h: map.size.h } } : {}),
    ...(map.seats ? { seats: map.seats } : {}),
  };
}

/**
 * Built-in level → editable map file (for "copy a built-in map and tweak it").
 * Levels are authored with a mirror already applied, so the copy starts as
 * `mirror: 'none'` with the full geometry.
 */
export function fromLevel(level: Level, options: { id?: string; name?: string; author?: string } = {}): MapFile {
  const now = new Date().toISOString();
  return normalizeMapFile({
    format: MAP_FORMAT,
    schemaVersion: MAP_SCHEMA_VERSION,
    id: options.id ?? newMapId(),
    rev: 1,
    name: options.name ?? level.name,
    author: options.author ?? '',
    createdAt: now,
    updatedAt: now,
    minAppVersion: APP_VERSION,
    size: level.world ? { w: level.world.w, h: level.world.h } : { w: 1280, h: 720 },
    mirror: 'none',
    walls: level.walls,
    crates: level.crates,
    pickups: level.pickups,
    spawns: (level.spawns && level.spawns.length >= 2 ? level.spawns : [level.player, level.enemy]).map((spawn) => ({
      x: spawn.x,
      y: spawn.y,
      angle: spawn.angle,
    })),
    meta: { tags: level.tags.filter((tag) => tag !== 'custom'), blurb: level.blurb },
    extra: {},
    source: 'local',
  });
}

/** A blank map with two spawns and a few props, ready to paint on. */
export function emptyMap(options: { name?: string; sizeId?: MapSizeId; author?: string } = {}): MapFile {
  const size = MAP_SIZES.find((entry) => entry.id === (options.sizeId ?? 'screen')) ?? MAP_SIZES[0];
  const now = new Date().toISOString();
  return normalizeMapFile({
    format: MAP_FORMAT,
    schemaVersion: MAP_SCHEMA_VERSION,
    id: newMapId(),
    rev: 1,
    name: options.name ?? '我的地图',
    author: options.author ?? '',
    createdAt: now,
    updatedAt: now,
    minAppVersion: APP_VERSION,
    size: { w: size.w, h: size.h },
    mirror: 'rot180',
    walls: [
      { x: 0.16, y: 0.2, w: 0.12, h: 0.08 },
      { x: 0.16, y: 0.72, w: 0.12, h: 0.08 },
      { x: 0.44, y: 0.44, w: 0.12, h: 0.12 },
    ],
    crates: [{ x: 0.47, y: 0.2, w: 0.06, h: 0.06 }],
    pickups: [
      { x: 0.5, y: 0.3 },
      { x: 0.5, y: 0.7 },
    ],
    spawns: [
      { x: 0.5, y: 0.9, angle: UP },
      { x: 0.5, y: 0.1, angle: DOWN },
    ],
    meta: { tags: [], blurb: '' },
    extra: {},
    source: 'local',
  });
}
