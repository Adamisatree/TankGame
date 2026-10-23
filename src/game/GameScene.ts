import Phaser from 'phaser';
import { planRicochetShot } from '../engine/ai';
import { advanceBullet, type BulletTarget } from '../engine/bullet';
import { LEVELS, buildLayout, type Layout, type PlayRect } from '../engine/level';
import { circleBox, reflect, sweepCircleBox, type Box } from '../engine/physics';
import { BULLET, COLORS, GAME_H, GAME_W, TANK } from './config';
import { OVERLAY_EVENT, type OverlayState } from './events';
import { Sketch } from './Sketch';
import { Tank } from './Tank';
import { makeTextures, paperBackground } from './art';
import { sound } from './Sound';

/** Drawing area, leaving room for the sketch HUD at the top and hints below. */
const PLAY_RECT: PlayRect = { x: 34, y: 82, w: GAME_W - 68, h: GAME_H - 82 - 46 };

type Phase = 'playing' | 'dying' | 'cleared' | 'over' | 'victory';

interface Bullet {
  x: number;
  y: number;
  vx: number;
  vy: number;
  owner: 'player' | 'enemy';
  color: number;
  bounces: number;
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

type KeyMap = Record<'up' | 'down' | 'left' | 'right', Phaser.Input.Keyboard.Key>;

export class GameScene extends Phaser.Scene {
  private levelIndex = 0;
  private layout!: Layout;
  private phase: Phase = 'playing';
  private paused = false;

  private wallsLayer!: Sketch;
  private cratesLayer!: Sketch;
  private fx!: Phaser.GameObjects.Graphics;
  private hud!: Sketch;
  private levelText!: Phaser.GameObjects.Text;
  private scoreText!: Phaser.GameObjects.Text;
  private hintText!: Phaser.GameObjects.Text;
  private bannerText!: Phaser.GameObjects.Text;

  private player!: Tank;
  private enemy!: Tank;
  private crates: Crate[] = [];
  private bullets: Bullet[] = [];
  private particles: Particle[] = [];

  private lives = 3;
  private score = 0;
  private enemyHp = 3;
  private readonly enemyHpMax = 3;

  private fireCd = 0;
  private enemyCd = 0;
  private enemyCharge = 0;
  private enemyAimDir = 0;
  private enemyGraceUntil = 0;
  private roamTarget = { x: 0, y: 0 };
  private roamTimer = 0;
  private phaseTimer = 0;
  private hudDirty = true;
  private lastBounceSound = 0;

  private keys!: KeyMap;
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private spaceKey!: Phaser.Input.Keyboard.Key;
  private shiftKey!: Phaser.Input.Keyboard.Key;
  private pauseKey!: Phaser.Input.Keyboard.Key;
  private escKey!: Phaser.Input.Keyboard.Key;
  private muteKey!: Phaser.Input.Keyboard.Key;

  constructor() {
    super('Game');
  }

  create(): void {
    makeTextures(this);
    paperBackground(this);

    this.wallsLayer = new Sketch(this, 5);
    this.cratesLayer = new Sketch(this, 6);
    this.fx = this.add.graphics().setDepth(30);
    this.hud = new Sketch(this, 40);

    this.cursors = this.input.keyboard!.createCursorKeys();
    this.keys = this.input.keyboard!.addKeys({
      up: 'W',
      down: 'S',
      left: 'A',
      right: 'D',
    }) as KeyMap;
    this.spaceKey = this.input.keyboard!.addKey('SPACE');
    this.shiftKey = this.input.keyboard!.addKey('SHIFT');
    this.pauseKey = this.input.keyboard!.addKey('P');
    this.escKey = this.input.keyboard!.addKey('ESC');
    this.muteKey = this.input.keyboard!.addKey('M');

    this.levelText = this.hud.text(GAME_W / 2, 42, '', 26, COLORS.ink);
    this.scoreText = this.hud.text(GAME_W - 48, 42, '', 24, COLORS.ink, 'right');
    this.hintText = this.hud.text(
      GAME_W / 2,
      GAME_H - 24,
      'WASD / 方向键 驾驶   ·   鼠标瞄准   ·   左键 / 空格 开火   ·   右键或 Shift 慢速微调   ·   P 暂停',
      16,
      COLORS.ink
    );
    this.hintText.setAlpha(0.55);
    this.bannerText = this.hud.text(GAME_W / 2, GAME_H / 2, '', 64, COLORS.ink);
    this.bannerText.setAlpha(0);

    this.input.mouse?.disableContextMenu();

    this.lives = 3;
    this.score = 0;
    this.levelIndex = 0;
    this.paused = false;
    this.phase = 'playing';
    this.loadLevel(0);
    this.emitOverlay({ kind: 'hidden' });
  }

  // ------------------------------------------------------------------ level

  private loadLevel(index: number): void {
    this.levelIndex = index;
    const level = LEVELS[index];
    this.layout = buildLayout(level, PLAY_RECT);

    this.player?.destroy();
    this.enemy?.destroy();

    this.player = new Tank(this, this.layout.player.x, this.layout.player.y, this.layout.player.angle, 'player', 20);
    this.enemy = new Tank(this, this.layout.enemy.x, this.layout.enemy.y, this.layout.enemy.angle, 'enemy', 22);

    this.crates = this.layout.crates.map((box) => ({ box, alive: true }));
    this.bullets = [];
    this.particles = [];
    this.enemyHp = this.enemyHpMax;
    this.enemyCharge = 0;
    this.enemyCd = 1.2;
    this.enemyGraceUntil = this.time.now + level.enemyGrace * 1000;
    this.fireCd = 0;
    this.roamTimer = 0;
    this.phase = 'playing';
    this.phaseTimer = 0;

    this.drawTerrain();
    this.drawCrates();
    this.hudDirty = true;
    this.levelText.setText(level.name);
    this.showBanner(level.name, 1.6);
  }

  /** Pauses the simulation while the DOM overlay is up. */
  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  restartGame(): void {
    this.lives = 3;
    this.score = 0;
    this.bullets = [];
    this.particles = [];
    this.loadLevel(0);
    this.paused = false;
    this.emitOverlay({ kind: 'hidden' });
  }

  private emitOverlay(state: OverlayState): void {
    this.game.events.emit(OVERLAY_EVENT, state);
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

  private drawHeart(cx: number, cy: number, size: number, filled: boolean): void {
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
      g.graphics.fillStyle(COLORS.danger, 0.28);
      g.graphics.beginPath();
      g.graphics.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) g.graphics.lineTo(pts[i].x, pts[i].y);
      g.graphics.closePath();
      g.graphics.fillPath();
    }
    g.poly(pts, { width: 2.4, color: filled ? COLORS.danger : COLORS.ink, jitter: 0.7 });
  }

  private drawHud(): void {
    const lvl = LEVELS[this.levelIndex];
    this.levelText.setText(lvl.name);
    this.scoreText.setText(`得分  ${String(this.score).padStart(5, '0')}`);

    {
      this.hud.clear();
      // Header rule.
      this.hud.line(PLAY_RECT.x, 72, PLAY_RECT.x + PLAY_RECT.w, 72, { width: 1.6, jitter: 1.6 });
      this.hud.line(PLAY_RECT.x, 75, PLAY_RECT.x + PLAY_RECT.w, 75, { width: 1.1, jitter: 1.4 });
      // Lives.
      for (let i = 0; i < 3; i++) this.drawHeart(PLAY_RECT.x + 10 + i * 34, 42, 13, i < this.lives);
      // Enemy hull pips.
      for (let i = 0; i < this.enemyHpMax; i++) {
        const x = PLAY_RECT.x + PLAY_RECT.w - 6 - i * 22;
        const on = i < this.enemyHp;
        this.hud.fillCircle(x, 60, 6, on ? COLORS.enemy : COLORS.paper, on ? 0.75 : 1);
        this.hud.circle(x, 60, 6, { width: 1.8, color: on ? COLORS.enemy : COLORS.ink, jitter: 0.6, passes: 2 });
      }
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

    if (this.paused) {
      this.fx.clear();
      return;
    }

    if (this.hudDirty) this.drawHud();

    if (this.phase === 'playing') {
      this.updatePlayer(dt);
      this.updateEnemy(dt);
    }
    this.updateBullets(dt);
    this.updateParticles(dt);
    this.updatePhase(dt, time);
    this.drawFrame(time);
    this.player?.sync(time);
    this.enemy?.sync(time);
  }

  private togglePause(): void {
    if (this.phase === 'over' || this.phase === 'victory') return;
    this.paused = !this.paused;
    sound.ui();
    this.emitOverlay(this.paused ? { kind: 'paused' } : { kind: 'hidden' });
  }

  private updatePhase(dt: number, _time: number): void {
    if (this.phase === 'playing' || this.phase === 'over' || this.phase === 'victory') return;

    this.phaseTimer -= dt;
    if (this.phaseTimer > 0) return;

    if (this.phase === 'dying') {
      if (this.lives > 0) {
        this.respawnPlayer();
      } else {
        this.phase = 'over';
        this.emitOverlay({ kind: 'gameover', score: this.score, level: LEVELS[this.levelIndex].name });
        sound.lose();
      }
    } else if (this.phase === 'cleared') {
      if (this.levelIndex + 1 < LEVELS.length) {
        this.loadLevel(this.levelIndex + 1);
      } else {
        this.phase = 'victory';
        this.emitOverlay({ kind: 'victory', score: this.score });
        sound.win();
      }
    }
  }

  // ------------------------------------------------------------------ player

  private updatePlayer(dt: number): void {
    if (!this.player.alive) return;

    const p = this.player;
    const pointer = this.input.activePointer;
    const aimMode = this.shiftKey.isDown || pointer.rightButtonDown();

    // Body: turn + drive.
    const turn = (this.cursors.right.isDown || this.keys.right.isDown ? 1 : 0) - (this.cursors.left.isDown || this.keys.left.isDown ? 1 : 0);
    const drive =
      (this.cursors.up.isDown || this.keys.up.isDown ? 1 : 0) - (this.cursors.down.isDown || this.keys.down.isDown ? 1 : 0);

    const turnRate = TANK.turnRate * (aimMode ? 0.75 : 1);
    p.bodyAngle += turn * turnRate * dt;

    const speed = aimMode
      ? drive > 0
        ? TANK.tacticalSpeed
        : TANK.tacticalReverse
      : drive > 0
        ? TANK.driveSpeed
        : TANK.reverseSpeed;

    const v = drive * speed;
    p.vx = Math.cos(p.bodyAngle) * v;
    p.vy = Math.sin(p.bodyAngle) * v;
    p.x += p.vx * dt;
    p.y += p.vy * dt;

    const pushed = this.resolveTankWalls(p);
    if (pushed) {
      p.vx *= 0.2;
      p.vy *= 0.2;
    }

    // Turret: follow the mouse quickly.
    const mx = pointer.worldX || GAME_W / 2;
    const my = pointer.worldY || GAME_H / 2;
    const want = Math.atan2(my - p.y, mx - p.x);
    p.turretAngle = turnToward(p.turretAngle, want, 13, dt);

    // Aiming visual: a slight settle of the hull when the brakes are on.
    this.separateTanks();

    // Fire.
    this.fireCd -= dt;
    const wantFire = pointer.leftButtonDown() || this.spaceKey.isDown;
    if (wantFire && this.fireCd <= 0) {
      this.firePlayer();
    }

  }

  private respawnPlayer(): void {
    const p = this.player;
    p.x = this.layout.player.x;
    p.y = this.layout.player.y;
    p.bodyAngle = this.layout.player.angle;
    p.turretAngle = this.layout.player.angle;
    p.alive = true;
    p.invulnerableUntil = this.time.now + 2000;
    p.vx = 0;
    p.vy = 0;
    p.sync(this.time.now);
    this.enemyGraceUntil = this.time.now + 1200;
    this.phase = 'playing';
    this.phaseTimer = 0;
    this.showBanner('继续！', 0.9);
  }

  private separateTanks(): void {
    const a = this.player;
    const b = this.enemy;
    if (!b.alive) return;
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

  private firePlayer(): void {
    const p = this.player;
    if (!p.alive) return;
    const m = p.muzzle(44);
    this.spawnBullet(m.x, m.y, p.turretAngle, 'player');
    this.fireCd = 0.27;
    this.burst(m.x, m.y, p.turretAngle, 'player');
    this.cameras.main.shake(70, 0.0022);
    sound.fire();
    // The hull gets a nudge backwards.
    p.x -= Math.cos(p.turretAngle) * 1.6;
    p.y -= Math.sin(p.turretAngle) * 1.6;
    this.resolveTankWalls(p);
  }

  private spawnBullet(x: number, y: number, dir: number, owner: 'player' | 'enemy'): void {
    const speed = owner === 'player' ? BULLET.speedPlayer : BULLET.speedEnemy;
    this.bullets.push({
      x,
      y,
      vx: Math.cos(dir) * speed,
      vy: Math.sin(dir) * speed,
      owner,
      color: owner === 'player' ? COLORS.player : COLORS.enemy,
      bounces: 0,
      life: BULLET.lifetime,
      dead: false,
      trail: [],
    });
  }

  private burst(x: number, y: number, dir: number, owner: 'player' | 'enemy'): void {
    const color = owner === 'player' ? COLORS.player : COLORS.enemy;
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
    this.particles.push({
      x,
      y,
      vx: 0,
      vy: 0,
      life: 0.22,
      max: 0.22,
      size: 7,
      color: COLORS.ink,
      kind: 'ring',
      angle: 0,
    });
  }

  // ------------------------------------------------------------------ enemy

  private updateEnemy(dt: number): void {
    const e = this.enemy;
    if (!e.alive) return;

    this.roamTimer -= dt;
    const dx = this.roamTarget.x - e.x;
    const dy = this.roamTarget.y - e.y;
    if (this.roamTimer <= 0 || Math.hypot(dx, dy) < 60) this.pickRoamTarget();

    const desired = Math.atan2(this.roamTarget.y - e.y, this.roamTarget.x - e.x);
    e.bodyAngle = turnToward(e.bodyAngle, desired, 2.1, dt);

    const speed = this.enemyCharge > 0 ? 55 : 118;
    e.vx = Math.cos(e.bodyAngle) * speed;
    e.vy = Math.sin(e.bodyAngle) * speed;
    e.x += e.vx * dt;
    e.y += e.vy * dt;

    if (this.resolveTankWalls(e)) {
      this.roamTimer = 0;
    }
    this.separateTanks();

    // Turret: aim at the plan, otherwise track the player.
    const targetAngle =
      this.enemyCharge > 0 && this.player.alive
        ? this.enemyAimDir
        : Math.atan2(this.player.y - e.y, this.player.x - e.x);
    e.turretAngle = turnToward(e.turretAngle, targetAngle, this.enemyCharge > 0 ? 6.5 : 1.9, dt);

    this.updateEnemyFire(dt);
  }

  private pickRoamTarget(): void {
    const r = this.layout.rect;
    for (let i = 0; i < 24; i++) {
      const x = r.x + 40 + Math.random() * (r.w - 80);
      const y = r.y + 40 + Math.random() * (r.h - 80);
      if (Math.hypot(x - this.player.x, y - this.player.y) < 140) continue;
      let blocked = false;
      for (const box of this.layout.walls) {
        if (circleBox(x, y, 34, box)) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      this.roamTarget = { x, y };
      this.roamTimer = 2.2 + Math.random() * 2;
      return;
    }
    this.roamTarget = { x: this.layout.enemy.x, y: this.layout.enemy.y };
    this.roamTimer = 1.4;
  }

  private updateEnemyFire(dt: number): void {
    const e = this.enemy;
    if (!this.player.alive) return;

    if (this.enemyCharge > 0) {
      this.enemyCharge -= dt;
      if (this.enemyCharge <= 0) {
        const level = LEVELS[this.levelIndex];
        const m = e.muzzle(44, this.enemyAimDir);
        this.spawnBullet(m.x, m.y, this.enemyAimDir, 'enemy');
        this.burst(m.x, m.y, this.enemyAimDir, 'enemy');
        sound.enemyFire();
        this.enemyCd = level.enemyReload * (0.85 + Math.random() * 0.35);
      }
      return;
    }

    this.enemyCd -= dt;
    if (this.enemyCd > 0 || this.time.now < this.enemyGraceUntil) return;

    const m = e.muzzle(46);
    const plan = planRicochetShot(m.x, m.y, this.player.x, this.player.y, this.layout.walls, {
      radius: BULLET.radius,
      targetRadius: 26,
      maxBounces: 3,
      maxLength: 2400,
      samples: 64,
    });

    this.enemyAimDir = plan ? plan.dir : Math.atan2(this.player.y - m.y, this.player.x - m.x);
    this.enemyCharge = 0.55;
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

      const targets: BulletTarget[] = [];
      if (b.owner === 'player') {
        if (this.enemy.alive) {
          targets.push({ id: 'enemy', x: this.enemy.x, y: this.enemy.y, radius: this.enemy.radius });
        }
      } else if (this.player.alive) {
        targets.push({ id: 'player', x: this.player.x, y: this.player.y, radius: this.player.radius });
      }

      const events = advanceBullet(b, dt, {
        walls: this.layout.walls,
        crates: this.crates,
        targets,
        radius: BULLET.radius,
        maxBounces: BULLET.maxBounces,
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
          if (ev.id === 'enemy') this.hitEnemy();
          else this.hitPlayer();
          break;
        } else {
          b.dead = true;
          this.puff(ev.x, ev.y, b.color, 4);
        }
      }

      // A little spark trail.
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

  private hitEnemy(): void {
    const e = this.enemy;
    if (!e.alive || this.phase !== 'playing') return;
    this.enemyHp--;
    e.damage = this.enemyHpMax - this.enemyHp;
    e.redraw();
    this.enemyHp = Math.max(0, this.enemyHp);
    this.score += 150;
    this.hudDirty = true;
    this.cameras.main.shake(110, 0.004);
    this.cameras.main.flash(80, 220, 200, 170);
    this.puff(e.x, e.y, COLORS.enemy, 10);
    this.ring(e.x, e.y, COLORS.enemy);
    sound.hit();

    if (this.enemyHp <= 0) {
      e.alive = false;
      this.score += 1000;
      this.hudDirty = true;
      this.explode(e.x, e.y, COLORS.enemy);
      // Leftover enemy shells must not spoil the victory lap.
      this.bullets = this.bullets.filter((b) => b.owner === 'player');
      this.phase = 'cleared';
      this.phaseTimer = 1.5;
      this.showBanner('击毁！', 1.2);
    }
  }

  private hitPlayer(): void {
    const p = this.player;
    if (!p.alive || this.phase !== 'playing') return;
    if (this.time.now < p.invulnerableUntil) {
      this.puff(p.x, p.y, COLORS.player, 3);
      sound.ping();
      return;
    }

    this.lives--;
    this.hudDirty = true;
    this.explode(p.x, p.y, COLORS.player);
    sound.explode();
    this.cameras.main.shake(260, 0.009);
    this.cameras.main.flash(140, 210, 120, 90);

    if (this.lives > 0) {
      p.alive = false;
      this.phase = 'dying';
      this.phaseTimer = 1.1;
      this.bullets = this.bullets.filter((b) => b.owner === 'player');
      this.showBanner(`被击中！剩余 ${this.lives}`, 1.2);
    } else {
      p.alive = false;
      this.phase = 'dying';
      this.phaseTimer = 1.2;
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
    this.particles.push({
      x,
      y,
      vx: 0,
      vy: 0,
      life: 0.35,
      max: 0.35,
      size: 10,
      color,
      kind: 'ring',
      angle: 0,
    });
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

    // Aim guide: the player's incoming ricochet, dashed and fading.
    if (this.phase === 'playing' && this.player.alive) this.drawAimGuide(g);

    // Enemy telegraph: a short dotted hint of where it is about to shoot.
    if (this.enemyCharge > 0 && this.enemy.alive) {
      const m = this.enemy.muzzle(44, this.enemyAimDir);
      const len = 90 + (0.55 - this.enemyCharge) * 120;
      this.dashedLine(
        g,
        m.x,
        m.y,
        m.x + Math.cos(this.enemyAimDir) * len,
        m.y + Math.sin(this.enemyAimDir) * len,
        COLORS.enemy,
        0.55,
        5,
        6,
        1.4
      );
    }

    // Bullets with trails.
    for (const b of this.bullets) {
      for (let i = 0; i < b.trail.length; i++) {
        const t = b.trail[i];
        const a = (i / b.trail.length) * 0.35;
        g.fillStyle(b.color, a);
        g.fillCircle(t.x, t.y, BULLET.radius * (0.35 + (i / b.trail.length) * 0.7));
      }
      g.fillStyle(COLORS.ink, 0.85);
      g.fillCircle(b.x, b.y, BULLET.radius + 1.6);
      g.fillStyle(b.color, 1);
      g.fillCircle(b.x, b.y, BULLET.radius);
      // Tiny highlight so it reads as a drawn "b" pellet.
      g.fillStyle(COLORS.white, 0.8);
      g.fillCircle(b.x - 1.4, b.y - 1.4, 1.2);
    }

    // Particles.
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

    // Hand-drawn reticle at the pointer.
    const pointer = this.input.activePointer;
    if (this.phase === 'playing' && (pointer.worldX > 0 || pointer.worldY > 0)) {
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
  }

  private drawAimGuide(g: Phaser.GameObjects.Graphics): void {
    const start = this.player.muzzle(44);
    let px = start.x;
    let py = start.y;
    let dx = Math.cos(this.player.turretAngle);
    let dy = Math.sin(this.player.turretAngle);
    const wallHitRange = 2200;

    for (let b = 0; b <= 4; b++) {
      const hit = sweepCircleBox(px, py, BULLET.radius, dx * wallHitRange, dy * wallHitRange, this.layout.walls);
      const len = hit ? wallHitRange - hit.remaining : wallHitRange;
      const alpha = 0.6 - b * 0.12;
      this.dashedLine(g, px, py, px + dx * len, py + dy * len, COLORS.player, Math.max(0.12, alpha), 14, 9, b === 0 ? 2.4 : 1.8);
      px += dx * len;
      py += dy * len;
      if (!hit) break;
      const r = reflect(dx, dy, hit.nx, hit.ny);
      dx = r.x;
      dy = r.y;
      px += hit.nx * 0.6;
      py += hit.ny * 0.6;
      g.lineStyle(1.4, COLORS.player, 0.5);
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
