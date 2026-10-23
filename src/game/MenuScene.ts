import Phaser from 'phaser';
import { sweepCircleBox, reflect } from '../engine/physics';
import { COLORS, GAME_H, GAME_W } from './config';
import { Sketch } from './Sketch';
import { Tank } from './Tank';
import { makeTextures, paperBackground } from './art';

interface Drifter {
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: number;
  trail: { x: number; y: number }[];
}

/**
 * Title backdrop: a few shells endlessly bank around an empty arena while a
 * tank idles. Deliberately calm so the DOM card on top can be read.
 */
export class MenuScene extends Phaser.Scene {
  private bullets: Drifter[] = [];
  private fx!: Phaser.GameObjects.Graphics;
  private walls: { x: number; y: number; w: number; h: number }[] = [];
  private layer!: Sketch;

  constructor() {
    super('Menu');
  }

  create(): void {
    makeTextures(this);
    paperBackground(this);

    this.layer = new Sketch(this, 5);
    this.fx = this.add.graphics().setDepth(10);

    const t = 26;
    this.walls = [
      { x: 40, y: 40, w: GAME_W - 80, h: t },
      { x: 40, y: GAME_H - 40 - t, w: GAME_W - 80, h: t },
      { x: 40, y: 40, w: t, h: GAME_H - 80 },
      { x: GAME_W - 40 - t, y: 40, w: t, h: GAME_H - 80 },
      { x: 300, y: 250, w: 30, h: 220 },
      { x: 950, y: 250, w: 30, h: 220 },
      { x: 560, y: 170, w: 160, h: 26 },
      { x: 560, y: 524, w: 160, h: 26 },
    ];

    for (const w of this.walls) this.layer.fillRect(w.x, w.y, w.w, w.h, COLORS.wallFill, 0.75);
    for (const w of this.walls) this.layer.hatch(w.x, w.y, w.w, w.h, 14);
    for (const w of this.walls) this.layer.rect(w.x, w.y, w.w, w.h, { width: 2.2, jitter: 1.2 });

    // Decorative doodles in the corners.
    this.layer.circle(150, GAME_H - 130, 54, { width: 1.6, jitter: 2.4, color: COLORS.ink });
    this.layer.circle(1130, GAME_H - 130, 34, { width: 1.6, jitter: 2.4, color: COLORS.ink });
    this.layer.line(80, GAME_H - 80, 230, GAME_H - 80, { width: 1.4, jitter: 2.2 });
    this.layer.line(80, GAME_H - 66, 180, GAME_H - 66, { width: 1.4, jitter: 2.2 });

    const a = new Tank(this, 205, GAME_H - 205, -0.6, 'player', 8);
    const b = new Tank(this, GAME_W - 215, 210, Math.PI + 0.5, 'enemy', 8);
    a.turretAngle = -1.2;
    b.turretAngle = Math.PI * 0.8;
    a.sync();
    b.sync();

    const colors = [COLORS.player, COLORS.enemy, COLORS.crate];
    for (let i = 0; i < 3; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 210 + Math.random() * 120;
      this.bullets.push({
        x: 200 + Math.random() * (GAME_W - 400),
        y: 200 + Math.random() * (GAME_H - 400),
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        color: colors[i],
        trail: [],
      });
    }
  }

  update(_time: number, delta: number): void {
    const dt = Math.min(delta, 50) / 1000;
    const g = this.fx;
    g.clear();

    for (const b of this.bullets) {
      b.trail.push({ x: b.x, y: b.y });
      if (b.trail.length > 10) b.trail.shift();

      let budget = dt;
      for (let i = 0; i < 4 && budget > 0; i++) {
        const dx = b.vx * budget;
        const dy = b.vy * budget;
        const travel = Math.hypot(dx, dy);
        const hit = sweepCircleBox(b.x, b.y, 5, dx, dy, this.walls);
        const dist = hit ? travel - hit.remaining : travel;

        if (hit) {
          b.x += (dx / travel) * dist;
          b.y += (dy / travel) * dist;
          const r = reflect(b.vx, b.vy, hit.nx, hit.ny);
          b.vx = r.x;
          b.vy = r.y;
          b.trail = [];
          budget -= dist / Math.max(1, Math.hypot(b.vx, b.vy));
        } else {
          b.x += dx;
          b.y += dy;
          budget = 0;
        }
      }

      for (let i = 0; i < b.trail.length; i++) {
        const t = b.trail[i];
        g.fillStyle(b.color, (i / b.trail.length) * 0.3);
        g.fillCircle(t.x, t.y, 2 + (i / b.trail.length) * 3);
      }
      g.fillStyle(COLORS.ink, 0.8);
      g.fillCircle(b.x, b.y, 6);
      g.fillStyle(b.color, 1);
      g.fillCircle(b.x, b.y, 4.5);
    }
  }
}
