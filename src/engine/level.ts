import type { Box } from './physics';

export interface TankSpawn {
  x: number;
  y: number;
  /** Radians, 0 = pointing right. */
  angle: number;
}

export interface Level {
  /** v1.3: multiplayer levels may be larger than the screen (world pixels). */
  world?: { w: number; h: number };
  /** v1.3: respawn points for FFA / team matches. */
  spawns?: { x: number; y: number; angle: number }[];
  /** v1.3: how many players this map is comfortable with. */
  seats?: number[];
  /** Stable id, used by the menu and by saved selections. */
  id: string;
  name: string;
  /** One line shown under the map preview. */
  blurb: string;
  /** Free-form hints for future mechanics (hazards, moving parts…). */
  tags: string[];
  walls: Box[];
  crates: Box[];
  /** Normalised spots where pickups may appear. */
  pickups: { x: number; y: number }[];
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
  /** v1.3 multiplayer: every respawn point, best-away-first chosen at death. */
  spawns: TankSpawn[];
}

const box = (x: number, y: number, w: number, h: number): Box => ({ x, y, w, h });

/** 180° rotation about the centre – keeps 1v1 maps fair. */
const flip = (b: Box): Box => ({
  x: Math.round((1 - b.x - b.w) * 1000) / 1000,
  y: Math.round((1 - b.y - b.h) * 1000) / 1000,
  w: b.w,
  h: b.h,
});

/** Author half a map, get the mirrored half for free. */
const sym = (...boxes: Box[]): Box[] => {
  const out: Box[] = [];
  for (const b of boxes) {
    out.push(b);
    const m = flip(b);
    const same = Math.abs(m.x - b.x) < 1e-6 && Math.abs(m.y - b.y) < 1e-6;
    if (!same) out.push(m);
  }
  return out;
};

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

  const fallbackSpawns: TankSpawn[] = [level.player, level.enemy];
  const spawnPoints = (level.spawns && level.spawns.length >= 2 ? level.spawns : fallbackSpawns).map(place);

  return {
    rect,
    walls,
    spawns: spawnPoints,
    crates: level.crates.map(project),
    player: place(level.player),
    enemy: place(level.enemy),
  };
}

const UP = -Math.PI / 2;
const DOWN = Math.PI / 2;

/**
 * Every map is hand-authored on the 0..1 grid and mirrored 180°, so both
 * players always get the same terrain and the same distance to the pickups.
 * Adding a map is just one more entry here – see README for the format.
 */
export const LEVELS: Level[] = [
  {
    id: 'court',
    name: '01 · 方厅',
    blurb: '四根柱子围出中庭，最基础的反弹练习场。',
    tags: ['open', 'classic'],
    walls: sym(box(0.32, 0.24, 0.1, 0.1), box(0.32, 0.5, 0.1, 0.1)),
    crates: [box(0.47, 0.47, 0.06, 0.06)],
    pickups: [
      { x: 0.5, y: 0.34 },
      { x: 0.5, y: 0.66 },
      { x: 0.26, y: 0.5 },
      { x: 0.74, y: 0.5 },
    ],
    player: { x: 0.5, y: 0.9, angle: UP },
    enemy: { x: 0.5, y: 0.1, angle: DOWN },
    enemyGrace: 2.6,
    enemyReload: 2.1,
  },
  {
    id: 'corridor',
    name: '02 · 回廊',
    blurb: '纵向长廊把地图切成三条道，贴墙的反弹球最难防。',
    tags: ['lanes'],
    walls: sym(
      box(0.3, 0.08, 0.06, 0.28),
      box(0.3, 0.58, 0.06, 0.28),
      box(0.08, 0.44, 0.26, 0.06),
      box(0.44, 0.44, 0.12, 0.12)
    ),
    crates: [box(0.44, 0.2, 0.06, 0.06), box(0.5, 0.74, 0.06, 0.06)],
    pickups: [
      { x: 0.5, y: 0.28 },
      { x: 0.5, y: 0.72 },
      { x: 0.12, y: 0.38 },
      { x: 0.88, y: 0.62 },
    ],
    player: { x: 0.5, y: 0.93, angle: UP },
    enemy: { x: 0.5, y: 0.07, angle: DOWN },
    enemyGrace: 2.4,
    enemyReload: 1.9,
  },
  {
    id: 'cross',
    name: '03 · 交叉',
    blurb: '四条短墙围成十字，中间的木箱是最好的掩体。',
    tags: ['open', 'cover'],
    walls: sym(box(0.36, 0.22, 0.28, 0.06), box(0.22, 0.36, 0.06, 0.28), box(0.14, 0.1, 0.16, 0.05)),
    crates: [box(0.46, 0.46, 0.08, 0.08)],
    pickups: [
      { x: 0.5, y: 0.36 },
      { x: 0.5, y: 0.64 },
      { x: 0.36, y: 0.5 },
      { x: 0.64, y: 0.5 },
    ],
    player: { x: 0.5, y: 0.92, angle: UP },
    enemy: { x: 0.5, y: 0.08, angle: DOWN },
    enemyGrace: 2.2,
    enemyReload: 1.7,
  },
  {
    id: 'colonnade',
    name: '04 · 柱廊',
    blurb: '六根石柱，绕柱子打反弹最容易吃到自己的球。',
    tags: ['pillars'],
    walls: sym(box(0.18, 0.22, 0.1, 0.1), box(0.45, 0.2, 0.1, 0.1), box(0.18, 0.56, 0.1, 0.1)),
    crates: [box(0.47, 0.47, 0.06, 0.06)],
    pickups: [
      { x: 0.5, y: 0.34 },
      { x: 0.5, y: 0.66 },
      { x: 0.32, y: 0.44 },
      { x: 0.68, y: 0.56 },
      { x: 0.58, y: 0.42 },
    ],
    player: { x: 0.5, y: 0.93, angle: UP },
    enemy: { x: 0.5, y: 0.07, angle: DOWN },
    enemyGrace: 2.4,
    enemyReload: 1.9,
  },
  {
    id: 'ring',
    name: '05 · 回字',
    blurb: '中央一圈石墙四门洞开，抢中间的道具要小心被夹住。',
    tags: ['ring', 'pickup-fight'],
    walls: sym(
      box(0.34, 0.34, 0.12, 0.05),
      box(0.54, 0.34, 0.12, 0.05),
      box(0.34, 0.34, 0.05, 0.12),
      box(0.61, 0.34, 0.05, 0.12)
    ),
    crates: [box(0.18, 0.18, 0.06, 0.06), box(0.76, 0.76, 0.06, 0.06)],
    pickups: [
      { x: 0.5, y: 0.5 },
      { x: 0.5, y: 0.22 },
      { x: 0.5, y: 0.78 },
      { x: 0.22, y: 0.5 },
      { x: 0.78, y: 0.5 },
    ],
    player: { x: 0.5, y: 0.93, angle: UP },
    enemy: { x: 0.5, y: 0.07, angle: DOWN },
    enemyGrace: 2.3,
    enemyReload: 1.8,
  },
  {
    id: 'alley',
    name: '06 · 夹道',
    blurb: '两道长墙卡住中路，只能从两侧的缝里钻过去。',
    tags: ['lanes', 'chokepoint'],
    walls: sym(
      box(0.08, 0.3, 0.36, 0.05),
      box(0.56, 0.3, 0.36, 0.05),
      box(0.475, 0.4, 0.05, 0.1)
    ),
    crates: [box(0.24, 0.5, 0.06, 0.06), box(0.7, 0.5, 0.06, 0.06)],
    pickups: [
      { x: 0.36, y: 0.56 },
      { x: 0.12, y: 0.62 },
      { x: 0.88, y: 0.38 },
      { x: 0.5, y: 0.18 },
      { x: 0.5, y: 0.82 },
    ],
    player: { x: 0.5, y: 0.93, angle: UP },
    enemy: { x: 0.5, y: 0.07, angle: DOWN },
    enemyGrace: 2.5,
    enemyReload: 2.0,
  },
  {
    id: 'stairs',
    name: '07 · 对角',
    blurb: '阶梯状的折墙，斜着跑能一路蹭反弹。',
    tags: ['steps'],
    walls: sym(
      box(0.14, 0.14, 0.22, 0.06),
      box(0.14, 0.14, 0.06, 0.22),
      box(0.4, 0.34, 0.2, 0.06),
      box(0.4, 0.34, 0.06, 0.2)
    ),
    crates: [box(0.47, 0.2, 0.06, 0.06), box(0.47, 0.74, 0.06, 0.06)],
    pickups: [
      { x: 0.5, y: 0.5 },
      { x: 0.3, y: 0.62 },
      { x: 0.7, y: 0.38 },
      { x: 0.32, y: 0.26 },
      { x: 0.68, y: 0.74 },
    ],
    player: { x: 0.2, y: 0.86, angle: UP },
    enemy: { x: 0.8, y: 0.14, angle: DOWN },
    enemyGrace: 2.4,
    enemyReload: 1.9,
  },
  {
    id: 'forts',
    name: '08 · 双城',
    blurb: '对角两座小要塞，出门就是开阔地，适合敢冲的人。',
    tags: ['forts', 'open'],
    walls: sym(
      box(0.1, 0.74, 0.24, 0.05),
      box(0.1, 0.56, 0.05, 0.18),
      box(0.1, 0.56, 0.12, 0.05),
      box(0.42, 0.42, 0.16, 0.06),
      box(0.42, 0.42, 0.06, 0.16)
    ),
    crates: [box(0.62, 0.62, 0.06, 0.06), box(0.32, 0.32, 0.06, 0.06)],
    pickups: [
      { x: 0.5, y: 0.36 },
      { x: 0.3, y: 0.3 },
      { x: 0.7, y: 0.7 },
      { x: 0.5, y: 0.24 },
      { x: 0.5, y: 0.76 },
    ],
    player: { x: 0.22, y: 0.9, angle: UP },
    enemy: { x: 0.78, y: 0.1, angle: DOWN },
    enemyGrace: 2.4,
    enemyReload: 1.9,
  },
  // ------------------------------------------------------------ multiplayer
  // v1.3: bigger arenas for 2–10 players. `world` is larger than the screen, so
  // the camera follows the local tank; `spawns` gives every death somewhere
  // sensible to come back (always more points than seats).
  {
    id: 'yard',
    name: 'M1 · 后院',
    blurb: '2–3 人的开阔后院：两排矮墙、四角栈板，打起来节奏最快。',
    tags: ['multi', 'open'],
    world: { w: 1800, h: 1200 },
    seats: [2, 3, 4],
    walls: sym(box(0.22, 0.3, 0.16, 0.05), box(0.3, 0.62, 0.05, 0.14), box(0.45, 0.45, 0.1, 0.1)),
    crates: [box(0.4, 0.24, 0.05, 0.05), box(0.55, 0.7, 0.05, 0.05), box(0.15, 0.5, 0.05, 0.05)],
    pickups: [
      { x: 0.5, y: 0.34 },
      { x: 0.2, y: 0.2 },
      { x: 0.8, y: 0.8 },
      { x: 0.5, y: 0.18 },
      { x: 0.5, y: 0.82 },
      { x: 0.18, y: 0.62 },
    ],
    player: { x: 0.5, y: 0.9, angle: UP },
    enemy: { x: 0.5, y: 0.1, angle: DOWN },
    spawns: [
      { x: 0.5, y: 0.9, angle: UP },
      { x: 0.5, y: 0.1, angle: DOWN },
      { x: 0.1, y: 0.5, angle: 0 },
      { x: 0.9, y: 0.5, angle: Math.PI },
      { x: 0.2, y: 0.2, angle: Math.PI / 4 },
      { x: 0.8, y: 0.8, angle: -Math.PI * 0.75 },
    ],
    enemyGrace: 2.4,
    enemyReload: 1.9,
  },
  {
    id: 'depot',
    name: 'M2 · 货场',
    blurb: '4–6 人的货场：三列集装箱把场地切成走廊，绕后特别赚。',
    tags: ['multi', 'lanes'],
    world: { w: 2400, h: 1600 },
    seats: [4, 5, 6],
    walls: sym(
      box(0.16, 0.22, 0.05, 0.3),
      box(0.3, 0.16, 0.05, 0.28),
      box(0.16, 0.62, 0.3, 0.05),
      box(0.36, 0.4, 0.16, 0.05)
    ),
    crates: [
      box(0.26, 0.5, 0.05, 0.05),
      box(0.6, 0.5, 0.05, 0.05),
      box(0.46, 0.28, 0.05, 0.05),
      box(0.46, 0.68, 0.05, 0.05),
    ],
    pickups: [
      { x: 0.5, y: 0.5 },
      { x: 0.5, y: 0.2 },
      { x: 0.5, y: 0.8 },
      { x: 0.2, y: 0.56 },
      { x: 0.8, y: 0.44 },
      { x: 0.26, y: 0.3 },
      { x: 0.74, y: 0.7 },
    ],
    player: { x: 0.5, y: 0.92, angle: UP },
    enemy: { x: 0.5, y: 0.08, angle: DOWN },
    spawns: [
      { x: 0.5, y: 0.92, angle: UP },
      { x: 0.5, y: 0.08, angle: DOWN },
      { x: 0.08, y: 0.5, angle: 0 },
      { x: 0.92, y: 0.5, angle: Math.PI },
      { x: 0.22, y: 0.22, angle: Math.PI / 4 },
      { x: 0.78, y: 0.78, angle: -Math.PI * 0.75 },
      { x: 0.78, y: 0.22, angle: Math.PI * 0.75 },
      { x: 0.22, y: 0.78, angle: -Math.PI / 4 },
    ],
    enemyGrace: 2.4,
    enemyReload: 1.9,
  },
  {
    id: 'field',
    name: 'M3 · 大战场',
    blurb: '8–10 人的大图：中央废墟加四周散点，够跑、够绕，也够乱。',
    tags: ['multi', 'large'],
    world: { w: 3200, h: 2200 },
    seats: [8, 10],
    walls: sym(
      box(0.3, 0.3, 0.16, 0.05),
      box(0.3, 0.3, 0.05, 0.16),
      box(0.14, 0.12, 0.05, 0.2),
      box(0.42, 0.14, 0.16, 0.05),
      box(0.2, 0.44, 0.12, 0.05)
    ),
    crates: [
      box(0.5, 0.5, 0.05, 0.05),
      box(0.34, 0.62, 0.05, 0.05),
      box(0.66, 0.38, 0.05, 0.05),
      box(0.24, 0.3, 0.05, 0.05),
      box(0.76, 0.7, 0.05, 0.05),
    ],
    pickups: [
      { x: 0.6, y: 0.5 },
      { x: 0.5, y: 0.24 },
      { x: 0.5, y: 0.76 },
      { x: 0.12, y: 0.5 },
      { x: 0.88, y: 0.5 },
      { x: 0.26, y: 0.26 },
      { x: 0.74, y: 0.74 },
      { x: 0.74, y: 0.26 },
      { x: 0.26, y: 0.74 },
    ],
    player: { x: 0.7, y: 0.9, angle: UP },
    enemy: { x: 0.3, y: 0.1, angle: DOWN },
    spawns: [
      { x: 0.7, y: 0.9, angle: UP },
      { x: 0.3, y: 0.1, angle: DOWN },
      { x: 0.06, y: 0.5, angle: 0 },
      { x: 0.94, y: 0.5, angle: Math.PI },
      { x: 0.18, y: 0.18, angle: Math.PI / 4 },
      { x: 0.82, y: 0.82, angle: -Math.PI * 0.75 },
      { x: 0.82, y: 0.18, angle: Math.PI * 0.75 },
      { x: 0.18, y: 0.82, angle: -Math.PI / 4 },
      { x: 0.34, y: 0.5, angle: 0 },
      { x: 0.66, y: 0.5, angle: Math.PI },
      { x: 0.5, y: 0.34, angle: -Math.PI / 2 },
      { x: 0.5, y: 0.66, angle: Math.PI / 2 },
    ],
    enemyGrace: 2.4,
    enemyReload: 1.9,
  },
];

/** Maps built for many players (they carry a `world` bigger than the screen). */
export const MULTI_LEVELS: Level[] = LEVELS.filter((level) => !!level.world);

/** Best multiplayer map for a given head count. */
export function levelForSeats(seats: number): Level {
  const fitting = MULTI_LEVELS.filter((level) => (level.seats ?? [2]).includes(seats));
  if (fitting.length) return fitting[0];
  // In between seat counts (7, 9): take the largest map that is not oversized.
  const sorted = [...MULTI_LEVELS].sort((a, b) => (a.seats?.[0] ?? 2) - (b.seats?.[0] ?? 2));
  return sorted.find((level) => (level.seats?.[0] ?? 2) >= seats) ?? sorted[sorted.length - 1] ?? LEVELS[0];
}

export const DEFAULT_LEVEL_ID = LEVELS[0].id;

export function levelById(id: string): Level {
  return LEVELS.find((l) => l.id === id) ?? LEVELS[0];
}

export function levelIndexById(id: string): number {
  const i = LEVELS.findIndex((l) => l.id === id);
  return i < 0 ? 0 : i;
}

/** Rotate through the roster so a "random" pick is always a different map. */
export function randomLevelIndex(exclude = -1, random: () => number = Math.random): number {
  if (LEVELS.length <= 1) return 0;
  let i = Math.floor(random() * LEVELS.length);
  // A constant RNG could keep landing on the excluded map; nudge instead of looping.
  if (i === exclude) i = (i + 1) % LEVELS.length;
  return i;
}

// ------------------------------------------------------------------ validation

export interface LevelIssue {
  id: string;
  issue: string;
}

/** Margin a tank needs: its radius plus a little breathing room (normalised). */
const SPAWN_CLEAR = 0.055;

function insideBox(px: number, py: number, b: Box, pad = 0): boolean {
  return px > b.x - pad && px < b.x + b.w + pad && py > b.y - pad && py < b.y + b.h + pad;
}

/**
 * Sanity-checks authored maps. Run from the test suite so a bad map can never
 * ship, and so future maps (or generated ones) have a contract to satisfy.
 */
export function validateLevels(levels: Level[] = LEVELS): LevelIssue[] {
  const issues: LevelIssue[] = [];
  const seen = new Set<string>();

  for (const level of levels) {
    const push = (issue: string) => issues.push({ id: level.id, issue });

    if (seen.has(level.id)) push('duplicate id');
    seen.add(level.id);

    if (!level.name || !level.blurb) push('missing name/blurb');

    for (const b of [...level.walls, ...level.crates]) {
      if (b.w <= 0 || b.h <= 0) push(`degenerate box ${JSON.stringify(b)}`);
      if (b.x < 0 || b.y < 0 || b.x + b.w > 1.0001 || b.y + b.h > 1.0001) {
        push(`box out of bounds ${JSON.stringify(b)}`);
      }
    }

    for (const [label, spawn] of [
      ['player', level.player],
      ['enemy', level.enemy],
    ] as const) {
      if (spawn.x < 0.05 || spawn.x > 0.95 || spawn.y < 0.05 || spawn.y > 0.95) {
        push(`${label} spawn outside the playable area`);
      }
      if (level.walls.some((b) => insideBox(spawn.x, spawn.y, b, SPAWN_CLEAR))) {
        push(`${label} spawn touches a wall`);
      }
      if (level.crates.some((b) => insideBox(spawn.x, spawn.y, b, SPAWN_CLEAR))) {
        push(`${label} spawn touches a crate`);
      }
    }

    if (Math.hypot(level.player.x - level.enemy.x, level.player.y - level.enemy.y) < 0.45) {
      push('spawns are too close together');
    }

    // A tank parked with its barrel in a wall can't shoot, so spawns need a
    // clear firing lane: the muzzle sits ~45px ahead of the hull centre.
    for (const [label, spawn] of [
      ['player', level.player],
      ['enemy', level.enemy],
    ] as const) {
      const dx = Math.cos(spawn.angle);
      const dy = Math.sin(spawn.angle);
      // Walk the firing lane and stop at the first wall; 0.085 ≈ 50px.
      for (let d = 0.02; d <= 0.12; d += 0.005) {
        const px = spawn.x + dx * d;
        const py = spawn.y + dy * d;
        if (level.walls.some((b) => insideBox(px, py, b, 0.012))) {
          if (d < 0.085) push(`${label} spawn has no room to fire (${(d * 100).toFixed(0)})`);
          break;
        }
      }
    }

    for (const crate of level.crates) {
      if (level.walls.some((w) => insideBox(crate.x, crate.y, w, 0) || insideBox(crate.x + crate.w, crate.y + crate.h, w, 0))) {
        push(`crate overlaps a wall at ${JSON.stringify(crate)}`);
      }
    }

    if (level.pickups.length < 3) push('needs at least three pickup spots');

    for (const p of level.pickups) {
      if (p.x < 0.04 || p.x > 0.96 || p.y < 0.04 || p.y > 0.96) push('pickup outside the arena');
      if (level.walls.some((b) => insideBox(p.x, p.y, b, 0.03))) push('pickup inside a wall');
      if (level.crates.some((b) => insideBox(p.x, p.y, b, 0.02))) push('pickup inside a crate');
    }
  }

  return issues;
}
