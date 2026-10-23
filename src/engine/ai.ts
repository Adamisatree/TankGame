import { reflect, sweepCircleBox, type Box } from './physics';

export interface ShotPlan {
  /** Launch direction in radians. */
  dir: number;
  bounces: number;
  /** Total path length in pixels. */
  length: number;
}

export interface Trace {
  dir: number;
  /** Bounces taken *before* reaching the closest approach. */
  bounces: number;
  /** Path length up to the closest approach. */
  length: number;
  /** Closest approach between the bullet path and the target centre. */
  miss: number;
}

export interface PlanOptions {
  radius?: number;
  targetRadius?: number;
  maxBounces?: number;
  maxLength?: number;
  samples?: number;
}

/**
 * Traces a bullet from (x, y) along `dir`, bouncing off walls, and reports the
 * closest approach to the target plus how far the path had to travel.
 */
export function trace(
  x: number,
  y: number,
  dir: number,
  targetX: number,
  targetY: number,
  walls: Box[],
  opts: PlanOptions = {}
): Trace {
  const radius = opts.radius ?? 5;
  const maxBounces = opts.maxBounces ?? 3;
  const maxLength = opts.maxLength ?? 2600;

  let px = x;
  let py = y;
  let dx = Math.cos(dir);
  let dy = Math.sin(dir);
  let travelled = 0;
  let miss = Infinity;
  let bouncesAtClosest = 0;
  let lengthAtClosest = 0;

  for (let b = 0; b <= maxBounces; b++) {
    const hit = sweepCircleBox(px, py, radius, dx * maxLength, dy * maxLength, walls);
    const segLen = hit ? maxLength - hit.remaining : maxLength;

    const closest = closestOnSegment(targetX, targetY, px, py, px + dx * segLen, py + dy * segLen);
    if (closest.dist < miss) {
      miss = closest.dist;
      bouncesAtClosest = b;
      lengthAtClosest = travelled + closest.t * segLen;
    }

    travelled += segLen;
    if (!hit || travelled >= maxLength) break;

    px += dx * segLen + hit.nx * 0.05;
    py += dy * segLen + hit.ny * 0.05;
    const r = reflect(dx, dy, hit.nx, hit.ny);
    dx = r.x;
    dy = r.y;
  }

  return { dir, bounces: bouncesAtClosest, length: lengthAtClosest, miss };
}

/**
 * Searches for a firing direction whose ricochet path passes through the
 * target. Coarse sweep first, then a shrinking local search around the best
 * candidate, which lands on an exact bank shot when one exists.
 */
export function planRicochetShot(
  x: number,
  y: number,
  targetX: number,
  targetY: number,
  walls: Box[],
  opts: PlanOptions = {}
): ShotPlan | null {
  const targetRadius = opts.targetRadius ?? 24;
  const samples = opts.samples ?? 72;
  const maxBounces = opts.maxBounces ?? 2;
  const shared: PlanOptions = { ...opts, maxBounces };

  let best = trace(x, y, 0, targetX, targetY, walls, shared);

  for (let i = 0; i < samples; i++) {
    const dir = (i / samples) * Math.PI * 2;
    const t = trace(x, y, dir, targetX, targetY, walls, shared);
    if (t.miss < best.miss) best = t;
  }

  // Local refinement: three halvings are enough to pin a bank shot down.
  let step = (Math.PI * 2) / samples;
  for (let round = 0; round < 4; round++) {
    step /= 2;
    const a = trace(x, y, best.dir - step, targetX, targetY, walls, shared);
    const b = trace(x, y, best.dir + step, targetX, targetY, walls, shared);
    const next = a.miss < b.miss ? a : b;
    if (next.miss >= best.miss) break;
    best = next;
  }

  if (best.miss > targetRadius) return null;
  return { dir: best.dir, bounces: best.bounces, length: best.length };
}

export function closestOnSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): { dist: number; t: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 1e-9 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return { dist: Math.hypot(px - (ax + dx * t), py - (ay + dy * t)), t };
}

export function pointSegmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  return closestOnSegment(px, py, ax, ay, bx, by).dist;
}

/** Earliest intersection parameter of a segment with a circle, or null. */
export function segmentCircleT(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  r: number
): number | null {
  const dx = bx - ax;
  const dy = by - ay;
  const fx = ax - cx;
  const fy = ay - cy;
  const a = dx * dx + dy * dy;
  if (a < 1e-9) return Math.hypot(fx, fy) <= r ? 0 : null;
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  const t1 = (-b - sq) / (2 * a);
  const t2 = (-b + sq) / (2 * a);
  if (t1 >= 0 && t1 <= 1) return t1;
  if (t2 >= 0 && t2 <= 1) return t2;
  return null;
}
