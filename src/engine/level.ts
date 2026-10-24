import type { Box } from './physics';

export interface TankSpawn {
  x: number;
  y: number;
  /** Radians, 0 = pointing right. */
  angle: number;
}

export interface Level {
  name: string;
  walls: Box[];
  crates: Box[];
  player: TankSpawn;
  enemy: TankSpawn;
  /** Seconds of "aim telegraph" before the enemy is allowed to fire. */
  enemyGrace: number;
  /** Seconds between enemy shots. */
  enemyReload: number;
}

export interface PlayRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Layout {
  rect: PlayRect;
  walls: Box[];
  crates: Box[];
  player: TankSpawn;
  enemy: TankSpawn;
}

const box = (x: number, y: number, w: number, h: number): Box => ({ x, y, w, h });

/**
 * Authors levels on a normalised grid so they scale with the viewport, then
 * projects them into the drawing area and adds the outer frame.
 */
export function buildLayout(level: Level, rect: PlayRect, thickness = 14): Layout {
  const project = (b: Box): Box => ({
    x: rect.x + b.x * rect.w,
    y: rect.y + b.y * rect.h,
    w: b.w * rect.w,
    h: b.h * rect.h,
  });

  const walls = level.walls.map(project);

  // Outer frame – four solid walls so bullets always have something to bounce off.
  walls.push(box(rect.x, rect.y, rect.w, thickness));
  walls.push(box(rect.x, rect.y + rect.h - thickness, rect.w, thickness));
  walls.push(box(rect.x, rect.y, thickness, rect.h));
  walls.push(box(rect.x + rect.w - thickness, rect.y, thickness, rect.h));

  const place = (s: TankSpawn): TankSpawn => ({
    x: rect.x + s.x * rect.w,
    y: rect.y + s.y * rect.h,
    angle: s.angle,
  });

  return {
    rect,
    walls,
    crates: level.crates.map(project),
    player: place(level.player),
    enemy: place(level.enemy),
  };
}

/** Wall coordinates are normalised 0..1 inside the playable area. */
export const LEVELS: Level[] = [
  {
    name: '01 · 方厅',
    walls: [
      box(0.46, 0.2, 0.08, 0.14),
      box(0.2, 0.4, 0.14, 0.08),
      box(0.66, 0.4, 0.14, 0.08),
      box(0.46, 0.66, 0.08, 0.14),
      box(0.3, 0.7, 0.16, 0.06),
      box(0.54, 0.24, 0.16, 0.06),
    ],
    crates: [box(0.47, 0.47, 0.06, 0.06)],
    player: { x: 0.14, y: 0.82, angle: 0 },
    enemy: { x: 0.86, y: 0.2, angle: Math.PI },
    enemyGrace: 2.6,
    enemyReload: 2.1,
  },
  {
    name: '02 · 回廊',
    walls: [
      box(0.16, 0.14, 0.06, 0.32),
      box(0.36, 0.14, 0.3, 0.06),
      box(0.78, 0.14, 0.06, 0.24),
      box(0.78, 0.54, 0.06, 0.32),
      box(0.34, 0.8, 0.3, 0.06),
      box(0.16, 0.66, 0.06, 0.2),
      box(0.44, 0.42, 0.12, 0.12),
    ],
    crates: [
      box(0.6, 0.24, 0.06, 0.06),
      box(0.26, 0.52, 0.05, 0.05),
      box(0.58, 0.66, 0.06, 0.06),
    ],
    player: { x: 0.5, y: 0.9, angle: -Math.PI / 2 },
    enemy: { x: 0.5, y: 0.08, angle: Math.PI / 2 },
    enemyGrace: 2.4,
    enemyReload: 1.9,
  },
  {
    name: '03 · 交叉',
    walls: [
      box(0.3, 0.12, 0.06, 0.26),
      box(0.64, 0.12, 0.06, 0.26),
      box(0.3, 0.62, 0.06, 0.26),
      box(0.64, 0.62, 0.06, 0.26),
      box(0.12, 0.46, 0.16, 0.06),
      box(0.72, 0.46, 0.16, 0.06),
      box(0.44, 0.44, 0.12, 0.12),
    ],
    crates: [
      box(0.46, 0.12, 0.06, 0.06),
      box(0.46, 0.76, 0.06, 0.06),
      box(0.14, 0.2, 0.05, 0.05),
      box(0.8, 0.74, 0.05, 0.05),
    ],
    player: { x: 0.1, y: 0.88, angle: 0 },
    enemy: { x: 0.9, y: 0.12, angle: Math.PI },
    enemyGrace: 2.2,
    enemyReload: 1.7,
  },
];
