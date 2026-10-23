import Phaser from 'phaser';
import { COLORS, FONT, jitterDeg } from './config';

/**
 * A tiny "hand drawn" drawing kit.
 *
 * Every shape is stroked 2–3 times along the *same* path, with small
 * low-frequency wobble baked into that path's points. Re-stroking one coherent
 * path (instead of regenerating it per pass) reads as ink laid down twice
 * rather than as random noise.
 */

type Pt = { x: number; y: number };

const BOIL_FRAME_MS = 125;
const BOIL_PHASES = 4;

export class Sketch {
  private scene: Phaser.Scene;
  private g: Phaser.GameObjects.Graphics;
  /** Phase index for the subtle 8fps line wobble. */
  private boil = 0;
  private boilTimer: Phaser.Time.TimerEvent;

  constructor(scene: Phaser.Scene, depth = 0) {
    this.scene = scene;
    this.g = scene.add.graphics().setDepth(depth);
    this.boilTimer = scene.time.addEvent({
      delay: BOIL_FRAME_MS,
      loop: true,
      callback: () => (this.boil = (this.boil + 1) % BOIL_PHASES),
    });
  }

  /** Drops the wobble timer and the graphics object. */
  destroy(): void {
    this.boilTimer.remove(false);
    this.g.destroy();
  }

  get graphics(): Phaser.GameObjects.Graphics {
    return this.g;
  }

  clear(): this {
    this.g.clear();
    return this;
  }

  setDepth(depth: number): this {
    this.g.setDepth(depth);
    return this;
  }

  setAlpha(alpha: number): this {
    this.g.setAlpha(alpha);
    return this;
  }

  /** Cheap smooth pseudo-noise used to displace path points. */
  private wobble(x: number, y: number, seed: number): Pt {
    const k = this.boil * 0.9 + seed;
    return {
      x:
        Math.sin(x * 0.021 + k * 1.7) * 0.55 +
        Math.sin(y * 0.017 + k * 3.1 + 1.3) * 0.55 +
        Math.sin((x + y) * 0.009 + k * 0.7) * 0.4,
      y:
        Math.cos(x * 0.019 - k * 2.3) * 0.6 +
        Math.sin(y * 0.023 + k * 1.1 + 2.1) * 0.5 +
        Math.sin((x - y) * 0.011 + k * 1.9) * 0.4,
    };
  }

  /**
   * Strokes a path several times. `jitter` is in pixels.
   * Passes alternate direction and overshoot slightly, like a pencil that
   * doesn't quite retrace itself.
   */
  private strokes(points: Pt[], color: number, width: number, passes: number, jitter: number): void {
    if (points.length < 2) return;
    const boost = this.boil * 0.77;

    for (let p = 0; p < passes; p++) {
      const seed = p * 2.31 + boost;
      // Lower alpha on later passes lets the double stroke show through.
      this.g.lineStyle(width * (p === 0 ? 1 : 0.8), color, p === 0 ? 1 : 0.45);
      this.g.beginPath();

      const rev = p % 2 === 1;
      const n = points.length;
      const over = p === 0 ? 0 : 1;

      for (let i = -over; i < n + over; i++) {
        const idx = Phaser.Math.Clamp(rev ? n - 1 - i : i, 0, n - 1);
        const src = points[idx];
        const w = this.wobble(src.x, src.y, seed);
        const px = src.x + w.x * jitter;
        const py = src.y + w.y * jitter;
        if (i === -over) this.g.moveTo(px, py);
        else this.g.lineTo(px, py);
      }
      this.g.strokePath();
    }
  }

  // ---------------------------------------------------------------- primitives

  line(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    opts: { color?: number; width?: number; jitter?: number } = {}
  ): this {
    this.strokes(
      [
        { x: x1, y: y1 },
        { x: x2, y: y2 },
      ],
      opts.color ?? COLORS.ink,
      opts.width ?? 2.5,
      2,
      opts.jitter ?? 1.1
    );
    return this;
  }

  poly(points: Pt[], opts: { color?: number; width?: number; jitter?: number; closed?: boolean } = {}): this {
    const pts = opts.closed === false ? points.slice() : [...points, points[0]];
    this.strokes(pts, opts.color ?? COLORS.ink, opts.width ?? 2.5, 2, opts.jitter ?? 1.1);
    return this;
  }

  rect(
    x: number,
    y: number,
    w: number,
    h: number,
    opts: { color?: number; width?: number; jitter?: number } = {}
  ): this {
    return this.poly(
      [
        { x, y },
        { x: x + w, y },
        { x: x + w, y: y + h },
        { x, y: y + h },
      ],
      opts
    );
  }

  circle(
    cx: number,
    cy: number,
    r: number,
    opts: { color?: number; width?: number; jitter?: number; passes?: number } = {}
  ): this {
    if (r < 0.6) return this;
    const samples = Math.max(10, Math.round(r * 1.1));
    this.strokes(circlePoints(cx, cy, r, samples), opts.color ?? COLORS.ink, opts.width ?? 2.5, opts.passes ?? 2, opts.jitter ?? 1.2);
    return this;
  }

  arc(
    cx: number,
    cy: number,
    r: number,
    from: number,
    to: number,
    opts: { color?: number; width?: number; jitter?: number } = {}
  ): this {
    const steps = Math.max(6, Math.round((Math.abs(to - from) / (Math.PI * 2)) * 40));
    const pts: Pt[] = [];
    for (let i = 0; i <= steps; i++) {
      const a = from + ((to - from) * i) / steps;
      pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
    }
    this.strokes(pts, opts.color ?? COLORS.ink, opts.width ?? 2.5, 2, opts.jitter ?? 1.1);
    return this;
  }

  fillCircle(cx: number, cy: number, r: number, color: number, alpha = 1): this {
    this.g.fillStyle(color, alpha);
    this.g.fillCircle(cx, cy, r);
    return this;
  }

  fillRect(x: number, y: number, w: number, h: number, color: number, alpha = 1): this {
    this.g.fillStyle(color, alpha);
    this.g.fillRect(x, y, w, h);
    return this;
  }

  /** Diagonal cross-hatch, exactly clipped to the rectangle. */
  hatch(x: number, y: number, w: number, h: number, spacing = 13, color: number = COLORS.wallHatch, width = 1.2): this {
    this.g.lineStyle(width, color, 0.6);
    const max = w + h;
    for (let d = -h; d < max; d += spacing) {
      // Line through (x + d, y + h) heading up-right: (x + d + s, y + h - s)
      const lo = Math.max(0, -d);
      const hi = Math.min(h, w - d);
      if (hi - lo < 4) continue;
      this.g.beginPath();
      this.g.moveTo(x + d + lo, y + h - lo);
      this.g.lineTo(x + d + hi, y + h - hi);
      this.g.strokePath();
    }
    return this;
  }

  /** Scattered short dashes, like rough pencil shading. */
  scribble(cx: number, cy: number, r: number, count: number, color: number = COLORS.ink, seed = 1): this {
    this.g.lineStyle(1.2, color, 0.32);
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + seed;
      const rr = r * (0.5 + ((i * 37) % 100) / 200);
      const px = cx + Math.cos(a) * rr;
      const py = cy + Math.sin(a) * rr;
      const l = 2 + ((i * 53) % 5);
      this.g.beginPath();
      this.g.moveTo(px, py);
      this.g.lineTo(px + Math.cos(a + 0.7) * l, py + Math.sin(a + 0.7) * l);
      this.g.strokePath();
    }
    return this;
  }

  /** Hand lettering: the font does the work, a degree of tilt sells it. */
  text(
    x: number,
    y: number,
    value: string,
    size: number,
    color: number = COLORS.ink,
    align: 'left' | 'center' | 'right' = 'center'
  ): Phaser.GameObjects.Text {
    const t = this.scene.add.text(x, y, value, {
      fontFamily: FONT,
      fontSize: `${size}px`,
      color: `#${color.toString(16).padStart(6, '0')}`,
    });
    t.setOrigin(align === 'center' ? 0.5 : align === 'right' ? 1 : 0, 0.5);
    t.setAngle(jitterDeg(0.7));
    // Text lives on the display list, so it needs an explicit depth above the
    // layer this sketch draws into.
    t.setDepth(this.g.depth + 1);
    return t;
  }
}

export function circlePoints(cx: number, cy: number, r: number, samples = 24): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i < samples; i++) {
    const a = (i / samples) * Math.PI * 2;
    pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
  }
  return pts;
}
