import { closestOnSegment } from './ai';
import { sweepCircleBox, reflect, type Box } from './physics';

/**
 * Bullet-dodging maths, kept free of Phaser so it can be unit tested.
 *
 * Everything here works on *predicted* shell paths: a shell bounces forever
 * until it expires, so "is this spot safe?" means simulating every live shell
 * forward and measuring how close its path comes to that spot.
 */

export interface ThreatBullet {
  x: number;
  y: number;
  vx: number;
  vy: number;
  bounces: number;
  maxBounces: number;
  radius: number;
}

export interface Threat {
  /** 0 = safe, 1 = will hit you on the spot. */
  danger: number;
  /** Seconds until the closest approach (Infinity when no threat). */
  eta: number;
}

const STEP = 1 / 90;

/** How dangerous a *static* point is, given the shells currently in the air. */
export function bulletThreatAt(
  px: number,
  py: number,
  radius: number,
  bullets: ThreatBullet[],
  walls: Box[],
  horizon = 1.15
): Threat {
  let worst = 0;
  let worstEta = Infinity;
  const hitR = radius + 10;

  for (const b of bullets) {
    let x = b.x;
    let y = b.y;
    let dx = b.vx;
    let dy = b.vy;
    let bounces = b.bounces;
    let t = 0;
    let best = Infinity;
    let bestT = Infinity;

    while (t < horizon) {
      const speed = Math.hypot(dx, dy);
      if (speed < 1e-3) break;
      const segLen = speed * STEP;
      const hit = sweepCircleBox(x, y, b.radius, (dx / speed) * segLen, (dy / speed) * segLen, walls);
      const travel = hit ? segLen - hit.remaining : segLen;
      const ux = dx / speed;
      const uy = dy / speed;

      const near = closestOnSegment(px, py, x, y, x + ux * travel, y + uy * travel);
      if (near.dist < best) {
        best = near.dist;
        bestT = t + near.t * STEP;
      }

      x += ux * travel;
      y += uy * travel;
      t += STEP;

      if (hit) {
        const r = reflect(dx, dy, hit.nx, hit.ny);
        const damping = hit.box.bounce ?? 0.94;
        dx = r.x * damping;
        dy = r.y * damping;
        bounces++;
        if (bounces > b.maxBounces) break;
      }

      if (Math.hypot(x - px, y - py) > 2800) break;
    }

    if (best < hitR) {
      const closeness = 1 - best / hitR;
      const urgency = 1 - Math.min(1, bestT / horizon);
      const danger = closeness * (0.45 + 0.55 * urgency);
      if (danger > worst) {
        worst = danger;
        worstEta = bestT;
      }
    }
  }

  return { danger: Math.min(1, worst), eta: worstEta };
}

export interface PickOptions {
  x: number;
  y: number;
  radius: number;
  /** Current facing, used to avoid dithering. */
  bodyAngle: number;
  walls: Box[];
  crates?: Box[];
  bullets?: ThreatBullet[];
  /** How strongly to avoid shells. */
  threatWeight?: number;
  /** Optional spot we would like to be at (chase / keep range). */
  target?: { x: number; y: number } | null;
  targetWeight?: number;
  /** Optional spot to keep away from (the opponent's hull). */
  avoid?: { x: number; y: number; radius: number } | null;
  avoidWeight?: number;
  /** Farthest step we may consider, px. */
  stepDistance?: number;
  samples?: number;
  horizon?: number;
}

export interface Heading {
  /** Direction to travel, radians (NaN when the best choice is to stay put). */
  angle: number;
  x: number;
  y: number;
  score: number;
  threat: number;
  /** 0 = stand still, 1 = full step. */
  move: number;
}

/**
 * Chooses where to move next. Candidates are the current spot plus a ring of
 * headings; each is scored on shell danger, wall clearance, the tactical pull
 * of `target` and how much turning it needs.
 */
export function pickHeading(opts: PickOptions): Heading {
  const radius = opts.radius;
  const walls = opts.walls;
  const crates = opts.crates ?? [];
  const bullets = opts.bullets ?? [];
  const threatWeight = opts.threatWeight ?? 1;
  const targetWeight = opts.targetWeight ?? 0;
  const avoidWeight = opts.avoidWeight ?? 0;
  const stepDistance = opts.stepDistance ?? 62;
  const samples = opts.samples ?? 16;
  const horizon = opts.horizon ?? 1.0;
  const clearance = radius + 8;

  const blocked = (x: number, y: number): boolean =>
    walls.some((w) => intersectsCircle(x, y, clearance, w)) ||
    crates.some((w) => intersectsCircle(x, y, clearance, w));

  const score = (x: number, y: number, move: number, angle: number): Heading => {
    let value = 0;
    const threat = threatWeight > 0 ? bulletThreatAt(x, y, radius, bullets, walls, horizon) : { danger: 0, eta: Infinity };
    value -= threatWeight * threat.danger * 140;

    // Keep some air between us and the nearest wall.
    value -= Math.max(0, 46 - nearestWallGap(x, y, walls)) * 0.9;

    if (targetWeight > 0 && opts.target) {
      value -= targetWeight * Math.hypot(opts.target.x - x, opts.target.y - y) * 0.22;
    }
    if (avoidWeight > 0 && opts.avoid) {
      const d = Math.hypot(opts.avoid.x - x, opts.avoid.y - y);
      if (d < opts.avoid.radius) value -= avoidWeight * (opts.avoid.radius - d) * 3;
    }
    if (move > 0) {
      const turn = Math.abs(wrap(angle - opts.bodyAngle));
      value -= turn * 0.6;
    }
    return { angle, x, y, score: value, threat: threat.danger, move };
  };

  let best: Heading = { angle: NaN, x: opts.x, y: opts.y, score: -Infinity, threat: 0, move: 0 };
  // Standing still is always an option (e.g. lined up and waiting to fire).
  if (!blocked(opts.x, opts.y)) best = score(opts.x, opts.y, 0, opts.bodyAngle);

  for (let i = 0; i < samples; i++) {
    const angle = (i / samples) * Math.PI * 2;
    const x = opts.x + Math.cos(angle) * stepDistance;
    const y = opts.y + Math.sin(angle) * stepDistance;
    if (blocked(x, y)) continue;
    const candidate = score(x, y, 1, angle);
    if (candidate.score > best.score) best = candidate;
  }

  return best;
}

function wrap(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function intersectsCircle(px: number, py: number, r: number, b: Box): boolean {
  const ix = px < b.x ? b.x : px > b.x + b.w ? b.x + b.w : px;
  const iy = py < b.y ? b.y : py > b.y + b.h ? b.y + b.h : py;
  return (px - ix) * (px - ix) + (py - iy) * (py - iy) < r * r;
}

/** Distance from a point to the closest wall surface (capped for sanity). */
export function nearestWallGap(px: number, py: number, walls: Box[]): number {
  let best = 140;
  for (const b of walls) {
    const ix = px < b.x ? b.x : px > b.x + b.w ? b.x + b.w : px;
    const iy = py < b.y ? b.y : py > b.y + b.h ? b.y + b.h : py;
    const inside = px > b.x && px < b.x + b.w && py > b.y && py < b.y + b.h;
    const d = inside
      ? 0
      : Math.hypot(px - ix, py - iy);
    if (d < best) best = d;
  }
  return best;
}

/**
 * Converts "I want to travel towards `angle`" into tank controls.
 * Reverses instead of pirouetting when the target is behind us.
 */
export function steerTo(angle: number, bodyAngle: number): { turn: number; drive: number } {
  const diff = wrap(angle - bodyAngle);
  const abs = Math.abs(diff);
  if (abs < 0.12) return { turn: 0, drive: 1 };
  if (abs > 2.1) {
    // Turn the rear towards the target and back into it.
    const rear = wrap(angle + Math.PI);
    const rd = wrap(rear - bodyAngle);
    return { turn: Math.sign(rd) * Math.min(1, Math.abs(rd) * 2.2), drive: -1 };
  }
  return { turn: Math.sign(diff) * Math.min(1, abs * 2.2), drive: 1 };
}
