import Phaser from 'phaser';
import { COLORS, FONT } from './config';
import { MAX_HP } from './rules';
import { Sketch } from './Sketch';

export type TankId = 'p1' | 'p2' | 'enemy';

/** The gun is mounted on the hull: it can only swing this far off the nose. */
export const TURRET_LIMIT = Phaser.Math.DegToRad(72);

const COLORS_BY_ID: Record<TankId, number> = {
  p1: COLORS.player,
  p2: COLORS.player2,
  enemy: COLORS.enemy,
};

/** Team colours used by LAN team mode / FFA fallback. */
export const TEAM_COLORS = [COLORS.player, COLORS.player2, 0xd4a72e, COLORS.enemy];

export function teamColor(team: number): number {
  return TEAM_COLORS[(((team ?? 0) % TEAM_COLORS.length) + TEAM_COLORS.length) % TEAM_COLORS.length];
}

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
  /** Settable so LAN players can be recoloured by team. */
  color: number;
  readonly radius = 22;

  x: number;
  y: number;
  bodyAngle: number;
  /** World angle of the barrel – always bodyAngle + turretOffset. */
  turretAngle: number;
  /** How far the barrel is swung off the nose, clamped to ±TURRET_LIMIT. */
  turretOffset = 0;

  /** Hull velocity, px/s – used to lead shots and to dodge. */
  vx = 0;
  vy = 0;
  alive = true;
  invulnerableUntil = 0;
  /** How many hits this tank has taken (drawn as tally marks). */
  damage = 0;
  /** v1.3: every mode is health-based. `lives` is gone. */
  hp = MAX_HP;
  maxHp = MAX_HP;
  /** Kills / deaths, shown on the public score bar. */
  kills = 0;
  deaths = 0;
  /** Team index (0 = none in FFA). Drives the colour of the name tag. */
  team = 0;
  /** False while waiting to respawn. */
  awaitingRespawn = false;

  // ---- temporary states, all absolute timestamps (ms on the scene clock)
  /** Pickup shield: blocks damage. */
  shieldUntil = 0;
  /** Pickup: faster hull. */
  speedUntil = 0;
  /** Skill "rage": faster hull + double damage shells. */
  rageUntil = 0;
  /** Skill "rage": how many shells still carry double damage. */
  rageShots = 0;
  /** Skill "weaken" applied by the opponent: slower hull. */
  slowUntil = 0;
  /** When the summoner skill becomes available again (scene clock, ms). */
  skillReadyAt = 0;

  private hull: Sketch;
  private turret: Sketch;
  private overlay: Sketch;
  private bar: Sketch;
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
    // Firing arc + rear marker sit under the hull so they never hide the enemy.
    this.overlay = new Sketch(scene, depth - 1);
    // Health bar floats above the tank.
    this.bar = new Sketch(scene, depth + 3);
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
    this.overlay.setDepth(depth - 1);
    this.hull.setDepth(depth);
    this.turret.setDepth(depth + 1);
    this.tag.setDepth(depth + 2);
    this.bar.setDepth(depth + 3);
  }

  private applyVisual(now: number): void {
    if (!this.alive) {
      this.hull.setAlpha(0);
      this.turret.setAlpha(0);
      this.overlay.setAlpha(0);
      this.tag.setAlpha(0);
      this.bar.setAlpha(0);
      return;
    }
    const invuln = this.invulnerableUntil > now;
    const blink = invuln ? (Math.floor(now / 90) % 2 === 0 ? 0.35 : 1) : 1;
    this.hull.setAlpha(blink);
    this.turret.setAlpha(blink);
    this.overlay.setAlpha(blink);
    this.tag.setAlpha(0.85 * blink);
    this.bar.setAlpha(1);
  }

  /** Fraction of health left, clamped to 0..1. */
  hpRatio(): number {
    return Math.max(0, Math.min(1, this.hp / Math.max(1, this.maxHp)));
  }

  setHp(hp: number): void {
    this.hp = Math.max(0, Math.min(this.maxHp, hp));
  }

  /**
   * Redraws the bits that change every frame: the firing arc, the rear marker
   * and the public health bar.
   */
  drawOverlay(): void {
    const o = this.overlay;
    o.clear();
    o.graphics.setPosition(this.x, this.y).setRotation(this.bodyAngle);

    // ---- firing arc (the "攻角范围" the player asked to see)
    const r = 40;
    o.graphics.lineStyle(1.6, COLORS.ink, 0.28);
    o.graphics.beginPath();
    o.graphics.arc(0, 0, r, -TURRET_LIMIT, TURRET_LIMIT, false);
    o.graphics.strokePath();
    // End stops, so the limits are unmistakable.
    for (const end of [-TURRET_LIMIT, TURRET_LIMIT]) {
      o.graphics.lineStyle(1.8, COLORS.ink, 0.42);
      o.graphics.beginPath();
      o.graphics.moveTo(Math.cos(end) * (r - 5), Math.sin(end) * (r - 5));
      o.graphics.lineTo(Math.cos(end) * (r + 5), Math.sin(end) * (r + 5));
      o.graphics.strokePath();
    }
    // The barrel's actual line, so the arc reads as "this is where I can shoot".
    o.graphics.lineStyle(1.2, this.color, 0.5);
    o.graphics.beginPath();
    o.graphics.moveTo(0, 0);
    const aim = this.turretAngle - this.bodyAngle;
    o.graphics.lineTo(Math.cos(aim) * r, Math.sin(aim) * r);
    o.graphics.strokePath();

    // ---- rear marker: a red dot on the tail, so front vs back is obvious
    const back = -this.radius - 6;
    o.graphics.fillStyle(COLORS.danger, 0.85);
    o.graphics.fillCircle(back, 0, 4.2);
    o.graphics.lineStyle(1.4, COLORS.ink, 0.5);
    o.graphics.beginPath();
    o.graphics.arc(0, 0, this.radius + 6, Math.PI - 0.45, Math.PI + 0.45, false);
    o.graphics.strokePath();

    // ---- health bar under the tank, always public
    const b = this.bar;
    b.clear();
    const w = 62;
    const h = 9;
    const x = this.x - w / 2;
    const y = this.y + this.radius + 10;
    b.graphics.fillStyle(COLORS.white, 0.9);
    b.graphics.fillRoundedRect(x, y, w, h, 3);
    const ratio = this.hpRatio();
    const fill = ratio > 0.6 ? this.color : ratio > 0.3 ? 0xd4a72e : COLORS.danger;
    if (ratio > 0) {
      b.graphics.fillStyle(fill, 0.95);
      b.graphics.fillRoundedRect(x + 1, y + 1, Math.max(0, (w - 2) * ratio), h - 2, 2);
    }
    b.graphics.lineStyle(1.4, COLORS.ink, 0.55);
    b.graphics.strokeRoundedRect(x, y, w, h, 3);
    // Ten notches: easy to read ~10 HP per shot at a glance.
    b.graphics.lineStyle(0.9, COLORS.ink, 0.25);
    for (let i = 1; i < 10; i += 1) {
      const nx = x + (w / 10) * i;
      b.graphics.beginPath();
      b.graphics.moveTo(nx, y + 1);
      b.graphics.lineTo(nx, y + h - 1);
      b.graphics.strokePath();
    }
  }

  /** Speed multiplier from all active effects. */
  speedMultiplier(now = this.scene.time.now): number {
    let mul = 1;
    if (now < this.speedUntil) mul *= 1.4;
    if (now < this.rageUntil) mul *= 1.3;
    if (now < this.slowUntil) mul *= 0.6;
    return mul;
  }

  shielded(now = this.scene.time.now): boolean {
    return now < this.shieldUntil || now < this.invulnerableUntil;
  }

  /**
   * Rotating the hull carries the gun with it – the turret is mounted on the
   * hull, not floating above it.
   */
  turnHull(delta: number): void {
    this.bodyAngle += delta;
    this.turretAngle = this.bodyAngle + this.turretOffset;
  }

  /** Aims at a world angle; the offset is clamped to the mount's arc. */
  aimAt(worldAngle: number, rate?: number, dt?: number): void {
    const wanted = Phaser.Math.Clamp(
      Phaser.Math.Angle.Wrap(worldAngle - this.bodyAngle),
      -TURRET_LIMIT,
      TURRET_LIMIT
    );
    if (rate !== undefined && dt !== undefined) {
      const diff = wanted - this.turretOffset;
      const step = rate * dt;
      this.turretOffset = Math.abs(diff) <= step ? wanted : this.turretOffset + Math.sign(diff) * step;
    } else {
      this.turretOffset = wanted;
    }
    this.turretAngle = this.bodyAngle + this.turretOffset;
  }

  /** Keeps the barrel where it is in hull space after a snapshot/teleport. */
  syncTurret(): void {
    this.turretOffset = Phaser.Math.Clamp(
      Phaser.Math.Angle.Wrap(this.turretAngle - this.bodyAngle),
      -TURRET_LIMIT,
      TURRET_LIMIT
    );
    this.turretAngle = this.bodyAngle + this.turretOffset;
  }

  sync(now = this.scene.time.now): void {
    this.hull.graphics.setPosition(this.x, this.y).setRotation(this.bodyAngle);
    this.turret.graphics.setPosition(this.x, this.y).setRotation(this.turretAngle);
    this.tag.setPosition(this.x, this.y - 42);
    this.drawOverlay();
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

  /** Wipes every temporary state (used on respawn / new match). */
  clearEffects(): void {
    this.shieldUntil = 0;
    this.speedUntil = 0;
    this.rageUntil = 0;
    this.rageShots = 0;
    this.slowUntil = 0;
  }

  /** Remaining cooldown, 0..1 (1 = fully charged). */
  skillCharge(now: number, cooldown: number): number {
    if (cooldown <= 0) return 1;
    return Math.min(1, Math.max(0, 1 - (this.skillReadyAt - now) / (cooldown * 1000)));
  }

  setAlive(alive: boolean, now: number): void {
    this.alive = alive;
    this.applyVisual(now);
  }

  destroy(): void {
    this.hull.destroy();
    this.turret.destroy();
    this.overlay.destroy();
    this.bar.destroy();
    this.tag.destroy();
  }
}
