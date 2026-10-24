import Phaser from 'phaser';
import { COLORS, FONT } from './config';
import { Sketch } from './Sketch';

export type TankId = 'p1' | 'p2' | 'enemy';

const COLORS_BY_ID: Record<TankId, number> = {
  p1: COLORS.player,
  p2: COLORS.player2,
  enemy: COLORS.enemy,
};

const LABEL_BY_ID: Record<TankId, string> = {
  p1: 'P1',
  p2: 'P2',
  enemy: 'CPU',
};

const HULL: { x: number; y: number }[] = [
  { x: -18, y: -13 },
  { x: 13, y: -13 },
  { x: 22, y: -6 },
  { x: 22, y: 6 },
  { x: 13, y: 13 },
  { x: -18, y: 13 },
];

/**
 * A tank is a hand-drawn hull plus a turret. Both are drawn once and then
 * rotated; the turret is a separate layer so it can aim independently.
 */
export class Tank {
  readonly scene: Phaser.Scene;
  readonly id: TankId;
  readonly color: number;
  readonly radius = 22;

  x: number;
  y: number;
  bodyAngle: number;
  turretAngle: number;

  /** Hull velocity, px/s – used to lead shots and to dodge. */
  vx = 0;
  vy = 0;
  alive = true;
  invulnerableUntil = 0;
  /** How many hits this tank has taken (drawn as tally marks). */
  damage = 0;
  lives = 3;

  private hull: Sketch;
  private turret: Sketch;
  private tag: Phaser.GameObjects.Text;

  constructor(scene: Phaser.Scene, x: number, y: number, angle: number, id: TankId, depth = 20) {
    this.scene = scene;
    this.id = id;
    this.color = COLORS_BY_ID[id];
    this.x = x;
    this.y = y;
    this.bodyAngle = angle;
    this.turretAngle = angle;

    this.hull = new Sketch(scene, depth);
    this.turret = new Sketch(scene, depth + 1);
    this.tag = scene.add
      .text(x, y - 38, LABEL_BY_ID[id], {
        fontFamily: FONT,
        fontSize: '15px',
        color: `#${this.color.toString(16).padStart(6, '0')}`,
      })
      .setOrigin(0.5)
      .setDepth(depth + 2)
      .setAlpha(0.85);

    this.redraw();
    this.sync();
  }

  setDepth(depth: number): void {
    this.hull.setDepth(depth);
    this.turret.setDepth(depth + 1);
    this.tag.setDepth(depth + 2);
  }

  private applyVisual(now: number): void {
    if (!this.alive) {
      this.hull.setAlpha(0);
      this.turret.setAlpha(0);
      this.tag.setAlpha(0);
      return;
    }
    const invuln = this.invulnerableUntil > now;
    const blink = invuln ? (Math.floor(now / 90) % 2 === 0 ? 0.35 : 1) : 1;
    this.hull.setAlpha(blink);
    this.turret.setAlpha(blink);
    this.tag.setAlpha(0.85 * blink);
  }

  sync(now = this.scene.time.now): void {
    this.hull.graphics.setPosition(this.x, this.y).setRotation(this.bodyAngle);
    this.turret.graphics.setPosition(this.x, this.y).setRotation(this.turretAngle);
    this.tag.setPosition(this.x, this.y - 38);
    this.applyVisual(now);
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
    for (let i = 0; i < Math.min(3, this.damage); i++) {
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
    if (this.id === 'enemy') {
      t.graphics.fillStyle(this.color, 0.65);
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
    } else {
      t.graphics.fillStyle(this.color, 0.6);
      t.graphics.fillTriangle(-5, -17, 6, -14.5, -5, -12);
      t.poly(
        [
          { x: -5, y: -17 },
          { x: 6, y: -14.5 },
          { x: -5, y: -12 },
        ],
        { width: 2, jitter: 0.4 }
      );
    }
  }

  /** Muzzle position in world space. */
  muzzle(length = 44, angle = this.turretAngle): { x: number; y: number } {
    return { x: this.x + Math.cos(angle) * length, y: this.y + Math.sin(angle) * length };
  }

  setAlive(alive: boolean, now: number): void {
    this.alive = alive;
    this.applyVisual(now);
  }

  destroy(): void {
    this.hull.destroy();
    this.turret.destroy();
    this.tag.destroy();
  }
}
