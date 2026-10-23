/**
 * Tiny, dependency-free collision helpers.
 *
 * Everything is a circle except walls (axis-aligned boxes), which keeps the
 * maths exact and readable: circle-vs-AABB contact, ray-vs-AABB (slab method)
 * and the swept sphere-vs-box solve that prevents fast bullets from tunnelling.
 *
 * Kept free of Phaser imports so it can be unit tested in plain Node.
 */

export interface Vec2 {
  x: number;
  y: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Bounce factor, 0..1. Omitted = solid wall (1). */
  bounce?: number;
}

export interface CircleHit {
  /** Unit vector pointing from the wall surface towards the circle centre. */
  nx: number;
  ny: number;
  /** How far the circle has to be pushed along (nx, ny) to leave the wall. */
  depth: number;
}

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export const len = (x: number, y: number): number => Math.hypot(x, y);

/** Exact circle vs axis-aligned box test. Returns null when they don't touch. */
export function circleBox(px: number, py: number, r: number, b: Box): CircleHit | null {
  if (px + r <= b.x || px - r >= b.x + b.w || py + r <= b.y || py - r >= b.y + b.h) {
    return null;
  }

  const ix = clamp(px, b.x, b.x + b.w);
  const iy = clamp(py, b.y, b.y + b.h);
  let dx = px - ix;
  let dy = py - iy;
  const d2 = dx * dx + dy * dy;

  if (d2 > r * r) return null;

  if (d2 > 1e-9) {
    const d = Math.sqrt(d2);
    return { nx: dx / d, ny: dy / d, depth: r - d };
  }

  // Centre is inside the box: push out through the nearest face.
  const left = px - b.x;
  const right = b.x + b.w - px;
  const top = py - b.y;
  const bottom = b.y + b.h - py;
  const m = Math.min(left, right, top, bottom);
  if (m === left) return { nx: -1, ny: 0, depth: left + r };
  if (m === right) return { nx: 1, ny: 0, depth: right + r };
  if (m === top) return { nx: 0, ny: -1, depth: top + r };
  return { nx: 0, ny: 1, depth: bottom + r };
}

/**
 * Ray vs AABB (slab method). `dx`/`dy` must be a unit vector, so `entry` and
 * `exit` are distances along the ray. Both faces are reported: a ray that
 * starts inside the box (entry < 0) leaves through the `exit` face.
 */
export interface SlabHit {
  entry: number;
  exit: number;
  entryNx: number;
  entryNy: number;
  exitNx: number;
  exitNy: number;
}

export function rayBox(px: number, py: number, dx: number, dy: number, b: Box): SlabHit | null {
  let tmin = -Infinity;
  let tmax = Infinity;
  let entryNx = 0;
  let entryNy = 0;
  let exitNx = 0;
  let exitNy = 0;

  if (Math.abs(dx) < 1e-9) {
    if (px < b.x || px > b.x + b.w) return null;
  } else {
    const t1 = (b.x - px) / dx;
    const t2 = (b.x + b.w - px) / dx;
    const lo = Math.min(t1, t2);
    const hi = Math.max(t1, t2);
    // Traveling +x means we enter through the left face and leave on the right.
    const n = dx > 0 ? -1 : 1;
    if (lo > tmin) {
      tmin = lo;
      entryNx = n;
      entryNy = 0;
    }
    if (hi < tmax) {
      tmax = hi;
      exitNx = -n;
      exitNy = 0;
    }
  }

  if (Math.abs(dy) < 1e-9) {
    if (py < b.y || py > b.y + b.h) return null;
  } else {
    const t1 = (b.y - py) / dy;
    const t2 = (b.y + b.h - py) / dy;
    const lo = Math.min(t1, t2);
    const hi = Math.max(t1, t2);
    const n = dy > 0 ? -1 : 1;
    if (lo > tmin) {
      tmin = lo;
      entryNx = 0;
      entryNy = n;
    }
    if (hi < tmax) {
      tmax = hi;
      exitNx = 0;
      exitNy = -n;
    }
  }

  if (tmin > tmax) return null;
  return { entry: tmin, exit: tmax, entryNx, entryNy, exitNx, exitNy };
}

export interface SweepHit {
  nx: number;
  ny: number;
  box: Box;
  /** Remaining travel after the contact. */
  remaining: number;
}

/**
 * Moves a circle of radius r along (dx, dy) and reports the first box it hits,
 * together with the outward normal of the face that was touched.
 */
export function sweepCircleBox(
  px: number,
  py: number,
  r: number,
  dx: number,
  dy: number,
  boxes: Box[],
  ignore?: Box
): SweepHit | null {
  let best: SweepHit | null = null;
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-9) return null;
  // Normalise so the slab results are distances, not ray parameters.
  const ux = dx / dist;
  const uy = dy / dist;
  let bestExit = Infinity;

  for (const b of boxes) {
    if (b === ignore) continue;
    const ex: Box = { x: b.x - r, y: b.y - r, w: b.w + r * 2, h: b.h + r * 2 };
    const hit = rayBox(px, py, ux, uy, ex);
    if (!hit) continue;

    // Starting outside the expanded box means the contact is the entry face;
    // starting inside (e.g. a shell that just bounced) means it is the exit.
    const inside = hit.entry <= 0;
    const contact = inside ? hit.exit : hit.entry;
    if (contact <= 0) continue; // already past it, or moving away
    if (contact > dist) continue; // the face is beyond this step
    if (contact >= bestExit) continue;

    bestExit = contact;
    best = {
      nx: inside ? hit.exitNx : hit.entryNx,
      ny: inside ? hit.exitNy : hit.entryNy,
      box: b,
      remaining: dist - contact,
    };
  }
  return best;
}

/** Reflects velocity around a normal. Returns the new velocity (does not mutate). */
export function reflect(vx: number, vy: number, nx: number, ny: number): Vec2 {
  const d = vx * nx + vy * ny;
  return { x: vx - 2 * d * nx, y: vy - 2 * d * ny };
}
