import Phaser from 'phaser';
import { planRicochetShot, type ShotPlan } from '../engine/ai';
import { advanceBullet, type BulletTarget } from '../engine/bullet';
import { LEVELS, buildLayout, type Layout, type PlayRect } from '../engine/level';
import { circleBox, reflect, sweepCircleBox, type Box } from '../engine/physics';
import { bulletThreatAt, pickHeading, steerTo, type ThreatBullet } from '../engine/steer';
import { BULLET, COLORS, GAME_H, GAME_W, HIT_MERCY, TANK } from './config';
import { OVERLAY_EVENT, type OverlayState } from './events';
import { Sketch } from './Sketch';
import { Tank, type TankId } from './Tank';
import { makeTextures, paperBackground } from './art';
import { sound } from './Sound';
import { preset, settings, VERSUS_LIVES, type DifficultyPreset } from './settings';

/** Drawing area, leaving room for the sketch HUD at the top and hints below. */
const PLAY_RECT: PlayRect = { x: 34, y: 82, w: GAME_W - 68, h: GAME_H - 82 - 46 };

type Phase = 'ready' | 'playing' | 'dying' | 'cleared' | 'over' | 'victory' | 'versusOver';

interface Bullet {
  x: number;
  y: number;
  vx: number;
  vy: number;
  owner: TankId;
  color: number;
  bounces: number;
  maxBounces: number;
  life: number;
  dead: boolean;
  trail: { x: number; y: number }[];
}

interface Crate {
  box: Box;
  alive: boolean;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  color: number;
  kind: 'spark' | 'puff' | 'ring' | 'debris';
  angle: number;
}

interface DriveKeys {
  up: Phaser.Input.Keyboard.Key;
  down: Phaser.Input.Keyboard.Key;
  left: Phaser.Input.Keyboard.Key;
  right: Phaser.Input.Keyboard.Key;
}

interface AiDecision {
  angle: number | null;
  /** 0 = stand still. */
  drive: number;
  speed: number;
  dodging: boolean;
}

const COLORS_BY_ID: Record<TankId, number> = {
  p1: COLORS.player,
  p2: COLORS.player2,
  enemy: COLORS.enemy,
};

export class GameScene extends Phaser.Scene {
  private levelIndex = 0;
  private layout!: Layout;
  private phase: Phase = 'ready';
  private paused = false;

  private wallsLayer!: Sketch;
  private cratesLayer!: Sketch;
  private fx!: Phaser.GameObjects.Graphics;
  private hud!: Sketch;
  private levelText!: Phaser.GameObjects.Text;
  private scoreText!: Phaser.GameObjects.Text;
  private hintText!: Phaser.GameObjects.Text;
  private bannerText!: Phaser.GameObjects.Text;
  private modeText!: Phaser.GameObjects.Text;

  private p1!: Tank;
  private p2?: Tank;
  private enemy?: Tank;
  private crates: Crate[] = [];
  private bullets: Bullet[] = [];
  private particles: Particle[] = [];

  private score = 0;
  private phaseTimer = 0;
  private readyTimer = 0;
  private hudDirty = true;
  private lastBounceSound = 0;
  private autoDodge = false;

  // Solo AI state.
  private aiThinkTimer = 0;
  private aiDecision: AiDecision = { angle: null, drive: 0, speed: 0, dodging: false };
  private aiReload = 0;
  private aiCharge = 0;
  private aiAimDir = 0;
  private aiGraceUntil = 0;
  private aiRoam = { x: 0, y: 0 };
  private aiRoamTimer = 0;

  // Input.
  private wasd!: DriveKeys;
  private arrows!: Phaser.Types.Input.Keyboard.CursorKeys;
  private fire1!: Phaser.Input.Keyboard.Key;
  private fire2!: Phaser.Input.Keyboard.Key;
  private trimLeft1!: Phaser.Input.Keyboard.Key;
  private trimRight1!: Phaser.Input.Keyboard.Key;
  private trimLeft2!: Phaser.Input.Keyboard.Key;
  private trimRight2!: Phaser.Input.Keyboard.Key;
  private shiftKey!: Phaser.Input.Keyboard.Key;
  private pauseKey!: Phaser.Input.Keyboard.Key;
  private escKey!: Phaser.Input.Keyboard.Key;
  private muteKey!: Phaser.Input.Keyboard.Key;
  private autoKey!: Phaser.Input.Keyboard.Key;

  private fireCd1 = 0;
  private fireCd2 = 0;

  constructor() {
    super('Game');
  }

  private get versus(): boolean {
    return settings.mode === 'versus';
  }

  // ------------------------------------------------------------------ setup

  create(): void {
    makeTextures(this);
    paperBackground(this);

    this.wallsLayer = new Sketch(this, 5);
    this.cratesLayer = new Sketch(this, 6);
    this.fx = this.add.graphics().setDepth(30);
    this.hud = new Sketch(this, 40);

    const kb = this.input.keyboard!;
    this.wasd = kb.addKeys({ up: 'W', down: 'S', left: 'A', right: 'D' }) as DriveKeys;
    this.arrows = kb.createCursorKeys();
    this.fire1 = kb.addKey('SPACE');
    this.fire2 = kb.addKey('ENTER');
    this.trimLeft1 = kb.addKey('Q');
    this.trimRight1 = kb.addKey('E');
    this.trimLeft2 = kb.addKey('COMMA');
    this.trimRight2 = kb.addKey('PERIOD');
    this.shiftKey = kb.addKey('SHIFT');
    this.pauseKey = kb.addKey('P');
    this.escKey = kb.addKey('ESC');
    this.muteKey = kb.addKey('M');
    this.autoKey = kb.addKey('G');

    this.levelText = this.hud.text(GAME_W / 2, 40, '', 24, COLORS.ink);
    this.scoreText = this.hud.text(GAME_W - 48, 40, '', 22, COLORS.ink, 'right');
    this.modeText = this.hud.text(PLAY_RECT.x + 8, 40, '', 18, COLORS.ink, 'left');
    this.modeText.setAlpha(0.55);
    this.hintText = this.hud.text(GAME_W / 2, GAME_H - 24, '', 16, COLORS.ink);
    this.hintText.setAlpha(0.55);
    this.bannerText = this.hud.text(GAME_W / 2, GAME_H / 2, '', 64, COLORS.ink);
    this.bannerText.setAlpha(0);
    this.input.mouse?.disableContextMenu();

    this.score = 0;
    this.paused = false;
    this.autoDodge = settings.autoDodge;
    this.levelIndex = 0;
    this.loadLevel(0);
    this.emitOverlay({ kind: 'hidden' });
  }

  private emitOverlay(state: OverlayState, error: Error | null = null): void {
    void error;
    this.game.events.emit(OVERLAY_EVENT, state);
  }

  private tanks(): Tank[] {
    return [this.p1, this.p2, this.enemy].filter((t): t is Tank => !!t);
  }

  private humans(): Tank[] {
    return [this.p1, this.p2].filter((t): t is Tank => !!t);
  }

  private refreshHeaderText(): void {
    this.hintText.setText(
      this.versus
        ? 'P1: WASD 驾驶 · Q/E 微调炮口 · 空格 开火      P2: 方向键 驾驶 · ,/. 微调炮口 · Enter 开火      P 暂停'
        : 'WASD / 方向键 驾驶 · 鼠标瞄准 · 左键 / 空格 开火 · Shift 慢速 · G 自动躲弹 · P 暂停'
    );
    this.modeText.setText(
      this.versus ? '双人对战' : `单人 · ${preset().label}${this.autoDodge ? ' · 自动躲弹' : ''}`
    );
  }

  private loadLevel(index: number): void {
    this.levelIndex = index;
    this.refreshHeaderText();
    const level = LEVELS[index];
    this.layout = buildLayout(level, PLAY_RECT);

    for (const tank of this.tanks()) tank.destroy();
    this.p2 = undefined;
    this.enemy = undefined;

    const d = preset();

    this.p1 = new Tank(this, this.layout.player.x, this.layout.player.y, this.layout.player.angle, 'p1', 20);
    this.p1.lives = this.versus ? VERSUS_LIVES : d.lives;

    if (this.versus) {
      this.p2 = new Tank(this, this.layout.enemy.x, this.layout.enemy.y, this.layout.enemy.angle, 'p2', 22);
      this.p2.lives = VERSUS_LIVES;
    } else {
      this.enemy = new Tank(this, this.layout.enemy.x, this.layout.enemy.y, this.layout.enemy.angle, 'enemy', 22);
      this.enemy.lives = d.enemyLives;
    }

    this.crates = this.layout.crates.map((box) => ({ box, alive: true }));
    this.bullets = [];
    this.particles = [];
    this.fireCd1 = 0;
    this.fireCd2 = 0;

    this.aiThinkTimer = 0;
    this.aiDecision = { angle: null, drive: 0, speed: 0, dodging: false };
    this.aiReload = 0.9;
    this.aiCharge = 0;
    this.aiGraceUntil = this.time.now + d.grace * 1000;
    this.aiRoamTimer = 0;

    this.phase = 'ready';
    this.readyTimer = 1.1;
    this.phaseTimer = 0;

    this.drawTerrain();
    this.drawCrates();
    this.hudDirty = true;
    this.levelText.setText(this.versus ? '双人对战 · 纸上方厅' : level.name);
    this.showBanner(this.versus ? '准备！' : level.name, 1.1);
  }

  /** Called by the DOM overlay. */
  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  /** Called by the DOM overlay to restart with the current settings. */
  restartGame(): void {
    this.score = 0;
    this.bullets = [];
    this.particles = [];
    this.paused = false;
    this.autoDodge = settings.autoDodge;
    this.loadLevel(0);
    this.emitOverlay({ kind: 'hidden' });
  }

  setAutoDodge(on: boolean): void {
    this.autoDodge = on;
    settings.autoDodge = on;
    this.hudDirty = true;
    this.refreshHeaderText();
    this.showBanner(on ? '自动躲弹：开' : '自动躲弹：关', 0.9);
  }

  private showBanner(text: string, seconds: number): void {
    this.bannerText.setText(text).setAlpha(0.9).setScale(0.85);
    this.tweens.killTweensOf(this.bannerText);
    this.tweens.add({ targets: this.bannerText, scale: 1, duration: 260, ease: 'Back.easeOut' });
    this.tweens.add({ targets: this.bannerText, alpha: 0, delay: seconds * 1000, duration: 500 });
  }

  // ------------------------------------------------------------------ drawing

  private drawTerrain(): void {
    const t = this.wallsLayer;
    t.clear();

    for (const w of this.layout.walls) t.fillRect(w.x + 6, w.y + 7, w.w, w.h, COLORS.ink, 0.06);
    for (const w of this.layout.walls) t.fillRect(w.x, w.y, w.w, w.h, COLORS.wallFill, 0.92);
    for (const w of this.layout.walls) t.hatch(w.x, w.y, w.w, w.h, 13);
    for (const w of this.layout.walls) t.rect(w.x, w.y, w.w, w.h, { width: 2.6, jitter: 0.9 });
  }

  private drawCrates(): void {
    const c = this.cratesLayer;
    c.clear();
    for (const crate of this.crates) {
      if (!crate.alive) continue;
      const b = crate.box;
      c.fillRect(b.x + 4, b.y + 5, b.w, b.h, COLORS.ink, 0.07);
      c.fillRect(b.x, b.y, b.w, b.h, COLORS.crateLight, 0.75);
      c.hatch(b.x, b.y, b.w, b.h, 9, COLORS.crate, 1.1);
      c.rect(b.x, b.y, b.w, b.h, { width: 2.2, jitter: 0.7 });
      c.line(b.x + 3, b.y + 3, b.x + b.w - 3, b.y + b.h - 3, { width: 1.4, jitter: 0.6 });
      c.line(b.x + b.w - 3, b.y + 3, b.x + 3, b.y + b.h - 3, { width: 1.4, jitter: 0.6 });
    }
  }

  private drawHeart(cx: number, cy: number, size: number, filled: boolean, color: number = COLORS.danger): void {
    const g = this.hud;
    const pts = [
      { x: cx, y: cy + size * 0.85 },
      { x: cx - size, y: cy - size * 0.05 },
      { x: cx - size * 0.62, y: cy - size * 0.72 },
      { x: cx - size * 0.2, y: cy - size * 0.55 },
      { x: cx, y: cy - size * 0.12 },
      { x: cx + size * 0.2, y: cy - size * 0.55 },
      { x: cx + size * 0.62, y: cy - size * 0.72 },
      { x: cx + size, y: cy - size * 0.05 },
    ];
    if (filled) {
      g.graphics.fillStyle(color, 0.28);
      g.graphics.beginPath();
      g.graphics.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) g.graphics.lineTo(pts[i].x, pts[i].y);
      g.graphics.closePath();
      g.graphics.fillPath();
    }
    g.poly(pts, { width: 2.4, color: filled ? color : COLORS.ink, jitter: 0.7 });
  }

  private drawHud(): void {
    this.hud.clear();
    this.hud.line(PLAY_RECT.x, 72, PLAY_RECT.x + PLAY_RECT.w, 72, { width: 1.6, jitter: 1.6 });
    this.hud.line(PLAY_RECT.x, 75, PLAY_RECT.x + PLAY_RECT.w, 75, { width: 1.1, jitter: 1.4 });

    const total = (tank: Tank): number => {
      if (this.versus) return VERSUS_LIVES;
      return tank.id === 'p1' ? preset().lives : preset().enemyLives;
    };

    // Left side: player one.
    const p1Hearts = total(this.p1);
    for (let i = 0; i < p1Hearts; i++) {
      this.drawHeart(PLAY_RECT.x + 10 + i * 30, 40, 12, i < this.p1.lives, COLORS.player);
    }

    if (this.versus && this.p2) {
      const n = total(this.p2);
      for (let i = 0; i < n; i++) {
        this.drawHeart(PLAY_RECT.x + PLAY_RECT.w - 10 - i * 30, 40, 12, i < this.p2.lives, COLORS.player2);
      }
      this.scoreText.setText('');
    } else if (this.enemy) {
      for (let i = 0; i < this.enemy.lives; i++) {
        const x = PLAY_RECT.x + PLAY_RECT.w - 8 - i * 22;
        this.hud.fillCircle(x, 60, 6, COLORS.enemy, 0.7);
        this.hud.circle(x, 60, 6, { width: 1.8, color: COLORS.enemy, jitter: 0.6, passes: 2 });
      }
      for (let i = this.enemy.lives; i < total(this.enemy); i++) {
        const x = PLAY_RECT.x + PLAY_RECT.w - 8 - i * 22;
        this.hud.circle(x, 60, 6, { width: 1.5, color: COLORS.ink, jitter: 0.6, passes: 1 });
      }
      this.scoreText.setText(`得分  ${String(this.score).padStart(5, '0')}`);
    }

    // Auto-dodge badge.
    if (!this.versus && this.autoDodge) {
      const x = GAME_W / 2;
      this.hud.circle(x - 38, 40, 5, { width: 1.6, color: COLORS.player, jitter: 0.5 });
      this.hud.fillCircle(x - 38, 40, 2.4, COLORS.player, 0.9);
    }
    this.hudDirty = false;
  }

  // ------------------------------------------------------------------ update

  update(time: number, delta: number): void {
    const dt = Math.min(delta, 50) / 1000;

    if (Phaser.Input.Keyboard.JustDown(this.pauseKey) || Phaser.Input.Keyboard.JustDown(this.escKey)) {
      this.togglePause();
    }
    if (Phaser.Input.Keyboard.JustDown(this.muteKey)) {
      sound.setMuted(!sound.muted);
      this.showBanner(sound.muted ? '静音' : '开启声音', 0.8);
    }
    if (!this.versus && Phaser.Input.Keyboard.JustDown(this.autoKey)) {
      this.setAutoDodge(!this.autoDodge);
    }

    if (this.paused) {
      this.fx.clear();
      return;
    }

    if (this.hudDirty) this.drawHud();

    if (this.phase === 'ready') {
      this.readyTimer -= dt;
      if (this.readyTimer <= 0) this.phase = 'playing';
    } else if (this.phase === 'playing') {
      this.updateHuman(this.p1, dt, 1);
      if (this.versus && this.p2) this.updateHuman(this.p2, dt, 2);
      if (this.enemy) this.updateAi(dt);
    }

    this.updateBullets(dt);
    this.updateParticles(dt);
    this.updatePhase(dt);
    this.drawFrame(time);
    for (const tank of this.tanks()) tank.sync(time);
  }

  private togglePause(): void {
    if (this.phase === 'over' || this.phase === 'victory' || this.phase === 'versusOver') return;
    this.paused = !this.paused;
    sound.ui();
    this.emitOverlay(this.paused ? { kind: 'paused' } : { kind: 'hidden' });
  }

  private updatePhase(dt: number): void {
    if (this.phase === 'ready' || this.phase === 'playing' || this.phase === 'over' || this.phase === 'victory' || this.phase === 'versusOver') {
      return;
    }

    this.phaseTimer -= dt;
    if (this.phaseTimer > 0) return;

    if (this.phase === 'dying') {
      if (this.versus) {
        const losers = this.humans().filter((t) => t.lives <= 0);
        if (losers.length > 0) {
          this.phase = 'versusOver';
          const p1Dead = this.p1.lives <= 0;
          const winner: 'p1' | 'p2' = p1Dead ? 'p2' : 'p1';
          this.emitOverlay({ kind: 'versusOver', winner, p1Lives: this.p1.lives, p2Lives: this.p2?.lives ?? 0 });
          sound.lose();
          return;
        }
        for (const tank of this.humans()) if (!tank.alive) this.respawn(tank);
      } else if (this.p1.lives > 0) {
        this.respawn(this.p1);
      } else {
        this.phase = 'over';
        this.emitOverlay({ kind: 'gameover', score: this.score, level: LEVELS[this.levelIndex].name });
        sound.lose();
      }
      return;
    }

    if (this.phase === 'cleared') {
      if (this.levelIndex + 1 < LEVELS.length) {
        this.loadLevel(this.levelIndex + 1);
      } else {
        this.phase = 'victory';
        this.emitOverlay({ kind: 'victory', score: this.score });
        sound.win();
      }
    }
  }

  // ------------------------------------------------------------------ humans

  private updateHuman(tank: Tank, dt: number, which: 1 | 2): void {
    if (!tank.alive) return;

    const keys = which === 1 ? this.wasd : this.arrows;
    const trimLeft = which === 1 ? this.trimLeft1 : this.trimLeft2;
    const trimRight = which === 1 ? this.trimRight1 : this.trimRight2;
    const fireKey = which === 1 ? this.fire1 : this.fire2;

    let turn = (keys.right.isDown ? 1 : 0) - (keys.left.isDown ? 1 : 0);
    let drive = (keys.up.isDown ? 1 : 0) - (keys.down.isDown ? 1 : 0);

    // Solo P1: the optional autopilot handles the hull so you can just aim.
    const manual = turn !== 0 || drive !== 0;
    if (which === 1 && !this.versus && this.autoDodge && !manual) {
      const auto = this.autopilotMove(tank);
      turn = auto.turn;
      drive = auto.drive;
    }

    const slow = which === 1 && this.shiftKey.isDown;
    const aimMode = slow && !this.versus;
    tank.bodyAngle += turn * TANK.turnRate * (aimMode ? 0.8 : 1) * dt;

    const fwd = aimMode ? TANK.tacticalSpeed : TANK.driveSpeed;
    const rev = aimMode ? TANK.tacticalReverse : TANK.reverseSpeed;
    const speed = drive > 0 ? fwd : rev;
    const v = drive * speed;
    tank.vx = Math.cos(tank.bodyAngle) * v;
    tank.vy = Math.sin(tank.bodyAngle) * v;
    tank.x += tank.vx * dt;
    tank.y += tank.vy * dt;
    if (this.resolveTankWalls(tank)) {
      tank.vx *= 0.2;
      tank.vy *= 0.2;
    }

    // Aiming: mouse in solo, turret trim in versus.
    if (!this.versus) {
      const pointer = this.input.activePointer;
      const mx = pointer.worldX || GAME_W / 2;
      const my = pointer.worldY || GAME_H / 2;
      const want = Math.atan2(my - tank.y, mx - tank.x);
      tank.turretAngle = turnToward(tank.turretAngle, want, 14, dt);
    } else {
      const trim = (trimRight.isDown ? 1 : 0) - (trimLeft.isDown ? 1 : 0);
      if (trim !== 0) {
        tank.turretAngle = Phaser.Math.Angle.Wrap(tank.turretAngle + trim * 1.9 * dt);
      }
    }

    this.separateTanks();

    if (which === 1) {
      this.fireCd1 -= dt;
      if (this.fireCd1 <= 0 && (fireKey.isDown || (!this.versus && this.input.activePointer.leftButtonDown()))) {
        this.fire(tank);
        this.fireCd1 = 0.24;
      }
    } else {
      this.fireCd2 -= dt;
      if (this.fireCd2 <= 0 && fireKey.isDown) {
        this.fire(tank);
        this.fireCd2 = 0.24;
      }
    }

    if (!this.versus && this.input.activePointer.rightButtonDown() && which === 1) {
      // right mouse = tactical slow mode is already handled by Shift
    }
  }

  /** Auto-dodge: choose the safest heading, ignore walls we would hit. */
  private autopilotMove(tank: Tank): { turn: number; drive: number } {
    const heading = pickHeading({
      x: tank.x,
      y: tank.y,
      radius: tank.radius,
      bodyAngle: tank.bodyAngle,
      walls: this.layout.walls,
      crates: this.crates.filter((c) => c.alive).map((c) => c.box),
      bullets: this.threats(),
      threatWeight: 1.7,
      stepDistance: 72,
      samples: 16,
    });

    if (heading.move === 0 || Number.isNaN(heading.angle)) return { turn: 0, drive: 0 };
    const st = steerTo(heading.angle, tank.bodyAngle);
    return { turn: st.turn, drive: st.drive };
  }

  private respawn(tank: Tank): void {
    const spawn = tank.id === 'p2' ? this.layout.enemy : this.layout.player;
    tank.x = spawn.x;
    tank.y = spawn.y;
    tank.bodyAngle = spawn.angle;
    tank.turretAngle = spawn.angle;
    tank.vx = 0;
    tank.vy = 0;
    tank.setAlive(true, this.time.now);
    tank.invulnerableUntil = this.time.now + 2200;
    tank.sync(this.time.now);
    this.phase = 'playing';
    this.phaseTimer = 0;
    if (!this.versus) this.aiGraceUntil = Math.max(this.aiGraceUntil, this.time.now + 1400);
    this.showBanner(`${tank.id === 'p1' ? 'P1' : 'P2'} 继续！`, 0.9);
  }

  private separateTanks(): void {
    const list = this.tanks().filter((t) => t.alive);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.hypot(dx, dy);
        const min = a.radius + b.radius + 2;
        if (d > 1e-4 && d < min) {
          const push = (min - d) / 2;
          a.x -= (dx / d) * push;
          a.y -= (dy / d) * push;
          b.x += (dx / d) * push;
          b.y += (dy / d) * push;
          this.resolveTankWalls(a);
          this.resolveTankWalls(b);
        }
      }
    }
  }

  private resolveTankWalls(tank: Tank): boolean {
    let pushed = false;
    for (let iter = 0; iter < 2; iter++) {
      for (const box of this.layout.walls) {
        const hit = circleBox(tank.x, tank.y, tank.radius, box);
        if (hit) {
          tank.x += hit.nx * hit.depth;
          tank.y += hit.ny * hit.depth;
          pushed = true;
        }
      }
      for (const crate of this.crates) {
        if (!crate.alive) continue;
        const hit = circleBox(tank.x, tank.y, tank.radius, crate.box);
        if (hit) {
          tank.x += hit.nx * hit.depth;
          tank.y += hit.ny * hit.depth;
          pushed = true;
        }
      }
    }
    return pushed;
  }

  // ------------------------------------------------------------------ firing

  private fire(tank: Tank): void {
    if (!tank.alive) return;
    const dir = tank.turretAngle;
    const speed = tank.id === 'enemy' ? preset().shellSpeed : BULLET.speedPlayer;
    const maxBounces = tank.id === 'enemy' ? Math.max(2, preset().maxBounces + 1) : BULLET.maxBounces;

    // Keep the muzzle outside any neighbouring hull so shells never spawn inside a tank.
    let len = 44;
    for (const other of this.tanks()) {
      if (other === tank || !other.alive) continue;
      while (len > 26) {
        const mx = tank.x + Math.cos(dir) * len;
        const my = tank.y + Math.sin(dir) * len;
        if (Math.hypot(mx - other.x, my - other.y) > other.radius + BULLET.radius + 5) break;
        len -= 4;
      }
    }

    const m = tank.muzzle(len, dir);
    this.spawnBullet(m.x, m.y, dir, tank.id, speed, maxBounces);
    this.burst(m.x, m.y, dir, tank.id);
    this.cameras.main.shake(60, 0.002);
    if (tank.id === 'enemy') sound.enemyFire();
    else sound.fire();

    tank.x -= Math.cos(dir) * 1.4;
    tank.y -= Math.sin(dir) * 1.4;
    this.resolveTankWalls(tank);
  }

  private spawnBullet(x: number, y: number, dir: number, owner: TankId, speed: number, maxBounces: number): void {
    this.bullets.push({
      x,
      y,
      vx: Math.cos(dir) * speed,
      vy: Math.sin(dir) * speed,
      owner,
      color: COLORS_BY_ID[owner],
      bounces: 0,
      maxBounces,
      life: BULLET.lifetime,
      dead: false,
      trail: [],
    });
  }

  private burst(x: number, y: number, dir: number, owner: TankId): void {
    const color = COLORS_BY_ID[owner];
    for (let i = 0; i < 7; i++) {
      const a = dir + (Math.random() - 0.5) * 0.9;
      const sp = 90 + Math.random() * 190;
      this.particles.push({
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: 0.18 + Math.random() * 0.2,
        max: 0.38,
        size: 1.4 + Math.random() * 1.6,
        color: i % 3 === 0 ? COLORS.ink : color,
        kind: 'spark',
        angle: 0,
      });
    }
    this.particles.push({ x, y, vx: 0, vy: 0, life: 0.22, max: 0.22, size: 7, color: COLORS.ink, kind: 'ring', angle: 0 });
  }

  // ------------------------------------------------------------------ AI

  private threats(): ThreatBullet[] {
    return this.bullets
      .filter((b) => !b.dead)
      .map((b) => ({
        x: b.x,
        y: b.y,
        vx: b.vx,
        vy: b.vy,
        bounces: b.bounces,
        maxBounces: b.maxBounces,
        radius: BULLET.radius,
      }));
  }

  private updateAi(dt: number): void {
    const e = this.enemy;
    if (!e || !e.alive) return;
    const d = preset();

    this.aiThinkTimer -= dt;
    if (this.aiThinkTimer <= 0) {
      // Weaker presets take longer to react.
      this.aiThinkTimer = 0.34 - d.dodgeSkill * 0.22;
      this.aiDecision = this.think(e, d);
    }

    const decision = this.aiDecision;
    if (decision.angle !== null) {
      const st = steerTo(decision.angle, e.bodyAngle);
      e.bodyAngle += st.turn * TANK.turnRate * 0.95 * dt;
      const v = st.drive * decision.speed;
      e.vx = Math.cos(e.bodyAngle) * v;
      e.vy = Math.sin(e.bodyAngle) * v;
    } else {
      e.vx = 0;
      e.vy = 0;
    }
    e.x += e.vx * dt;
    e.y += e.vy * dt;
    if (this.resolveTankWalls(e)) this.aiThinkTimer = 0;
    this.separateTanks();

    // Turret: snap onto the telegraph direction, otherwise track the nearest human.
    const target = this.p1.alive ? this.p1 : this.p2 ?? this.p1;
    const track = Math.atan2(target.y - e.y, target.x - e.x);
    const want = this.aiCharge > 0 ? this.aiAimDir : track;
    e.turretAngle = turnToward(e.turretAngle, want, this.aiCharge > 0 ? 7 : 2.4, dt);

    this.updateAiFire(dt, d, target);
  }

  private think(e: Tank, d: DifficultyPreset): AiDecision {
    const bullets = this.threats();
    const crates = this.crates.filter((c) => c.alive).map((c) => c.box);
    const threat = bulletThreatAt(e.x, e.y, e.radius, bullets, this.layout.walls, 1.05);

    // 1) Survival first: dodge shells that are about to arrive.
    const scared = threat.danger * (0.35 + d.dodgeSkill) > 0.13;
    if (scared) {
      const escape = pickHeading({
        x: e.x,
        y: e.y,
        radius: e.radius,
        bodyAngle: e.bodyAngle,
        walls: this.layout.walls,
        crates,
        bullets,
        threatWeight: 1.4 + d.dodgeSkill,
        avoid: this.p1.alive ? { x: this.p1.x, y: this.p1.y, radius: 70 } : null,
        avoidWeight: 0.6,
        stepDistance: 74,
        samples: 16,
      });
      if (!Number.isNaN(escape.angle) && escape.move > 0) {
        return { angle: escape.angle, drive: 1, speed: d.enemySpeed * 1.15, dodging: true };
      }
      return { angle: null, drive: 0, speed: 0, dodging: true };
    }

    // 2) Line up a shot whenever the reload allows it.
    const target = this.p1.alive ? this.p1 : this.p2 ?? this.p1;
    if (this.aiCharge <= 0 && this.aiReload <= 0) {
      const plan = this.planShot(e, target, d);
      if (plan) {
        this.aiAimDir = plan.dir;
        this.aiCharge = d.telegraph;
        return { angle: null, drive: 0, speed: 0, dodging: false };
      }
    }

    // 3) Otherwise reposition: keep mid range, look for a clean bank shot.
    this.aiRoamTimer -= 0.1;
    if (this.aiRoamTimer <= 0 || Math.hypot(this.aiRoam.x - e.x, this.aiRoam.y - e.y) < 50) {
      this.aiRoam = this.pickRoamSpot(target);
      this.aiRoamTimer = 1.6 + Math.random() * 1.4;
    }

    const heading = pickHeading({
      x: e.x,
      y: e.y,
      radius: e.radius,
      bodyAngle: e.bodyAngle,
      walls: this.layout.walls,
      crates,
      bullets,
      threatWeight: 0.7 + d.dodgeSkill,
      target: this.aiRoam,
      targetWeight: 1,
      avoid: { x: target.x, y: target.y, radius: 150 },
      avoidWeight: 0.5,
      stepDistance: 76,
      samples: 16,
    });

    if (Number.isNaN(heading.angle) || heading.move === 0) {
      return { angle: null, drive: 0, speed: 0, dodging: false };
    }
    return { angle: heading.angle, drive: 1, speed: d.enemySpeed, dodging: false };
  }

  private pickRoamSpot(target: Tank): { x: number; y: number } {
    const r = this.layout.rect;
    let best = { x: this.enemy!.x, y: this.enemy!.y };
    let bestScore = -Infinity;
    for (let i = 0; i < 18; i++) {
      const x = r.x + 60 + Math.random() * (r.w - 120);
      const y = r.y + 60 + Math.random() * (r.h - 120);
      if (this.layout.walls.some((w) => circleBox(x, y, 34, w))) continue;
      const distToTarget = Math.hypot(x - target.x, y - target.y);
      // Prefer mid-range spots (bank-shot lanes live there) and open space.
      const rangeScore = -Math.abs(distToTarget - 330) * 0.6;
      const openScore = Math.min(140, nearestGap(x, y, this.layout.walls)) * 0.8;
      const score = rangeScore + openScore + Math.random() * 40;
      if (score > bestScore) {
        bestScore = score;
        best = { x, y };
      }
    }
    return best;
  }

  private planShot(shooter: Tank, target: Tank, d: DifficultyPreset): ShotPlan | null {
    const m = shooter.muzzle(46);
    const opts = {
      radius: BULLET.radius,
      targetRadius: 28,
      maxBounces: d.maxBounces,
      maxLength: 2400,
      samples: 72,
    };
    let plan = planRicochetShot(m.x, m.y, target.x, target.y, this.layout.walls, opts);
    if (plan && d.leadTarget) {
      // Aim where the target will be once the shell arrives.
      const travel = plan.length / d.shellSpeed;
      const px = target.x + target.vx * travel;
      const py = target.y + target.vy * travel;
      const lead = planRicochetShot(m.x, m.y, px, py, this.layout.walls, opts);
      if (lead) plan = lead;
    }
    return plan;
  }

  private updateAiFire(dt: number, d: DifficultyPreset, target: Tank): void {
    const e = this.enemy;
    if (!e) return;

    if (this.aiCharge > 0) {
      this.aiCharge -= dt;
      if (this.aiCharge <= 0) {
        this.fire(e);
        const level = LEVELS[this.levelIndex];
        const levelScale = level.enemyReload / 2.1;
        this.aiReload = d.reload * levelScale * (0.9 + Math.random() * 0.2);
      }
      return;
    }

    if (this.aiReload > 0) this.aiReload -= dt;
    if (this.aiReload > 0) return;
    if (this.time.now < this.aiGraceUntil) return;
    if (!target.alive) return;
    if (this.time.now < target.invulnerableUntil) return;

    const plan = this.planShot(e, target, d);
    this.aiAimDir = plan ? plan.dir : Math.atan2(target.y - e.y, target.x - e.x);
    this.aiCharge = d.telegraph;
  }

  // ------------------------------------------------------------------ bullets

  private updateBullets(dt: number): void {
    for (const b of this.bullets) {
      if (b.dead) continue;

      b.life -= dt;
      if (b.life <= 0) {
        b.dead = true;
        continue;
      }

      b.trail.push({ x: b.x, y: b.y });
      if (b.trail.length > 7) b.trail.shift();

      // Every live tank is a target – including the one that fired it, so a
      // shell coming back off a wall can hit its owner.
      const targets: BulletTarget[] = this.tanks()
        .filter((t) => t.alive)
        .map((t) => ({ id: t.id, x: t.x, y: t.y, radius: t.radius }));

      const events = advanceBullet(b, dt, {
        walls: this.layout.walls,
        crates: this.crates,
        targets,
        radius: BULLET.radius,
        maxBounces: b.maxBounces,
      });

      for (const ev of events) {
        if (ev.kind === 'wall') {
          b.trail = [];
          this.impactSpark(ev.x, ev.y, ev.nx, ev.ny, b.color);
          if (this.time.now - this.lastBounceSound > 45) {
            this.lastBounceSound = this.time.now;
            sound.bounce();
          }
        } else if (ev.kind === 'crate') {
          b.dead = true;
          const crate = this.crates[ev.index];
          if (crate) this.breakCrate(crate, ev.x, ev.y);
          break;
        } else if (ev.kind === 'tank') {
          b.dead = true;
          const victim = this.tanks().find((t) => t.id === ev.id);
          if (victim) this.damage(victim, b.owner);
          break;
        } else {
          b.dead = true;
          this.puff(ev.x, ev.y, b.color, 4);
        }
      }

      if (!b.dead && Math.random() < 0.5) {
        this.particles.push({
          x: b.x,
          y: b.y,
          vx: -b.vx * 0.05 + (Math.random() - 0.5) * 30,
          vy: -b.vy * 0.05 + (Math.random() - 0.5) * 30,
          life: 0.16,
          max: 0.16,
          size: 2.4,
          color: b.color,
          kind: 'puff',
          angle: 0,
        });
      }
    }

    this.bullets = this.bullets.filter((b) => !b.dead);
  }

  private damage(victim: Tank, attacker: TankId): void {
    if (!victim.alive || this.phase !== 'playing') return;
    if (this.time.now < victim.invulnerableUntil) {
      this.puff(victim.x, victim.y, victim.color, 3);
      sound.ping();
      return;
    }

    const self = attacker === victim.id;
    victim.lives = Math.max(0, victim.lives - 1);
    victim.damage += 1;
    victim.redraw();
    this.hudDirty = true;

    if (!this.versus && victim.id !== 'p1') this.score += 150;

    this.cameras.main.shake(self ? 150 : 120, self ? 0.006 : 0.004);
    this.cameras.main.flash(90, 220, 200, 170);
    this.puff(victim.x, victim.y, victim.color, 10);
    this.ring(victim.x, victim.y, victim.color);
    sound.hit();

    if (self) {
      this.showBanner('被自己的炮弹打到了！', 1.0);
    }

    if (victim.lives <= 0) {
      victim.setAlive(false, this.time.now);
      this.explode(victim.x, victim.y, victim.color);
      this.bullets = this.bullets.filter((b) => b.owner === attacker);
      if (victim.id === 'enemy') {
        this.score += 1000;
        this.hudDirty = true;
        this.phase = 'cleared';
        this.phaseTimer = 1.5;
        this.showBanner('击毁！', 1.2);
      } else {
        this.phase = 'dying';
        this.phaseTimer = 1.15;
        if (!this.versus) this.showBanner(`被击中！剩余 ${victim.lives === 0 ? 0 : victim.lives}`, 1.1);
      }
    } else {
      victim.invulnerableUntil = this.time.now + HIT_MERCY * 1000;
    }
  }

  private breakCrate(crate: Crate, x: number, y: number): void {
    crate.alive = false;
    this.score += 25;
    this.hudDirty = true;
    this.drawCrates();
    this.puff(x, y, COLORS.crate, 12);
    this.ring(x, y, COLORS.crate);
    sound.hit();
  }

  // ------------------------------------------------------------------ effects

  private impactSpark(x: number, y: number, nx: number, ny: number, color: number): void {
    for (let i = 0; i < 5; i++) {
      const a = Math.atan2(ny, nx) + (Math.random() - 0.5) * 1.8;
      const sp = 90 + Math.random() * 150;
      this.particles.push({
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: 0.16 + Math.random() * 0.14,
        max: 0.3,
        size: 2.2,
        color: i === 0 ? COLORS.ink : color,
        kind: 'spark',
        angle: 0,
      });
    }
  }

  private puff(x: number, y: number, color: number, count: number): void {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 30 + Math.random() * 120;
      this.particles.push({
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: 0.4 + Math.random() * 0.4,
        max: 0.8,
        size: 2.5 + Math.random() * 4.5,
        color: i % 4 === 0 ? COLORS.ink : color,
        kind: 'puff',
        angle: a,
      });
    }
  }

  private ring(x: number, y: number, color: number): void {
    this.particles.push({ x, y, vx: 0, vy: 0, life: 0.35, max: 0.35, size: 10, color, kind: 'ring', angle: 0 });
  }

  private explode(x: number, y: number, color: number): void {
    this.puff(x, y, color, 22);
    this.ring(x, y, color);
    this.ring(x + 6, y - 4, COLORS.ink);
    for (let i = 0; i < 12; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 120 + Math.random() * 260;
      this.particles.push({
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: 0.5 + Math.random() * 0.5,
        max: 1,
        size: 3 + Math.random() * 4,
        color: COLORS.ink,
        kind: 'debris',
        angle: a,
      });
    }
    sound.explode();
  }

  private updateParticles(dt: number): void {
    for (const p of this.particles) {
      p.life -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const drag = 1 - Math.min(0.9, 3.2 * dt);
      p.vx *= drag;
      p.vy *= drag;
    }
    this.particles = this.particles.filter((p) => p.life > 0);
  }

  private drawFrame(time: number): void {
    const g = this.fx;
    g.clear();

    if (this.phase === 'playing' || this.phase === 'ready') {
      if (!this.versus && this.p1.alive) {
        this.drawAimGuide(g, this.p1, COLORS.player, 0.62);
      } else if (this.versus) {
        if (this.p1.alive) this.drawAimGuide(g, this.p1, COLORS.player, 0.34);
        if (this.p2?.alive) this.drawAimGuide(g, this.p2, COLORS.player2, 0.34);
      }
    }

    if (this.enemy?.alive && this.aiCharge > 0) {
      const m = this.enemy.muzzle(46, this.aiAimDir);
      const len = 110 + (preset().telegraph - this.aiCharge) * 150;
      this.dashedLine(
        g,
        m.x,
        m.y,
        m.x + Math.cos(this.aiAimDir) * len,
        m.y + Math.sin(this.aiAimDir) * len,
        COLORS.enemy,
        0.6,
        5,
        6,
        1.6
      );
    }

    for (const b of this.bullets) {
      for (let i = 0; i < b.trail.length; i++) {
        const t = b.trail[i];
        g.fillStyle(b.color, (i / b.trail.length) * 0.35);
        g.fillCircle(t.x, t.y, BULLET.radius * (0.35 + (i / b.trail.length) * 0.7));
      }
      g.fillStyle(COLORS.ink, 0.85);
      g.fillCircle(b.x, b.y, BULLET.radius + 1.6);
      g.fillStyle(b.color, 1);
      g.fillCircle(b.x, b.y, BULLET.radius);
      g.fillStyle(COLORS.white, 0.8);
      g.fillCircle(b.x - 1.4, b.y - 1.4, 1.2);
    }

    for (const p of this.particles) {
      const k = Math.max(0, p.life / p.max);
      if (p.kind === 'spark') {
        g.lineStyle(p.size, p.color, 0.15 + k * 0.85);
        g.beginPath();
        g.moveTo(p.x, p.y);
        g.lineTo(p.x - p.vx * 0.018, p.y - p.vy * 0.018);
        g.strokePath();
      } else if (p.kind === 'puff') {
        g.fillStyle(p.color, 0.1 + k * 0.35);
        g.fillCircle(p.x, p.y, p.size * (1.4 - k * 0.5));
      } else if (p.kind === 'ring') {
        g.lineStyle(2, p.color, k * 0.55);
        g.strokeCircle(p.x, p.y, p.size + (1 - k) * 34);
      } else {
        g.lineStyle(1.8, p.color, k * 0.9);
        g.beginPath();
        g.moveTo(p.x, p.y);
        g.lineTo(p.x + Math.cos(p.angle) * p.size * 2.6, p.y + Math.sin(p.angle) * p.size * 2.6);
        g.strokePath();
      }
    }

    const pointer = this.input.activePointer;
    if (!this.versus && this.phase === 'playing' && (pointer.worldX > 0 || pointer.worldY > 0)) {
      const x = pointer.worldX;
      const y = pointer.worldY;
      g.lineStyle(1.6, COLORS.ink, 0.5);
      g.strokeCircle(x, y, 11 + Math.sin(time / 260) * 1.2);
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        g.beginPath();
        g.moveTo(x + Math.cos(a) * 14, y + Math.sin(a) * 14);
        g.lineTo(x + Math.cos(a) * 19, y + Math.sin(a) * 19);
        g.strokePath();
      }
    }

    // Warning pip when a shell is closing in on a human.
    if (this.phase === 'playing') {
      for (const tank of this.humans()) {
        if (!tank.alive) continue;
        const threat = bulletThreatAt(tank.x, tank.y, tank.radius, this.threats(), this.layout.walls, 0.55);
        if (threat.danger > 0.25) {
          const pulse = 0.35 + Math.sin(time / 90) * 0.2;
          g.lineStyle(2.4, COLORS.danger, Math.max(0.15, pulse));
          g.strokeCircle(tank.x, tank.y, tank.radius + 12);
        }
      }
    }
  }

  private drawAimGuide(g: Phaser.GameObjects.Graphics, tank: Tank, color: number, baseAlpha: number): void {
    const start = tank.muzzle(44);
    let px = start.x;
    let py = start.y;
    let dx = Math.cos(tank.turretAngle);
    let dy = Math.sin(tank.turretAngle);
    const range = 2200;

    for (let b = 0; b <= 4; b++) {
      const hit = sweepCircleBox(px, py, BULLET.radius, dx * range, dy * range, this.layout.walls);
      const len = hit ? range - hit.remaining : range;
      const alpha = Math.max(0.1, baseAlpha - b * baseAlpha * 0.22);
      this.dashedLine(g, px, py, px + dx * len, py + dy * len, color, alpha, 14, 9, b === 0 ? 2.3 : 1.7);
      px += dx * len;
      py += dy * len;
      if (!hit) break;
      const r = reflect(dx, dy, hit.nx, hit.ny);
      dx = r.x;
      dy = r.y;
      px += hit.nx * 0.6;
      py += hit.ny * 0.6;
      g.lineStyle(1.4, color, alpha + 0.1);
      g.strokeCircle(px, py, 4);
    }
  }

  private dashedLine(
    g: Phaser.GameObjects.Graphics,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    color: number,
    alpha: number,
    dash: number,
    gap: number,
    width: number
  ): void {
    const total = Math.hypot(x2 - x1, y2 - y1);
    if (total < 1) return;
    const ux = (x2 - x1) / total;
    const uy = (y2 - y1) / total;
    g.lineStyle(width, color, alpha);
    for (let d = 0; d < total; d += dash + gap) {
      const e = Math.min(total, d + dash);
      g.beginPath();
      g.moveTo(x1 + ux * d, y1 + uy * d);
      g.lineTo(x1 + ux * e, y1 + uy * e);
      g.strokePath();
    }
  }
}

function turnToward(current: number, target: number, rate: number, dt: number): number {
  const diff = Phaser.Math.Angle.Wrap(target - current);
  const step = rate * dt;
  if (Math.abs(diff) <= step) return target;
  return current + Math.sign(diff) * step;
}

function nearestGap(px: number, py: number, walls: Box[]): number {
  let best = 140;
  for (const b of walls) {
    const ix = px < b.x ? b.x : px > b.x + b.w ? b.x + b.w : px;
    const iy = py < b.y ? b.y : py > b.y + b.h ? b.y + b.h : py;
    const inside = px > b.x && px < b.x + b.w && py > b.y && py < b.y + b.h;
    const d = inside ? 0 : Math.hypot(px - ix, py - iy);
    if (d < best) best = d;
  }
  return best;
}
