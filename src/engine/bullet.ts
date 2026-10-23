import { segmentCircleT } from './ai';
import { reflect, sweepCircleBox, type Box } from './physics';

export interface BulletBody {
  x: number;
  y: number;
  vx: number;
  vy: number;
  bounces: number;
}

export interface CrateBox {
  box: Box;
  alive: boolean;
}

export interface BulletTarget {
  id: string;
  x: number;
  y: number;
  radius: number;
}

export type StepEvent =
  | { kind: 'wall'; x: number; y: number; nx: number; ny: number }
  | { kind: 'crate'; x: number; y: number; index: number }
  | { kind: 'tank'; x: number; y: number; id: string }
  /** The shell ran out of bounces and curled up. */
  | { kind: 'expired'; x: number; y: number };

export interface StepOptions {
  walls: Box[];
  crates?: CrateBox[];
  targets?: BulletTarget[];
  radius: number;
  maxBounces: number;
}

/**
 * Advances a shell by `dt` seconds. Movement is swept (never sampled), so even a
 * 2000px/s shell cannot tunnel through a thin wall. Every contact is reported in
 * order, which keeps the caller free of geometry code.
 */
export function advanceBullet(body: BulletBody, dt: number, opts: StepOptions): StepEvent[] {
  const events: StepEvent[] = [];
  const radius = opts.radius;
  const crates = opts.crates ?? [];
  const targets = opts.targets ?? [];

  // Crates that can be hit this step.
  const liveCrates = crates.map((c, index) => ({ c, index })).filter((entry) => entry.c.alive);

  let budget = dt;
  for (let iter = 0; iter < 5 && budget > 0; iter++) {
    const speed = Math.hypot(body.vx, body.vy);
    if (speed < 1e-4) break;
    const dx = body.vx * budget;
    const dy = body.vy * budget;
    const travel = Math.hypot(dx, dy);
    if (travel < 0.01) break;

    const wallHit = sweepCircleBox(body.x, body.y, radius, dx, dy, opts.walls);
    const wallDist = wallHit ? travel - wallHit.remaining : Infinity;

    const crateHit = liveCrates.length
      ? sweepCircleBox(
          body.x,
          body.y,
          radius,
          dx,
          dy,
          liveCrates.map((e) => e.c.box)
        )
      : null;
    let crateDist = Infinity;
    let crateIndex = -1;
    if (crateHit) {
      const found = liveCrates.find((e) => e.c.box === crateHit.box);
      if (found) {
        crateDist = travel - crateHit.remaining;
        crateIndex = found.index;
      }
    }

    let tankDist = Infinity;
    let tankId = '';
    for (const target of targets) {
      const t = segmentCircleT(body.x, body.y, body.x + dx, body.y + dy, target.x, target.y, target.radius + radius);
      if (t !== null && t * travel < tankDist) {
        tankDist = t * travel;
        tankId = target.id;
      }
    }

    if (tankDist < Infinity && tankDist <= wallDist && tankDist <= crateDist) {
      const x = body.x + (dx / travel) * tankDist;
      const y = body.y + (dy / travel) * tankDist;
      events.push({ kind: 'tank', x, y, id: tankId });
      body.x = x;
      body.y = y;
      return events;
    }

    if (crateDist < Infinity && crateDist <= wallDist) {
      const x = body.x + (dx / travel) * crateDist;
      const y = body.y + (dy / travel) * crateDist;
      events.push({ kind: 'crate', x, y, index: crateIndex });
      body.x = x;
      body.y = y;
      return events;
    }

    if (wallHit) {
      const x = body.x + (dx / travel) * wallDist;
      const y = body.y + (dy / travel) * wallDist;
      events.push({ kind: 'wall', x, y, nx: wallHit.nx, ny: wallHit.ny });

      body.x = x + wallHit.nx * 0.5;
      body.y = y + wallHit.ny * 0.5;
      const r = reflect(body.vx, body.vy, wallHit.nx, wallHit.ny);
      const damping = wallHit.box.bounce ?? 0.94;
      body.vx = r.x * damping;
      body.vy = r.y * damping;
      body.bounces++;

      if (body.bounces > opts.maxBounces) {
        events.push({ kind: 'expired', x: body.x, y: body.y });
        return events;
      }

      budget -= wallDist / speed;
      continue;
    }

    body.x += dx;
    body.y += dy;
    budget = 0;
  }

  return events;
}
