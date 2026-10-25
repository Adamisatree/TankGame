/**
 * The level list the game actually plays on: built-in maps first, then whatever
 * the player has in their local library.
 *
 * Everything that used to index `LEVELS` now goes through here, so a custom map
 * is a first-class citizen (picked in the menu, restarted, synced over LAN)
 * without the built-in maps changing their indices.
 */

import { LEVELS, type Level } from '../engine/level';
import { toLevel, type MapFile } from './format';
import { listMaps } from './store';

let cache: Level[] | null = null;
let cacheById = new Map<string, MapFile>();

function build(): void {
  const maps = listMaps();
  cacheById = new Map(maps.map((map) => [map.id, map]));
  const custom = maps.map(toLevel);
  cache = [...LEVELS, ...custom];
}

/** Built-in + custom levels. Cached until something changes in the library. */
export function levels(): Level[] {
  if (!cache) build();
  return cache as Level[];
}

/** Call after saving / deleting / importing a map. */
export function refreshLevels(): void {
  cache = null;
  cacheById = new Map();
}

/** The map file behind a custom level id (null for built-in maps). */
export function customMapById(id: string): MapFile | null {
  if (!cacheById.size) build();
  return cacheById.get(id) ?? null;
}

export function isCustomLevel(id: string): boolean {
  return id.startsWith('custom-');
}

export function levelById(id: string): Level {
  return levels().find((level) => level.id === id) ?? LEVELS[0];
}

export function levelIndexOf(id: string): number {
  const index = levels().findIndex((level) => level.id === id);
  return index >= 0 ? index : 0;
}

export function customLevelCount(): number {
  return levels().length - LEVELS.length;
}

/**
 * A random map for "随机". `pool: 'builtin'` keeps custom maps out of a random
 * pick (a hand-made map people did not choose can feel unfair).
 */
export function randomLevelIndex(
  exclude = -1,
  random: () => number = Math.random,
  pool: 'all' | 'builtin' = 'builtin'
): number {
  const list = pool === 'builtin' ? LEVELS.length : levels().length;
  if (list <= 1) return 0;
  let index = Math.floor(random() * list) % list;
  if (index === exclude) index = (index + 1) % list;
  return index;
}
