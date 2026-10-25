import Phaser from 'phaser';
import { planRicochetShot, type ShotPlan } from '../engine/ai';
import { advanceBullet, type BulletTarget } from '../engine/bullet';
import { LEVELS, buildLayout, levelIndexById, randomLevelIndex, type Layout, type PlayRect } from '../engine/level';
import { circleBox, reflect, sweepCircleBox, type Box } from '../engine/physics';
import { bulletThreatAt, pickHeading, steerTo, type ThreatBullet } from '../engine/steer';
import { BULLET, COLORS, GAME_H, GAME_W, HIT_MERCY, TANK } from './config';
import { OVERLAY_EVENT, type OverlayState } from './events';
import { Sketch } from './Sketch';
import { Tank, TURRET_LIMIT, type TankId } from './Tank';
import { getBindings, keyLabel, SEAT_ACTIONS, type SeatAction, type SeatBindings } from './keybinds';
import { makePickup, PICKUPS, PICKUP_RADIUS, PICKUP_RESPAWN, rollPickupKind, type Pickup } from './pickups';
import { isSkillId, RAGE_SHOTS, skillById, type SkillId } from './skills';
import { makeTextures, paperBackground } from './art';
import { sound } from './Sound';
import { preset, settings, VERSUS_LIVES, type DifficultyPreset } from './settings';
import { fetchLanInfo, LanClient } from '../net/LanClient';
import { DEFAULT_LAN_PORT } from '../net/protocol';
import type { NetEvent, Snapshot, TankInput } from '../net/protocol';

/** Drawing area, leaving room for the sketch HUD at the top and hints below. */
/** Arenas per solo run. */
const SOLO_CAMPAIGN_LENGTH = 5;

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
  /** 1 normally, 2 while 狂暴 is up. */
  dmg: number;
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
  private pickups: Pickup[] = [];
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

  /** Map index the current match started on (solo marches on from here). */
  private startIndex = 0;
  /** How many arenas the solo run has cleared. */
  private levelsCleared = 0;
  /** Summoner skills, per seat. */
  private skillP1: SkillId = 'blink';
  private skillP2: SkillId = 'blink';
  private skillLabel1?: Phaser.GameObjects.Text;
  private skillLabel2?: Phaser.GameObjects.Text;

  // Input: one Phaser Key per bound action, keyed by "<prefix>.<action>".
  private keys = new Map<string, Phaser.Input.Keyboard.Key>();

  private fireCd1 = 0;
  private fireCd2 = 0;

  // ---- LAN
  private lan: LanClient | null = null;
  private lanRole: 'host' | 'guest' | null = null;
  /** Set on shutdown so late socket callbacks never touch a dead scene. */
  private lanClosed = false;
  private remoteInput: TankInput = { turn: 0, drive: 0, aim: 0, fire: false };
  private netEvents: NetEvent[] = [];
  private netTimer = 0;
  private netSeq = 0;
  private snap: Snapshot | null = null;
  private snapAt = 0;
  private netBanner = '';
  /** Address the host should hand to the guest, discovered from the server. */
  private roomUrl = '';
  /** Latched so a skill press is never lost between 30 Hz packets. */
  private guestSkillLatch = false;

  constructor() {
    super('Game');
  }

  /**
   * Turns the saved bindings into Phaser Key objects. Only the seats this
   * machine actually drives are bound, so a guest never listens for P1 keys.
   */
  private buildKeys(): void {
    const kb = this.input.keyboard!;
    const b = getBindings();
    const bindSeat = (prefix: string, seat: SeatBindings): void => {
      for (const action of SEAT_ACTIONS) {
        this.keys.set(`${prefix}.${action}`, kb.addKey(seat[action]));
      }
    };

    if (settings.mode === 'solo') {
      bindSeat('p1', b.solo);
      this.skillP1 = settings.skillP1;
    } else if (settings.mode === 'versus') {
      bindSeat('p1', b.versus.p1);
      bindSeat('p2', b.versus.p2);
      this.skillP1 = settings.skillP1;
      this.skillP2 = settings.skillP2;
    } else if (settings.lanRole === 'host') {
      bindSeat('p1', b.lan.host);
      this.skillP1 = settings.skillP1;
      this.skillP2 = settings.skillP2;
    } else {
      bindSeat('guest', b.lan.guest);
      this.skillP1 = settings.skillP2;
      this.skillP2 = settings.skillP2;
    }

    this.keys.set('global.pause', kb.addKey(b.global.pause));
    this.keys.set('global.mute', kb.addKey(b.global.mute));
    this.keys.set('global.autoDodge', kb.addKey(b.global.autoDodge));
    // Escape always pauses, whatever the bindings say.
    this.keys.set('global.esc', kb.addKey('ESC'));
  }

  private keyDown(prefix: string, action: SeatAction): boolean {
    return this.keys.get(`${prefix}.${action}`)?.isDown ?? false;
  }

  private keyJustDown(prefix: string, action: SeatAction): boolean {
    const key = this.keys.get(`${prefix}.${action}`);
    return key ? Phaser.Input.Keyboard.JustDown(key) : false;
  }

  private get versus(): boolean {
    return settings.mode === 'versus' || settings.mode === 'lan';
  }

  private get lanMode(): boolean {
    return settings.mode === 'lan';
  }

  // ------------------------------------------------------------------ setup

  create(): void {
    makeTextures(this);
    paperBackground(this);

    this.wallsLayer = new Sketch(this, 5);
    this.cratesLayer = new Sketch(this, 6);
    this.fx = this.add.graphics().setDepth(30);
    this.hud = new Sketch(this, 40);

    this.buildKeys();

    this.levelText = this.hud.text(GAME_W / 2, 40, '', 24, COLORS.ink);
    this.scoreText = this.hud.text(GAME_W - 48, 40, '', 22, COLORS.ink, 'right');
    this.modeText = this.hud.text(PLAY_RECT.x + 8, 40, '', 18, COLORS.ink, 'left');
    this.modeText.setAlpha(0.55);
    this.hintText = this.hud.text(GAME_W / 2, GAME_H - 24, '', 16, COLORS.ink);
    this.hintText.setAlpha(0.55);
    this.skillLabel1 = this.hud.text(PLAY_RECT.x + 8, 61, '', 15, COLORS.ink, 'left');
    this.skillLabel1.setAlpha(0.8);
    this.skillLabel2 = this.hud.text(PLAY_RECT.x + PLAY_RECT.w - 8, 61, '', 15, COLORS.ink, 'right');
    this.skillLabel2.setAlpha(0.8);
    this.bannerText = this.hud.text(GAME_W / 2, GAME_H / 2, '', 64, COLORS.ink);
    this.bannerText.setAlpha(0);
    this.input.mouse?.disableContextMenu();

    this.score = 0;
    this.paused = false;
    this.autoDodge = settings.autoDodge;
    this.beginMatch();
    this.emitOverlay({ kind: 'hidden' });

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.lanClosed = true;
      this.lan?.close();
      this.lan = null;
      this.lanRole = null;
    });

    if (this.lanMode) this.connectLan();
  }

  // ------------------------------------------------------------------ LAN

  /** Opens the socket for the role chosen in the menu. */
  connectLan(): void {
    if (!this.lanMode) return;
    const role = settings.lanRole;
    this.lanRole = role;
    this.lan?.close();
    this.lanClosed = false;
    this.lan = new LanClient(role, settings.lanAddress, {
      onPeerSkill: (skill) => {
        if (!isSkillId(skill)) return;
        // The other player's choice always wins over our local guess.
        if (role === 'host') this.skillP2 = skill;
        else this.skillP1 = skill;
        this.showBanner(`对手技能：${skillById(skill).name}`, 1.2);
      },
      onStatus: (status, detail) => {
        // The socket can report after the scene is torn down (mode change, quit).
        if (this.lanClosed) return;
        if (status === 'waiting' || status === 'playing') this.announceRoom();
        if (status === 'waiting') this.netBanner = '等待对手加入…';
        else if (status === 'playing') this.netBanner = '';
        else if (status === 'error') this.netBanner = detail ?? '连接失败';
        else if (status === 'rejected') this.netBanner = detail ?? '版本不一致，无法联机';
        else if (status === 'closed') this.netBanner = '连接已断开';
        else if (status === 'connecting') this.netBanner = detail ?? '连接中…';
        if (this.netBanner) this.showBanner(this.netBanner, 1.6);
        this.modeText.setText(this.modeLabel());
      },
      onPeer: (state) => {
        this.showBanner(state === 'joined' ? '对手已加入！' : '对手离开了', 1.4);
        if (state === 'joined') {
          sound.ui();
          // A fresh opponent means a fresh match.
          if (role === 'host') {
            this.bullets = [];
            this.restartLanMatch();
          }
        }
      },
      onInput: (input) => {
        this.remoteInput = input;
      },
      onSnapshot: (snap) => this.applySnapshot(snap),
      onHostMessage: (msg) => {
        if (msg.t === 'restart' || msg.t === 'start') {
          if (typeof msg.level === 'number' && msg.level !== this.levelIndex) this.loadLevel(msg.level);
          else this.restartLanMatch();
        }
      },
    });
    this.lan.skill = role === 'host' ? this.skillP1 : this.skillP2;
    this.lan.connect();
  }

  /**
   * Host: ask the local server which LAN addresses it is reachable on and show
   * the result, so "what is my IP" is answered instead of asked.
   */
  private announceRoom(): void {
    if (this.roomUrl || this.lanRole !== 'host') return;
    void fetchLanInfo(settings.lanAddress).then((info) => {
      if (this.lanClosed || !info) return;
      const port = info.port ?? DEFAULT_LAN_PORT;
      const ip = (info.addresses ?? []).find((a) => !a.startsWith('127.'));
      if (!ip) return;
      this.roomUrl = `http://${ip}:${port}`;
      this.showBanner(`房间地址 ${ip}:${port}`, 3.2);
      this.modeText.setText(`${this.modeLabel()} · 房间 ${ip}:${port}`);
    });
  }

  private modeLabel(): string {
    if (this.lanMode) {
      const role = this.lanRole === 'host' ? '房主' : '访客';
      return `局域网 · ${role}`;
    }
    return this.versus ? '双人对战' : `单人 · ${preset().label}${this.autoDodge ? ' · 自动躲弹' : ''}`;
  }

  /** Host: reset the arena without touching the socket. */
  private restartLanMatch(): void {
    this.score = 0;
    this.bullets = [];
    this.particles = [];
    this.levelsCleared = 0;
    // Menu choices take effect on the next match.
    if (!this.lanMode || this.lanRole === 'host') this.skillP1 = settings.skillP1;
    this.skillP2 = settings.skillP2;
    this.loadLevel(this.startIndex);
    this.lan?.send({ t: 'restart', level: this.startIndex });
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
    const b = getBindings();
    const k = (code: number): string => keyLabel(code);
    const drive = (seat: SeatBindings): string =>
      `${k(seat.up)}${k(seat.left)}${k(seat.down)}${k(seat.right)}`;

    if (this.lanMode) {
      const seat = this.lanRole === 'host' ? b.lan.host : b.lan.guest;
      this.hintText.setText(
        `${this.lanRole === 'host' ? '房主' : '访客'}：${drive(seat)} 驾驶 · 鼠标瞄准 · ${k(seat.fire)} 开火 · ${k(seat.skill)} 技能 · ${k(seat.slow)} 慢速 · ${k(b.global.pause)} 暂停`
      );
    } else if (this.versus) {
      const a = b.versus.p1;
      const c = b.versus.p2;
      this.hintText.setText(
        `P1：${drive(a)} · ${k(a.fire)} 开火 · ${k(a.skill)} 技能        P2：${drive(c)} · ${k(c.fire)} 开火 · ${k(c.skill)} 技能        ${k(b.global.pause)} 暂停`
      );
    } else {
      const seat = b.solo;
      this.hintText.setText(
        `${drive(seat)} 驾驶 · 鼠标瞄准 · ${k(seat.fire)} 开火 · ${k(seat.slow)} 慢速 · ${k(seat.skill)} 技能 · ${k(b.global.autoDodge)} 自动躲弹 · ${k(b.global.pause)} 暂停`
      );
    }
    this.modeText.setText(this.modeLabel());
  }

  /** Skill chip under each side's hearts: name + cooldown. */
  private refreshSkillLabels(): void {
    const now = this.time.now;
    const paint = (label: Phaser.GameObjects.Text | undefined, tank: Tank | undefined, skill: SkillId): void => {
      if (!label) return;
      if (!tank) {
        if (label.text !== '') label.setText('');
        return;
      }
      const def = skillById(skill);
      const left = Math.max(0, tank.skillReadyAt - now);
      const text = left <= 0 ? `${def.name} · 就绪` : `${def.name} · ${(left / 1000).toFixed(1)}s`;
      if (label.text !== text) label.setText(text);
      label.setAlpha(left <= 0 ? 0.9 : 0.4);
    };

    if (this.lanMode && this.lanRole === 'guest') {
      paint(this.skillLabel1, undefined, this.skillP2);
      paint(this.skillLabel2, this.p2, this.skillP2);
    } else {
      paint(this.skillLabel1, this.p1, this.skillP1);
      paint(this.skillLabel2, this.p2, this.skillP2);
    }
  }

  /** Picks the map chosen in the menu ('random' rolls a fresh one) and starts. */
  private beginMatch(): void {
    const chosen = settings.mapId;
    this.startIndex = chosen === 'random' ? randomLevelIndex(-1) : levelIndexById(chosen);
    this.levelsCleared = 0;
    // Menu choices take effect on the next match.
    if (!this.lanMode || this.lanRole === 'host') this.skillP1 = settings.skillP1;
    this.skillP2 = settings.skillP2;
    this.loadLevel(this.startIndex);
  }

  private loadLevel(index: number): void {
    this.levelIndex = index;
    this.refreshHeaderText();
    const level = LEVELS[index];
    this.layout = buildLayout(level, PLAY_RECT);
    this.resetPickups(index);

    for (const tank of this.tanks()) tank.destroy();
    this.p2 = undefined;
    this.enemy = undefined;

    const d = preset();

    this.p1 = new Tank(this, this.layout.player.x, this.layout.player.y, this.layout.player.angle, 'p1', 20);
    this.p1.lives = this.versus ? VERSUS_LIVES : d.lives;
    this.p1.skillReadyAt = this.time.now + 1200;

    if (this.versus) {
      this.p2 = new Tank(this, this.layout.enemy.x, this.layout.enemy.y, this.layout.enemy.angle, 'p2', 22);
      this.p2.lives = VERSUS_LIVES;
      this.p2.skillReadyAt = this.time.now + 1200;
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
    // Leaving LAN mode must actually drop the socket, not leave it half-open.
    if (!this.lanMode && this.lan) {
      this.lan.close();
      this.lan = null;
      this.lanRole = null;
    }
    this.score = 0;
    this.bullets = [];
    this.particles = [];
    this.paused = false;
    this.autoDodge = settings.autoDodge;
    this.beginMatch();
    this.emitOverlay({ kind: 'hidden' });

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.lanClosed = true;
      this.lan?.close();
      this.lan = null;
      this.lanRole = null;
    });

    if (this.lanMode) this.connectLan();
  }

  /** Toggle the solo autopilot (menu checkbox or the G key). */
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

    const pauseKey = this.keys.get('global.pause')!;
    if (Phaser.Input.Keyboard.JustDown(pauseKey) || Phaser.Input.Keyboard.JustDown(this.keys.get('global.esc')!)) {
      this.togglePause();
    }
    const muteKey = this.keys.get('global.mute')!;
    if (muteKey && Phaser.Input.Keyboard.JustDown(muteKey)) {
      sound.setMuted(!sound.muted);
      this.showBanner(sound.muted ? '静音' : '开启声音', 0.8);
    }
    if (!this.versus) {
      const autoKey = this.keys.get('global.autoDodge');
      if (autoKey && Phaser.Input.Keyboard.JustDown(autoKey)) this.setAutoDodge(!this.autoDodge);
    }

    if (this.paused) {
      this.fx.clear();
      return;
    }

    if (this.hudDirty) this.drawHud();

    const guest = this.lanMode && this.lanRole === 'guest';

    if (this.phase === 'ready') {
      this.readyTimer -= dt;
      if (this.readyTimer <= 0) this.phase = 'playing';
    } else if (this.phase === 'playing' && !guest) {
      // Host / solo / local versus: simulate everything on this machine.
      const mouseAim = settings.mode !== 'versus';
      const slow = settings.mode === 'solo' && this.keyDown('p1', 'slow');
      this.applyInput(this.p1, this.readLocalInput(1, this.p1, dt, mouseAim), dt, { slow });
      if (this.p2) {
        if (this.lanMode) {
          this.applyInput(this.p2, this.remoteInput, dt, { aimRate: 22 });
          if (this.remoteInput.skill) {
            this.remoteInput.skill = false;
            this.useSkill(this.p2);
          }
        } else {
          this.applyInput(this.p2, this.readLocalInput(2, this.p2, dt, false), dt);
        }
      }
      if (this.enemy) this.updateAi(dt);
      this.updatePickups(dt);
    }

    if (guest) {
      this.updateGuest(dt);
    } else {
      this.updateBullets(dt);
      this.updateNetHost(dt);
    }
    this.updateParticles(dt);
    this.updatePhase(dt);
    this.drawFrame(time);
    this.refreshSkillLabels();
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
      this.levelsCleared += 1;
      if (this.levelsCleared < SOLO_CAMPAIGN_LENGTH) {
        this.loadLevel((this.levelIndex + 1) % LEVELS.length);
      } else {
        this.phase = 'victory';
        this.emitOverlay({ kind: 'victory', score: this.score });
        sound.win();
      }
    }
  }

  // ------------------------------------------------------------------ humans

  /** Reads this machine's keyboard/mouse for the given seat. */
  private readLocalInput(which: 1 | 2, tank: Tank, dt: number, mouseAim: boolean): TankInput {
    const prefix = which === 1 ? 'p1' : 'p2';

    let turn = (this.keyDown(prefix, 'right') ? 1 : 0) - (this.keyDown(prefix, 'left') ? 1 : 0);
    let drive = (this.keyDown(prefix, 'up') ? 1 : 0) - (this.keyDown(prefix, 'down') ? 1 : 0);

    // Solo: let the autopilot drive when the player isn't steering.
    const manual = turn !== 0 || drive !== 0;
    if (which === 1 && !this.versus && this.autoDodge && !manual) {
      const auto = this.autopilotMove(tank);
      turn = auto.turn;
      drive = auto.drive;
    }

    let aim: number;
    if (mouseAim) {
      const pointer = this.input.activePointer;
      const mx = pointer.worldX || GAME_W / 2;
      const my = pointer.worldY || GAME_H / 2;
      aim = Math.atan2(my - tank.y, mx - tank.x);
    } else {
      // Trim nudges the barrel around its mount; the mount follows the hull.
      const trim = (this.keyDown(prefix, 'aimRight') ? 1 : 0) - (this.keyDown(prefix, 'aimLeft') ? 1 : 0);
      aim = tank.bodyAngle + tank.turretOffset + trim * 1.9 * dt;
    }

    if (this.keyJustDown(prefix, 'skill')) this.useSkill(tank);

    const mouseFire = mouseAim && this.input.activePointer.leftButtonDown();
    const fire = this.keyDown(prefix, 'fire') || mouseFire;
    const slow = this.keyDown(prefix, 'slow');
    return { turn, drive, aim, fire, slow };
  }

  /** Applies one input frame to a tank – shared by local players and the guest. */
  private applyInput(tank: Tank, input: TankInput, dt: number, opts: { slow?: boolean; aimRate?: number } = {}): void {
    if (!tank.alive) return;

    const slow = opts.slow ?? input.slow ?? false;
    // The gun is bolted to the hull: turning the hull turns the barrel too.
    tank.turnHull(input.turn * TANK.turnRate * (slow ? 0.8 : 1) * dt);

    const mul = tank.speedMultiplier(this.time.now);
    const fwd = (slow ? TANK.tacticalSpeed : TANK.driveSpeed) * mul;
    const rev = (slow ? TANK.tacticalReverse : TANK.reverseSpeed) * mul;
    const speed = input.drive > 0 ? fwd : rev;
    const v = input.drive * speed;
    tank.vx = Math.cos(tank.bodyAngle) * v;
    tank.vy = Math.sin(tank.bodyAngle) * v;
    tank.x += tank.vx * dt;
    tank.y += tank.vy * dt;
    if (this.resolveTankWalls(tank)) {
      tank.vx *= 0.2;
      tank.vy *= 0.2;
    }

    if (Number.isFinite(input.aim)) {
      // aimAt() clamps the offset, so the barrel can never fly off the hull.
      tank.aimAt(input.aim, opts.aimRate ?? 16, dt);
      tank.turretAngle = tank.bodyAngle + tank.turretOffset;
    }

    this.separateTanks();

    const seat = tank.id === 'p2' ? 2 : 1;
    if (seat === 1) {
      this.fireCd1 -= dt;
      if (input.fire && this.fireCd1 <= 0) {
        this.fire(tank);
        this.fireCd1 = 0.24;
      }
    } else {
      this.fireCd2 -= dt;
      if (input.fire && this.fireCd2 <= 0) {
        this.fire(tank);
        this.fireCd2 = 0.24;
      }
    }
  }

  // ------------------------------------------------------------------ skills

  /** The skill this seat picked in the menu. */
  private skillFor(tank: Tank): SkillId {
    return tank.id === 'p2' ? this.skillP2 : this.skillP1;
  }

  /** Fires the summoner skill, if it is off cooldown. Host-authoritative. */
  useSkill(tank: Tank): boolean {
    if (!tank.alive || this.phase !== 'playing' && this.phase !== 'ready') return false;
    const def = skillById(this.skillFor(tank));
    if (this.time.now < tank.skillReadyAt) {
      sound.ping();
      return false;
    }
    tank.skillReadyAt = this.time.now + def.cooldown * 1000;
    this.netEvent('skill', tank.x, tank.y, { id: tank.id, color: def.color });

    switch (def.id) {
      case 'blink': {
        const from = { x: tank.x, y: tank.y };
        const dir = tank.turretAngle;
        let best = 0;
        for (let d = 10; d <= 170; d += 8) {
          const nx = tank.x + Math.cos(dir) * d;
          const ny = tank.y + Math.sin(dir) * d;
          if (this.spotBlocked(nx, ny, tank.radius + 2, tank)) break;
          best = d;
        }
        if (best > 0) {
          tank.x += Math.cos(dir) * best;
          tank.y += Math.sin(dir) * best;
          this.puff(from.x, from.y, def.color, 10);
          this.puff(tank.x, tank.y, def.color, 10);
          this.ring(tank.x, tank.y, def.color);
          this.netEvent('blink', from.x, from.y, { id: tank.id, color: def.color });
        }
        break;
      }
      case 'invincible':
        tank.invulnerableUntil = Math.max(tank.invulnerableUntil, this.time.now + def.duration * 1000);
        this.ring(tank.x, tank.y, def.color);
        break;
      case 'rage':
        tank.rageUntil = Math.max(tank.rageUntil, this.time.now + def.duration * 1000);
        tank.rageShots = Math.max(tank.rageShots, RAGE_SHOTS);
        this.puff(tank.x, tank.y, def.color, 12);
        break;
      case 'weaken': {
        const other = this.tanks().find((t) => t !== tank && t.id !== 'enemy');
        if (other) {
          other.slowUntil = Math.max(other.slowUntil, this.time.now + def.duration * 1000);
          this.ring(other.x, other.y, def.color);
          this.netEvent('skill', other.x, other.y, { id: other.id, color: def.color });
        }
        break;
      }
    }

    this.showBanner(`${tank.id === 'p1' ? 'P1' : tank.id === 'p2' ? 'P2' : 'CPU'} · ${def.name}`, 0.9);
    sound.ui();
    this.hudDirty = true;
    return true;
  }

  /** Free-space test used by blink and by pickup placement. */
  private spotBlocked(x: number, y: number, radius: number, ignore?: Tank): boolean {
    if (this.layout.walls.some((box) => circleBox(x, y, radius, box))) return true;
    if (this.crates.some((c) => c.alive && circleBox(x, y, radius, c.box))) return true;
    return this.tanks().some(
      (t) => t !== ignore && t.alive && Math.hypot(t.x - x, t.y - y) < radius + t.radius
    );
  }

  // ------------------------------------------------------------------ pickups

  private resetPickups(levelIndex: number): void {
    const spots = LEVELS[levelIndex]?.pickups ?? [];
    this.pickups = spots.map((p) =>
      makePickup(
        rollPickupKind(),
        this.layout.rect.x + p.x * this.layout.rect.w,
        this.layout.rect.y + p.y * this.layout.rect.h
      )
    );
    for (const p of this.pickups) p.pop = 0;
  }

  /** Touching a pickup always applies it – there is no way to refuse. */
  private updatePickups(dt: number): void {
    for (const p of this.pickups) {
      if (p.respawn > 0) {
        p.respawn = Math.max(0, p.respawn - dt);
        if (p.respawn === 0) {
          p.kind = rollPickupKind();
          p.pop = 0;
        }
        continue;
      }
      p.pop = Math.min(1, p.pop + dt * 4);
      for (const tank of this.tanks()) {
        if (!tank.alive) continue;
        if (Math.hypot(tank.x - p.x, tank.y - p.y) > tank.radius + PICKUP_RADIUS) continue;
        this.collectPickup(tank, p);
        break;
      }
    }
  }

  private collectPickup(tank: Tank, p: Pickup): void {
    const def = PICKUPS[p.kind];
    const now = this.time.now;

    if (p.kind === 'health') {
      tank.lives = Math.min(this.maxLives(tank), tank.lives + 1);
      tank.damage = Math.max(0, tank.damage - 1);
      tank.redraw();
    } else if (p.kind === 'speed') {
      tank.speedUntil = Math.max(tank.speedUntil, now + def.duration * 1000);
    } else {
      tank.shieldUntil = Math.max(tank.shieldUntil, now + def.duration * 1000);
    }

    p.respawn = PICKUP_RESPAWN;
    p.pop = 0;
    this.hudDirty = true;
    this.puff(p.x, p.y, def.color, 12);
    this.ring(p.x, p.y, def.color);
    this.netEvent('pickup', p.x, p.y, { id: tank.id, color: def.color });
    sound.pickup();
    this.showBanner(
      `${tank.id === 'p1' ? 'P1' : tank.id === 'p2' ? 'P2' : 'CPU'} 吃到 ${def.name}`,
      0.85
    );
  }

  private maxLives(tank: Tank): number {
    if (this.versus) return VERSUS_LIVES;
    return tank.id === 'p1' ? preset().lives : preset().enemyLives;
  }

  /** Guest: the whole match lives on the host, we only read input here. */
  private readGuestInput(dt: number): TankInput {
    const prefix = 'guest';
    const pointer = this.input.activePointer;
    const tank = this.p2;
    const aim = tank ? Math.atan2((pointer.worldY || 0) - tank.y, (pointer.worldX || 0) - tank.x) : 0;
    const trim = (this.keyDown(prefix, 'aimRight') ? 1 : 0) - (this.keyDown(prefix, 'aimLeft') ? 1 : 0);
    if (this.keyJustDown(prefix, 'skill')) this.guestSkillLatch = true;
    const skill = this.guestSkillLatch;
    // Without the mouse the guest still gets trim keys to swing the barrel.
    const useMouse = Math.abs(pointer.worldX) > 0 || Math.abs(pointer.worldY) > 0;
    const worldAim = useMouse && tank ? aim : (tank?.turretAngle ?? 0) + trim * 1.9 * dt;
    return {
      turn: (this.keyDown(prefix, 'right') ? 1 : 0) - (this.keyDown(prefix, 'left') ? 1 : 0),
      drive: (this.keyDown(prefix, 'up') ? 1 : 0) - (this.keyDown(prefix, 'down') ? 1 : 0),
      aim: worldAim,
      fire: this.keyDown(prefix, 'fire') || pointer.leftButtonDown(),
      slow: this.keyDown(prefix, 'slow'),
      skill,
    };
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
    tank.turretOffset = 0;
    tank.turretAngle = spawn.angle;
    tank.clearEffects();
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

    // A barrel pushed into a wall used to spawn the shell on the far side of it.
    // Clamp the muzzle to the first solid surface instead, so the shot either
    // bounces off immediately or simply cannot be taken.
    const limit = this.muzzleLimit(tank.x, tank.y, dir, Math.max(len, 46));
    len = Math.min(len, Math.max(0, limit - BULLET.radius - 1.5));
    if (len < 6) {
      // Hull is right against the wall and pointing into it: dry click, no ghost shell.
      sound.ping();
      return;
    }

    const m = tank.muzzle(len, dir);
    const empowered = tank.rageShots > 0;
    if (empowered) tank.rageShots -= 1;
    this.spawnBullet(m.x, m.y, dir, tank.id, speed, maxBounces, empowered ? 2 : 1);
    this.burst(m.x, m.y, dir, tank.id);
    this.netEvent('fire', m.x, m.y, { id: tank.id });
    this.cameras.main.shake(60, 0.002);
    if (tank.id === 'enemy') sound.enemyFire();
    else sound.fire();

    tank.x -= Math.cos(dir) * 1.4;
    tank.y -= Math.sin(dir) * 1.4;
    this.resolveTankWalls(tank);
  }

  /** Distance from (x,y) along `dir` until a wall or crate stops a shell. */
  private muzzleLimit(x: number, y: number, dir: number, max: number): number {
    const dx = Math.cos(dir) * max;
    const dy = Math.sin(dir) * max;
    const r = BULLET.radius + 0.5;
    let best = max;
    const wallHit = sweepCircleBox(x, y, r, dx, dy, this.layout.walls);
    if (wallHit) best = Math.min(best, max - wallHit.remaining);
    const crateBoxes = this.crates.filter((c) => c.alive).map((c) => c.box);
    const crateHit = sweepCircleBox(x, y, r, dx, dy, crateBoxes);
    if (crateHit) best = Math.min(best, max - crateHit.remaining);
    return best;
  }

  private spawnBullet(
    x: number,
    y: number,
    dir: number,
    owner: TankId,
    speed: number,
    maxBounces: number,
    dmg = 1
  ): void {
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
      dmg,
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
    // The AI obeys the same hull-mounted gun as the player: if the target is
    // outside the arc it swings the hull round instead of shooting sideways.
    if (Math.abs(Phaser.Math.Angle.Wrap(want - e.bodyAngle)) > TURRET_LIMIT - 0.12) {
      const st = steerTo(want, e.bodyAngle);
      e.turnHull(st.turn * TANK.turnRate * 0.85 * dt);
    }
    e.aimAt(want, this.aiCharge > 0 ? 7 : 2.4, dt);

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
          this.netEvent('bounce', ev.x, ev.y, { color: b.color });
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
          if (victim) this.damage(victim, b.owner, b.dmg);
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

  private damage(victim: Tank, attacker: TankId, amount = 1): void {
    if (!victim.alive || this.phase !== 'playing') return;
    if (victim.shielded()) {
      // Shield / invulnerability: absorb the hit with a visible, audible block.
      this.ring(victim.x, victim.y, PICKUPS.shield.color);
      this.puff(victim.x, victim.y, PICKUPS.shield.color, 5);
      this.netEvent('hit', victim.x, victim.y, { id: victim.id, color: PICKUPS.shield.color });
      sound.ping();
      return;
    }

    const self = attacker === victim.id;
    victim.lives = Math.max(0, victim.lives - amount);
    victim.damage += 1;
    victim.redraw();
    this.hudDirty = true;

    if (!this.versus && victim.id !== 'p1') this.score += 150;

    this.cameras.main.shake(self ? 150 : 120, self ? 0.006 : 0.004);
    this.cameras.main.flash(90, 220, 200, 170);
    this.puff(victim.x, victim.y, victim.color, 10);
    this.ring(victim.x, victim.y, victim.color);
    this.netEvent('hit', victim.x, victim.y, { id: victim.id, color: victim.color });
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
    this.netEvent('crate', x, y);
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
    this.netEvent('explode', x, y, { color });
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

  // ------------------------------------------------------------------ network I/O

  /** Host: push a state snapshot to the guest at 30Hz. */
  private updateNetHost(dt: number): void {
    if (!this.lanMode || this.lanRole !== 'host' || !this.lan) return;
    this.netTimer -= dt;
    if (this.netTimer > 0) return;
    this.netTimer = 1 / 30;
    this.lan.sendSnapshot(this.buildSnapshot());
  }

  private buildSnapshot(): Snapshot {
    this.netSeq += 1;
    const events = this.netEvents;
    this.netEvents = [];
    return {
      t: 'state',
      seq: this.netSeq,
      level: this.levelIndex,
      phase: this.phase,
      score: this.score,
      crates: this.crates.map((c) => (c.alive ? 1 : 0)),
      tanks: [this.p1, this.p2]
        .filter((t): t is Tank => !!t)
        .map((t) => {
          const left = (until: number): number => Math.max(0, Math.round(until - this.time.now));
          return {
            id: t.id === 'p2' ? 'p2' : ('p1' as const),
            x: Math.round(t.x * 10) / 10,
            y: Math.round(t.y * 10) / 10,
            body: Math.round(t.bodyAngle * 100) / 100,
            turret: Math.round(t.turretAngle * 100) / 100,
            lives: t.lives,
            damage: t.damage,
            alive: t.alive ? 1 : 0,
            shield: left(t.shieldUntil),
            speed: left(t.speedUntil),
            rage: left(t.rageUntil),
            slow: left(t.slowUntil),
            rageShots: t.rageShots,
            skillCd: left(t.skillReadyAt),
          };
        }),
      bullets: this.bullets.map((b) => ({
        x: Math.round(b.x * 10) / 10,
        y: Math.round(b.y * 10) / 10,
        vx: Math.round(b.vx),
        vy: Math.round(b.vy),
        owner: b.owner === 'p2' ? 'p2' : 'p1',
        dmg: b.dmg,
      })),
      pickups: this.pickups.map((p) => ({
        kind: p.kind,
        respawn: Math.round(p.respawn * 10) / 10,
      })),
      events,
    };
  }

  /** Records an effect that the guest should also see/hear. */
  private netEvent(kind: NetEvent['k'], x: number, y: number, extra: Partial<NetEvent> = {}): void {
    if (!this.lanMode || this.lanRole !== 'host') return;
    if (this.netEvents.length > 40) return;
    this.netEvents.push({ k: kind, x: Math.round(x), y: Math.round(y), ...extra });
  }

  /** Guest: send our input and keep the arena alive from snapshots. */
  private updateGuest(dt: number): void {
    this.netTimer -= dt;
    if (this.netTimer <= 0) {
      this.netTimer = 1 / 30;
      this.lan?.sendInput(this.readGuestInput(dt));
      this.guestSkillLatch = false;
    }

    const snap = this.snap;
    if (!snap) return;
    const age = Math.min(0.12, (this.time.now - this.snapAt) / 1000);

    // Tanks: smooth towards the authoritative transform.
    const lerp = Math.min(1, dt * 18);
    for (const st of snap.tanks) {
      const tank = st.id === 'p1' ? this.p1 : this.p2;
      if (!tank) continue;
      tank.x += (st.x - tank.x) * lerp;
      tank.y += (st.y - tank.y) * lerp;
      tank.bodyAngle = angleLerp(tank.bodyAngle, st.body, lerp);
      tank.turretAngle = angleLerp(tank.turretAngle, st.turret, lerp);
      tank.syncTurret();
      const now = this.time.now;
      tank.shieldUntil = now + st.shield;
      tank.speedUntil = now + st.speed;
      tank.rageUntil = now + st.rage;
      tank.slowUntil = now + st.slow;
      tank.rageShots = st.rageShots;
      tank.skillReadyAt = now + st.skillCd;
      tank.lives = st.lives;
      if (tank.damage !== st.damage) {
        tank.damage = st.damage;
        tank.redraw();
      }
      if ((st.alive === 1) !== tank.alive) tank.setAlive(st.alive === 1, this.time.now);
    }

    // Shells: draw from the snapshot, extrapolated by its age.
    this.bullets = snap.bullets.map((b) => ({
      x: b.x + b.vx * age,
      y: b.y + b.vy * age,
      vx: b.vx,
      vy: b.vy,
      owner: b.owner === 'p2' ? ('p2' as const) : ('p1' as const),
      color: b.owner === 'p2' ? COLORS.player2 : COLORS.player,
      bounces: 0,
      maxBounces: BULLET.maxBounces,
      life: BULLET.lifetime,
      dead: false,
      dmg: b.dmg ?? 1,
      trail: [],
    }));

    if (this.score !== snap.score) {
      this.score = snap.score;
      this.hudDirty = true;
    }
    if (snap.phase !== this.phase && (snap.phase === 'versusOver' || snap.phase === 'playing')) {
      this.phase = snap.phase as Phase;
      this.hudDirty = true;
    }
  }

  /** Guest: adopt a snapshot, replaying effects and syncing the level. */
  private applySnapshot(snap: Snapshot): void {
    this.snap = snap;
    this.snapAt = this.time.now;

    if (snap.level !== this.levelIndex) {
      // Level changed on the host – rebuild the arena locally.
      const keepLives = { p1: this.p1?.lives ?? VERSUS_LIVES, p2: this.p2?.lives ?? VERSUS_LIVES };
      this.levelIndex = snap.level;
      this.layout = buildLayout(LEVELS[snap.level], PLAY_RECT);
      const level = LEVELS[snap.level];
      this.p1.destroy();
      this.p2?.destroy();
      this.p1 = new Tank(this, this.layout.player.x, this.layout.player.y, this.layout.player.angle, 'p1', 20);
      this.p2 = new Tank(this, this.layout.enemy.x, this.layout.enemy.y, this.layout.enemy.angle, 'p2', 22);
      this.p1.lives = keepLives.p1;
      this.p2.lives = keepLives.p2;
      this.crates = this.layout.crates.map((box) => ({ box, alive: true }));
      this.resetPickups(snap.level);
      this.particles = [];
      this.bullets = [];
      this.drawTerrain();
      this.drawCrates();
      this.hudDirty = true;
      this.levelText.setText(level.name);
      this.showBanner(level.name, 1.2);
    }

    // Crates.
    let cratesChanged = false;
    snap.crates.forEach((alive, i) => {
      const crate = this.crates[i];
      if (crate && crate.alive !== (alive === 1)) {
        crate.alive = alive === 1;
        cratesChanged = true;
      }
    });
    if (cratesChanged) this.drawCrates();

    // Pickups: the host owns their kinds and respawn timers.
    if (snap.pickups) {
      snap.pickups.forEach((sp, i) => {
        const local = this.pickups[i];
        if (!local) return;
        if (local.kind !== sp.kind) local.kind = sp.kind;
        local.respawn = sp.respawn;
        if (sp.respawn === 0 && local.pop < 1) local.pop = Math.min(1, local.pop + 0.15);
      });
    }

    // Effects.
    for (const ev of snap.events) {
      if (ev.k === 'fire') {
        this.burst(ev.x, ev.y, Math.atan2(0, 1), ev.id === 'p2' ? 'p2' : 'p1');
        sound.fire();
      } else if (ev.k === 'hit') {
        this.puff(ev.x, ev.y, ev.color ?? COLORS.danger, 8);
        this.ring(ev.x, ev.y, ev.color ?? COLORS.danger);
        this.cameras.main.shake(100, 0.004);
        sound.hit();
      } else if (ev.k === 'bounce') {
        this.impactSpark(ev.x, ev.y, 1, 0, ev.color ?? COLORS.player);
        if (this.time.now - this.lastBounceSound > 45) {
          this.lastBounceSound = this.time.now;
          sound.bounce();
        }
      } else if (ev.k === 'explode') {
        this.explode(ev.x, ev.y, ev.color ?? COLORS.enemy);
      } else if (ev.k === 'crate') {
        this.puff(ev.x, ev.y, COLORS.crate, 10);
      } else if (ev.k === 'pickup') {
        this.puff(ev.x, ev.y, ev.color ?? COLORS.player, 10);
        this.ring(ev.x, ev.y, ev.color ?? COLORS.player);
        sound.pickup();
      } else if (ev.k === 'skill') {
        this.ring(ev.x, ev.y, ev.color ?? COLORS.enemy);
        this.puff(ev.x, ev.y, ev.color ?? COLORS.enemy, 8);
      } else if (ev.k === 'blink') {
        this.puff(ev.x, ev.y, ev.color ?? COLORS.player, 10);
      }
    }
  }

  private drawFrame(time: number): void {
    const g = this.fx;
    g.clear();

    if (this.phase === 'playing' || this.phase === 'ready') {
      if (this.lanMode) {
        const mine = this.lanRole === 'guest' ? this.p2 : this.p1;
        if (mine?.alive) this.drawAimGuide(g, mine, this.lanRole === 'guest' ? COLORS.player2 : COLORS.player, 0.5);
      } else if (!this.versus && this.p1.alive) {
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

    // ---- pickups
    for (const p of this.pickups) {
      const def = PICKUPS[p.kind];
      if (p.respawn > 0) {
        // Faint outline + countdown ring so you can plan the next grab.
        g.lineStyle(1.4, COLORS.ink, 0.14);
        g.strokeCircle(p.x, p.y, PICKUP_RADIUS);
        const k = 1 - p.respawn / PICKUP_RESPAWN;
        g.lineStyle(2, def.color, 0.35);
        g.beginPath();
        g.arc(p.x, p.y, PICKUP_RADIUS + 4, -Math.PI / 2, -Math.PI / 2 + k * Math.PI * 2);
        g.strokePath();
        continue;
      }
      const bob = Math.sin(time / 320 + p.x * 0.05) * 2;
      const scale = 0.7 + 0.3 * p.pop;
      const r = PICKUP_RADIUS * scale;
      g.fillStyle(COLORS.white, 0.72);
      g.fillCircle(p.x, p.y + bob, r);
      g.lineStyle(2.4, def.color, 0.9);
      g.strokeCircle(p.x, p.y + bob, r);
      g.lineStyle(1.4, COLORS.ink, 0.35);
      g.strokeCircle(p.x, p.y + bob, r + 4);
      if (p.kind === 'health') {
        g.lineStyle(3.2, def.color, 0.95);
        g.beginPath();
        g.moveTo(p.x - r * 0.45, p.y + bob);
        g.lineTo(p.x + r * 0.45, p.y + bob);
        g.moveTo(p.x, p.y + bob - r * 0.45);
        g.lineTo(p.x, p.y + bob + r * 0.45);
        g.strokePath();
      } else if (p.kind === 'speed') {
        g.lineStyle(2.4, def.color, 0.95);
        for (const dx of [-4, 3]) {
          g.beginPath();
          g.moveTo(p.x + dx, p.y + bob - 5);
          g.lineTo(p.x + dx + 5, p.y + bob);
          g.lineTo(p.x + dx, p.y + bob + 5);
          g.strokePath();
        }
      } else {
        g.lineStyle(2.2, def.color, 0.95);
        g.beginPath();
        g.moveTo(p.x, p.y + bob - 6);
        g.lineTo(p.x + 6, p.y + bob - 2);
        g.lineTo(p.x + 6, p.y + bob + 2);
        g.lineTo(p.x, p.y + bob + 7);
        g.lineTo(p.x - 6, p.y + bob + 2);
        g.lineTo(p.x - 6, p.y + bob - 2);
        g.closePath();
        g.strokePath();
      }
    }

    // ---- effect auras around tanks
    const now = this.time.now;
    for (const tank of this.tanks()) {
      if (!tank.alive) continue;
      const pulse = 1 + Math.sin(time / 180) * 0.04;
      if (now < tank.shieldUntil) {
        g.lineStyle(2.6, PICKUPS.shield.color, 0.75);
        g.strokeCircle(tank.x, tank.y, 31 * pulse);
        g.lineStyle(1.2, PICKUPS.shield.color, 0.35);
        g.strokeCircle(tank.x, tank.y, 36 * pulse);
      } else if (now < tank.invulnerableUntil) {
        g.lineStyle(2.2, 0xd4a72e, 0.6);
        g.strokeCircle(tank.x, tank.y, 30 * pulse);
      }
      if (now < tank.rageUntil) {
        g.lineStyle(2.4, COLORS.enemy, 0.55);
        g.strokeCircle(tank.x, tank.y, 33 * pulse);
      }
      if (now < tank.slowUntil) {
        const r = 40 - (time / 40) % 10;
        g.lineStyle(1.8, COLORS.player2, 0.5);
        g.strokeCircle(tank.x, tank.y, r);
      }
      if (now < tank.speedUntil) {
        g.lineStyle(2, COLORS.player, 0.5);
        for (const s of [-1, 1]) {
          g.beginPath();
          g.moveTo(tank.x - 26, tank.y + s * 8);
          g.lineTo(tank.x - 34, tank.y + s * 8);
          g.strokePath();
        }
      }
    }

    for (const b of this.bullets) {
      for (let i = 0; i < b.trail.length; i++) {
        const t = b.trail[i];
        g.fillStyle(b.color, (i / b.trail.length) * 0.35);
        g.fillCircle(t.x, t.y, BULLET.radius * (0.35 + (i / b.trail.length) * 0.7));
      }
      g.fillStyle(COLORS.ink, 0.85);
      g.fillCircle(b.x, b.y, BULLET.radius + 1.6);
      g.fillStyle(b.dmg > 1 ? COLORS.enemy : b.color, 1);
      g.fillCircle(b.x, b.y, BULLET.radius * (b.dmg > 1 ? 1.35 : 1));
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

/** Shortest-path angle interpolation, used to smooth networked tanks. */
function angleLerp(current: number, target: number, t: number): number {
  const diff = Phaser.Math.Angle.Wrap(target - current);
  return current + diff * Math.min(1, Math.max(0, t));
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
