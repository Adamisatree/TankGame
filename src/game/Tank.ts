import Phaser from 'phaser';
import { COLORS } from './config';
import { Sketch } from './Sketch';

export type TankKind = 'player' | 'enemy';

const HULL: { x: number; y: number }[] = [
  { x: -18, y: -13 },
  { x: 13, y: -13 },
  { x: 22, y: -6 },
  { x: 22, y: 6 },
  { x: 13, y: 13 },
  { x: -18, y: 13 },
];

/**
 * A tank is two hand-drawn layers (hull + turret) that are drawn once and then
 * rotated. The hull follows the driving direction, the turret follows the aim.
 */
export class Tank {
  readonly scene: Phaser.Scene;
  readonly kind: TankKind;
  readonly color: number;
  readonly radius: number;

  x: number;
  y: number;
  bodyAngle: number;
  turretAngle: number;

  /** Hull speed, px/s. Kept for the enemy lead calculation. */
  vx = 0;
  vy = 0;
  alive = true;
  invulnerableUntil = 0;
  damage = 0;

  private hull: Sketch;
  private turret: Sketch;

  constructor(scene: Phaser.Scene, x: number, y: number, angle: number, kind: TankKind, depth = 20) {
    this.scene = scene;
    this.kind = kind;
    this.color = kind === 'player' ? COLORS.player : COLORS.enemy;
    this.radius = 22;
    this.x = x;
    this.y = y;
    this.bodyAngle = angle;
    this.turretAngle = angle;

    this.hull = new Sketch(scene, depth);
    this.turret = new Sketch(scene, depth + 1);
    this.redraw();
    this.sync();
  }

  setDepth(depth: number): void {
    this.hull.setDepth(depth);
    this.turret.setDepth(depth + 1);
  }

  /** Hidden while destroyed; blinks while respawning and invulnerable. */
  private applyInvulnVisual(now: number): void {
    if (!this.alive) {
      this.hull.setAlpha(0);
      this.turret.setAlpha(0);
      return;
    }
    const invuln = this.invulnerableUntil > now;
    const blink = invuln ? (Math.floor(now / 90) % 2 === 0 ? 0.35 : 1) : 1;
    this.hull.setAlpha(blink);
    this.turret.setAlpha(blink);
  }

  sync(now = this.scene.time.now): void {
    this.hull.graphics.setPosition(this.x, this.y).setRotation(this.bodyAngle);
    this.turret.graphics.setPosition(this.x, this.y).setRotation(this.turretAngle);
    this.applyInvulnVisual(now);
  }

  redraw(): void {
    const g = this.hull;
    g.clear();
    const tint = this.color;

    // Soft shadow, offset in the hull's local frame.
    g.graphics.fillStyle(COLORS.shadow, 0.08);
    g.graphics.fillEllipse(5, 7, 62, 42);

    // Treads – the loudest shape on the tank, so it reads at a glance.
    for (const [ty, th] of [
      [-20, 10],
      [10, 10],
    ] as const) {
      g.fillRect(-24, ty, 48, th, COLORS.ink, 0.14);
      g.rect(-24, ty, 48, th, { width: 3, jitter: 0.6 });
      for (let i = 0; i < 6; i++) {
        const tx = -21 + i * 8;
        g.line(tx, ty + 1.5, tx, ty + th - 1.5, { width: 1.5, jitter: 0.4 });
      }
    }

    // Hull.
    g.graphics.fillStyle(tint, 0.26);
    g.graphics.beginPath();
    g.graphics.moveTo(HULL[0].x, HULL[0].y);
    for (let i = 1; i < HULL.length; i++) g.graphics.lineTo(HULL[i].x, HULL[i].y);
    g.graphics.closePath();
    g.graphics.fillPath();
    g.poly(HULL, { width: 3.2, jitter: 0.8 });

    // Hatch + a couple of rivets.
    g.circle(-2, 0, 8, { width: 2.6, jitter: 0.6 });
    g.line(-6, 4, -2, 0, { width: 1.6, jitter: 0.4 });
    for (const rx of [-14, 11]) g.circle(rx, 0, 1.7, { width: 1.6, jitter: 0.3, passes: 1 });

    // Damage tally: one red cross per hit taken.
    for (let i = 0; i < this.damage; i++) {
      const dx = -15 + i * 9;
      g.line(dx - 3, -4, dx + 3, 4, { color: COLORS.danger, width: 2.4, jitter: 0.5 });
      g.line(dx + 3, -4, dx - 3, 4, { color: COLORS.danger, width: 2.4, jitter: 0.5 });
    }

    // ---------- turret
    const t = this.turret;
    t.clear();
    // Barrel
    t.fillRect(8, -5, 30, 10, COLORS.ink, 0.09);
    t.poly(
      [
        { x: 8, y: -5 },
        { x: 36, y: -5 },
        { x: 39, y: -3.4 },
        { x: 39, y: 3.4 },
        { x: 36, y: 5 },
        { x: 8, y: 5 },
      ],
      { width: 2.8, jitter: 0.5 }
    );
    t.line(33, -5, 33, 5, { width: 2, jitter: 0.4 });
    t.line(37.5, -4.6, 37.5, 4.6, { width: 2, jitter: 0.4 });
    // Dome
    t.graphics.fillStyle(tint, 0.34);
    t.graphics.fillCircle(0, 0, 12);
    t.circle(0, 0, 12, { width: 3.2, jitter: 0.7 });
    t.circle(0, 0, 4.5, { width: 2, jitter: 0.5, passes: 1 });
    // A little pennant so friend/foe reads at a glance even in mono.
    t.line(-3, -10, -5, -17, { width: 2.4, jitter: 0.4 });
    if (this.kind === 'player') {
      t.graphics.fillStyle(COLORS.player, 0.6);
      t.graphics.fillTriangle(-5, -17, 6, -14.5, -5, -12);
      t.poly(
        [
          { x: -5, y: -17 },
          { x: 6, y: -14.5 },
          { x: -5, y: -12 },
        ],
        { width: 2, jitter: 0.4 }
      );
    } else {
      t.graphics.fillStyle(COLORS.enemy, 0.65);
      t.graphics.fillTriangle(-5, -12, 5, -12, 0, -18.5);
      t.poly(
        [
          { x: -5, y: -12 },
          { x: 5, y: -12 },
          { x: 3, y: -17.5 },
          { x: -3, y: -17.5 },
        ],
        { width: 2, jitter: 0.4 }
      );
    }
  }

  /** Muzzle position in world space. */
  muzzle(length = 42, angle = this.turretAngle): { x: number; y: number } {
    return { x: this.x + Math.cos(angle) * length, y: this.y + Math.sin(angle) * length };
  }

  destroy(): void {
    this.hull.destroy();
    this.turret.destroy();
  }
}
