import Phaser from 'phaser';
import { planRicochetShot, type ShotPlan } from '../engine/ai';
import { advanceBullet, type BulletTarget } from '../engine/bullet';
import { buildLayout, type Layout, type PlayRect } from '../engine/level';
import { isCustomLevel, levelById, levelIndexOf, levels, randomLevelIndex } from '../maps/registry';
import { getMap } from '../maps/store';
import { mapHash } from '../maps/format';
import { circleBox, reflect, sweepCircleBox, type Box } from '../engine/physics';
import { bulletThreatAt, pickHeading, steerTo, type ThreatBullet } from '../engine/steer';
import { BULLET, COLORS, FONT, GAME_H, GAME_W, TANK } from './config';
import { MAX_HP } from './rules';
import { heatCfg, heatRatio, lockSecondsLeft, shotsToOverheat } from './heat';
import { setTuning, tuning, tuningDiff, tuningIsCustom } from './tuning';
import { MATCH_LEFT_EVENT, OVERLAY_EVENT, type OverlayState } from './events';
import { Sketch } from './Sketch';
import { seatColor, Tank, teamColor, TURRET_LIMIT, type TankId } from './Tank';
import { getBindings, keyLabel, SEAT_ACTIONS, type SeatAction, type SeatBindings } from './keybinds';
import { makePickup, PICKUPS, PICKUP_RADIUS, rollPickupKind, type Pickup } from './pickups';
import { isSkillId, RAGE_SHOTS, skillById, type SkillId } from './skills';
import { makeTextures, paperBackground } from './art';
import { sound } from './Sound';
import { preset, settings, VERSUS_HP, type DifficultyPreset } from './settings';
import {
  canDamage,
  chooseRespawn,
  evaluateMatch,
  hitZone,
  matchHasEnder,
  type HitZone,
  type MatchResult,
  type RespawnCandidate,
  type ScoreLine,
} from './rules';
import { fetchLanInfo, LanClient } from '../net/LanClient';
import { DEFAULT_LAN_PORT } from '../net/protocol';
import type { NetEvent, Snapshot, TankInput, TankSnapshot } from '../net/protocol';

/** Drawing area, leaving room for the sketch HUD at the top and hints below. */
/** Arenas per solo run. */
const SOLO_CAMPAIGN_LENGTH = 5;

const IDLE_INPUT: TankInput = { turn: 0, drive: 0, aim: 0, fire: false };

const PLAY_RECT: PlayRect = { x: 34, y: 82, w: GAME_W - 68, h: GAME_H - 82 - 46 };

/**
 * Every field a tank snapshot may carry, in one place so the diff cannot forget
 * one. `id` is always sent; the rest are optional (v1.5.3 deltas).
 */
const TANK_WIRE_KEYS = [
  'x', 'y', 'body', 'turret', 'hp', 'kills', 'deaths', 'team', 'damage', 'alive',
  'shield', 'speed', 'rage', 'slow', 'rageShots', 'skillCd', 'heat', 'heatLocked',
] as const;

type Phase = 'lobby' | 'ready' | 'playing' | 'dying' | 'cleared' | 'over' | 'victory' | 'versusOver' | 'matchOver' | 'leaving';

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

/** Square rotated 45°, the "enemy" marker on the minimap and its legend. */
function diamond(cx: number, cy: number, r: number): { x: number; y: number }[] {
  return [
    { x: cx, y: cy - r },
    { x: cx + r, y: cy },
    { x: cx, y: cy + r },
    { x: cx - r, y: cy },
  ];
}

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
  /** Corner message lines (newest at the bottom). Replaces the old centre banner. */
  private toastTexts: Phaser.GameObjects.Text[] = [];
  private toasts: { text: string; life: number; total: number }[] = [];
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
  private heatText?: Phaser.GameObjects.Text;
  /** Reused HUD texts, keyed by slot, so redraws do not leak objects. */
  private cachedTexts = new Map<string, Phaser.GameObjects.Text>();
  /** Screen-pinned minimap layer. */
  private minimap!: Phaser.GameObjects.Graphics;
  /** How many health rows were drawn last frame, so extras can be cleared. */
  private hpRowCount = 0;
  private heatSig = '';
  /** Corner chip: your own skill name, its cooldown and a fill bar. */
  private skillChip?: Phaser.GameObjects.Graphics;
  private skillChipTexts: Phaser.GameObjects.Text[] = [];


  // Input: one Phaser Key per bound action, keyed by "<prefix>.<action>".
  private keys = new Map<string, Phaser.Input.Keyboard.Key>();
  /**
   * v1.5.3: the key codes this scene asked the browser to swallow. While a text
   * field / slider / select has focus they are handed back, otherwise typing a
   * password or a map name into the pause menu ate every W, A, S and D.
   */
  private capturedCodes: number[] = [];
  private captureReleased = false;

  /**
   * Trigger cooldown, per tank.
   *
   * v1.5.1: this used to be two shared numbers (`fireCd1` for p1 and *every*
   * seat from p3 up, `fireCd2` for p2), so in a room of four the whole group
   * drained one cooldown together: the first seat in the list fired at N× the
   * intended rate and everybody behind it never got a shot off.
   */
  private fireCd = new Map<string, number>();

  // ---- LAN
  private lan: LanClient | null = null;
  private lanRole: 'host' | 'guest' | null = null;
  /** Set on shutdown so late socket callbacks never touch a dead scene. */
  private lanClosed = false;
  private remoteInput: TankInput = { turn: 0, drive: 0, aim: 0, fire: false };
  private netEvents: NetEvent[] = [];
  private netTimer = 0;
  private netSeq = 0;
  /** v1.5.3 delta snapshots: force a full one, and what was last sent. */
  private netKeyframe = true;
  /** Guest side: the merged per-seat state the last snapshot described. */
  private tankWire = new Map<string, Record<string, number>>();
  private netLast = {
    level: -1,
    phase: '',
    elapsed: -1,
    score: -1,
    crates: '',
    pickups: '',
    tanks: new Map<string, Record<string, number>>(),
  };
  private snap: Snapshot | null = null;
  private snapAt = 0;
  private netBanner = '';
  /** Address the host should hand to the guest, discovered from the server. */
  private roomUrl = '';
  /** Latched so a skill press is never lost between 30 Hz packets. */
  private guestSkillLatch = false;
  /** The custom map this host is pushing into the room ('' = a built-in). */
  private roomMapId = '';
  /** The room's advertised level id: built-in id, `custom-…`, or 'random'. */
  private roomLevelId = '';
  /** Guest view: the room's map has been stored and confirmed. */
  private mapConfirmed = false;
  /** Host view: seats that still owe a map confirmation. */
  private mapWaiting: string[] = [];
  private mapReady: string[] = [];
  /** Last lobby state, so a map confirmation can repaint without a rebuild. */
  private lastLobby: { mode: 'ffa' | 'team'; host: string | null } | null = null;
  /** LAN: tanks waiting for their respawn, keyed by seat id (ms timestamp). */
  private respawnQueue = new Map<string, number>();
  /**
   * A seat that just vanished: we give it a few seconds to reconnect (the
   * server keeps its seat for two minutes) before calling it a surrender.
   */
  private leftSeat: { id: string; at: number } | null = null;
  /** Seats that really left this match (so a second notice is not repeated). */
  private goneSeats = new Set<string>();
  /** Host: a start was requested while guests were still confirming the map. */
  private startPending = false;
  /** Host: hash of the map currently cached in the room (avoids re-pushing). */
  private pushedMapHash = '';
  /** Which room this socket belongs to (`role@address`), so a rematch keeps it. */
  private lanTarget = '';
  /** Set once the player asked to leave: the scene must stop touching the DOM. */
  private leaving = false;

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

    // Capture is what stops the page from scrolling on arrows / space, but it
    // also means `preventDefault` on WASD — so it has to follow the focus.
    this.capturedCodes = [...new Set([...this.keys.values()].map((key) => key.keyCode))];
    this.captureReleased = false;
    this.syncKeyCapture();
  }

  /** True while the player is typing into a DOM field instead of driving. */
  private static typingInDom(): boolean {
    const active = globalThis.document?.activeElement as HTMLElement | null;
    if (!active) return false;
    const tag = active.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || active.isContentEditable;
  }

  /**
   * Hands the keyboard back to the DOM while a field has focus, and takes it
   * again afterwards. Called every frame: `document.activeElement` is cheap and
   * covers clicks, Tab and programmatic focus without extra listeners.
   */
  private syncKeyCapture(): void {
    const keyboard = this.input?.keyboard;
    if (!keyboard) return;
    const typing = GameScene.typingInDom();
    if (typing === this.captureReleased) return;
    this.captureReleased = typing;
    if (typing) keyboard.removeCapture(this.capturedCodes);
    else {
      keyboard.addCapture(this.capturedCodes);
      // A key held down when the field lost focus must not stay "pressed".
      for (const key of this.keys.values()) key.reset();
    }
  }

  private keyDown(prefix: string, action: SeatAction): boolean {
    // Typing in a DOM field is not driving: WASD belongs to the field.
    if (this.captureReleased) return false;
    return this.keys.get(`${prefix}.${action}`)?.isDown ?? false;
  }

  private keyJustDown(prefix: string, action: SeatAction): boolean {
    if (this.captureReleased) return false;
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
    // The minimap is redrawn every frame and must not scroll with the camera.
    this.minimap = this.add.graphics().setDepth(41).setScrollFactor(0);

    this.buildKeys();

    // ---- top bar, three columns: left = you, middle = match, right = them.
    this.levelText = this.hud.text(GAME_W / 2, 16, '', 18, COLORS.ink);
    this.scoreText = this.hud.text(GAME_W / 2, 56, '', 20, COLORS.ink);
    this.modeText = this.hud.text(GAME_W / 2, 36, '', 13, COLORS.ink);
    this.modeText.setAlpha(0.55);
    this.hintText = this.hud.text(GAME_W / 2, GAME_H - 18, '', 13, COLORS.ink);
    this.hintText.setAlpha(0.45);
    // The skill chip is its own layer: the HUD redraws only when something
    // changed, but a cooldown counts down every frame.
    this.skillChip = this.add.graphics().setDepth(42).setScrollFactor(0);
    this.skillChipTexts = [];
    this.input.mouse?.disableContextMenu();

    this.score = 0;
    this.paused = false;
    // A scene instance is reused when main.ts restarts it, so every latch that
    // ends a session has to start clean here.
    this.leaving = false;
    this.matchOver = false;
    this.matchElapsed = 0;
    this.startPending = false;
    this.pushedMapHash = '';
    this.respawnQueue.clear();
    this.lanClosed = false;
    this.autoDodge = settings.autoDodge;
    this.beginMatch();
    // A host restart has to reach every guest explicitly: the guest keeps its
    // socket, so nothing else would ever tell it the match was reset.
    if (this.lanMode && this.lanRole === 'host') {
      this.lan?.send({ t: 'restart', level: this.startIndex, levelId: levels()[this.startIndex]?.id });
    }
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
    this.lanTarget = `${role}@${settings.lanAddress}`;
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
        // Mid-match a single seat leaving flips the socket back to 'waiting':
        // that must not replace the "<name> 退出了游戏" banner or the HUD text.
        const midMatch = this.phase === 'playing' || this.phase === 'ready';
        if (status === 'waiting') this.netBanner = midMatch ? '' : '等待对手加入…';
        else if (status === 'playing') this.netBanner = '';
        else if (status === 'error') this.netBanner = detail ?? '连接失败';
        else if (status === 'rejected') this.netBanner = detail ?? '版本不一致，无法联机';
        else if (status === 'closed') this.netBanner = '连接已断开';
        else if (status === 'connecting') this.netBanner = detail ?? '连接中…';
        if (this.netBanner) this.showBanner(this.netBanner, 1.6);
        this.modeText.setText(this.modeLabel());
      },
      onSurrender: (by) => this.seatLeft(by),
      onPeer: (state, id) => {
        // A departure is announced by `seatLeft()` with the seat's name; a
        // nameless "对手离开了" here would just overwrite that message.
        if (state === 'joined') this.showBanner('对手已加入！', 1.4);
        else if (this.phase === 'lobby') this.showBanner('有玩家离开了房间', 1.4);
        // A dropped seat is not acted on instantly: `updateLeftSeats()` waits a
        // few seconds, so a blink of Wi-Fi (or an alt-tab) must not cost
        // somebody their match. Every seat watches every other seat — the host
        // because it referees, a guest because the *host* may be the one that
        // vanished (that match is void; see `seatLeft`).
        if (state === 'left' && (this.phase === 'playing' || this.phase === 'ready') && id) {
          // A dropped socket is not instantly a departure: the server keeps the
          // seat for two minutes, so a one-second hiccup or an alt-tab must not
          // remove somebody. After the grace period the seat really is gone —
          // and the match now continues without it (v1.5.2).
          if (!this.goneSeats.has(id)) this.leftSeat = { id, at: this.time.now + 4000 };
        }
        if (state === 'joined') {
          this.leftSeat = null;
          sound.ui();
          // v1.4: a new player lands in the lobby. The host decides when the
          // match starts, so joining never yanks anyone into a firefight.
          // Only clear the arena outside a match: a *reconnecting* guest must
          // not wipe the shells everyone is currently dodging.
          if (this.phase === 'lobby' || this.phase === 'ready') {
            this.bullets = [];
            this.particles = [];
          }
        }
      },
      onInput: (input, from) => {
        // The host answers with snapshots, so it stores one input line per seat.
        if (from === 'p2' || !this.byId(from)) {
          this.remoteInput = input;
          if (from !== 'p2') this.remoteInputs.set(from, input);
          return;
        }
        this.remoteInputs.set(from, input);
      },
      onSeat: (id) => {
        this.myId = id;
        if (role === 'guest') this.applyCameraToLocal();
      },
      onRoster: (players, capacity, info) => {
        this.syncRoster(players);
        this.roomCapacity = capacity;
        this.teamCount = info.teams;
        this.matchLive = info.started;
        // Guests (and the host) sit in the lobby until the host starts.
        if (!info.started) this.enterLobby(info);
        else if (this.phase === 'lobby') this.leaveLobby();
      },
      onBegin: (info) => {
        if (info.config) {
          settings.match = { ...settings.match, ...(info.config as unknown as typeof settings.match) };
          const levelId = info.config.levelId;
          if (typeof levelId === 'string') this.roomLevelId = levelId;
        }
        if (typeof info.teams === 'number') this.teamCount = info.teams;
        this.matchLive = true;
        // The room's map wins over whatever this machine had picked: resolve it
        // by id, because the two libraries order custom maps differently.
        const announced = (info.config as { levelId?: unknown } | null)?.levelId;
        const resolved = this.indexOfLevel(announced) >= 0;
        this.adoptRoomLevel(info.config);
        if (this.lanRole === 'guest' && !resolved) {
          // 随机地图: only the host resolved it, and its `restart` (sent right
          // after `begin`) names the concrete arena. Loading a guess here would
          // flash the wrong map.
          this.leaveLobby();
          return;
        }
        this.restartLanMatch();
        this.leaveLobby();
      },
      onLobbyError: (info) => {
        if (info.reason === 'map-pending') {
          // Still waiting on guests: stay in the lobby and say who is missing.
          const waiting = info.waiting ?? [];
          this.mapWaiting = waiting;
          this.startPending = true;
          this.showBanner(waiting.length ? `等待 ${waiting.length} 台确认地图…` : '正在确认地图…', 1.8);
          this.repaintLobby();
          return;
        }
        if (info.reason === 'map-failed') {
          this.showBanner(`地图同步失败${info.detail ? `：${info.detail}` : ''}`, 2.4);
          this.repaintLobby();
          return;
        }
        const teams = info.teams ?? [];
        const empty = teams.map((size, index) => (size === 0 ? `第 ${index + 1} 队` : '')).filter(Boolean);
        this.showBanner(`${empty.join('、')}还没有人，不能开始`, 2.2);
      },
      onMapCleared: () => {
        this.roomMapId = '';
        this.mapConfirmed = true;
        this.repaintLobby();
      },
      onMap: (map, ok) => {
        // Guest: the host's map is now in this machine's library.
        this.roomMapId = map.id;
        this.mapConfirmed = ok;
        this.showBanner(ok ? `已收到房主的地图：${map.name}` : `地图校对失败：${map.name}`, 2);
        this.repaintLobby();
      },
      onMapStatus: (info) => {
        this.mapWaiting = info.waiting;
        this.mapReady = info.ready;
        this.repaintLobby();
        // The host pressed 开始对局 while a map was still travelling: start now.
        if (!info.waiting.length && this.startPending && this.lanRole === 'host' && this.phase === 'lobby') {
          this.startPending = false;
          this.lan?.begin();
        }
      },
      onConfig: (config, hostTuning) => {
        // The host owns the rules and the balance: everyone plays the same match.
        if (role === 'host') return;
        if (hostTuning) setTuning(hostTuning);
        settings.match = { ...settings.match, ...config };
        const announced = (config as { levelId?: unknown }).levelId;
        if (typeof announced === 'string' && announced && announced !== this.roomLevelId) {
          // The room switched maps (built-in, or a custom map whose file is
          // arriving next): show the new name right away.
          this.roomLevelId = announced;
          if (announced !== 'random' && isCustomLevel(announced)) this.mapConfirmed = false;
          this.repaintLobby();
        }
        // Colours depend on the mode (team paint vs per-seat), so re-apply them.
        this.syncRoster(this.roster);
        this.modeText.setText(this.modeLabel());
        this.hudDirty = true;
      },
      onSnapshot: (snap) => this.applySnapshot(snap),
      onHostMessage: (msg) => {
        if (msg.t === 'result') {
          // The host owns the verdict; this machine just renders the same card.
          this.finishMatch({
            winners: msg.winners ?? [],
            draw: !!msg.draw,
            reason: msg.reason ?? 'kills',
            scoreboard: msg.scoreboard ?? [],
            elapsed: msg.elapsed ?? this.matchElapsed,
            mode: msg.mode,
            teams: msg.teams,
            surrenderBy: msg.surrenderBy,
          });
          return;
        }
        if (msg.t === 'restart' || msg.t === 'start') {
          // Prefer the map id: index numbers only line up when both machines
          // hold the same custom maps in the same order.
          const index = this.indexOfLevel(msg.levelId);
          if (index >= 0 && index !== this.levelIndex) this.loadLevel(index);
          else if (index < 0 && typeof msg.level === 'number' && msg.level !== this.levelIndex) this.loadLevel(msg.level);
          else this.restartLanMatch();
        }
      },
    });
    this.lan.skill = role === 'host' ? this.skillP1 : this.skillP2;
    if (role === 'host') {
      // The room's map goes out with the join message, so a guest that walks in
      // while the host is still setting up receives it immediately.
      this.roomMapId = this.pickedMapId();
      this.roomLevelId = settings.mapId || 'random';
      const map = getMap(this.roomMapId);
      if (map) {
        // The join message already carries the map, so remember its hash: a
        // start must not re-push (and re-ack) a file the room already has.
        this.lan.hostMap = map;
        this.pushedMapHash = mapHash(map);
      }
      this.lan.matchConfig = { ...settings.match, levelId: this.roomLevelId };
      this.lan.matchConfig.mode = settings.match.mode;
      this.lan.tuning = { ...tuning() };
    }
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
    // A non-default balance is always labelled, so nobody wonders why the
    // numbers feel odd (and a LAN guest knows it is the host's tuning).
    const tag = tuningIsCustom() ? ` · 内测参数 ${tuningDiff().length} 项` : '';
    if (this.lanMode) {
      const role = this.lanRole === 'host' ? '房主' : '访客';
      return `局域网 · ${role}${tag}`;
    }
    return this.versus
      ? `双人对战${tag}`
      : `单人 · ${preset().label}${this.autoDodge ? ' · 自动躲弹' : ''}${tag}`;
  }

  /** Room lobby: freeze the arena and let the overlay show the seat list. */
  private enterLobby(info: { mode: 'ffa' | 'team'; host: string | null }): void {
    if (!this.lanMode) return;
    if (info.mode === 'team' && settings.match.mode !== 'team') settings.match.mode = 'team';
    if (info.mode === 'ffa' && settings.match.mode !== 'ffa') settings.match.mode = 'ffa';
    const wasPlaying = this.phase === 'playing' || this.phase === 'ready';
    this.phase = 'lobby';
    this.lastLobby = { mode: info.mode, host: info.host };
    this.bullets = [];
    this.particles = [];
    this.paused = false;
    this.emitOverlay({
      kind: 'lobby',
      roster: this.roster.map((entry) => ({
        id: entry.id,
        name: entry.name ?? this.nameOf(entry.id),
        // Skills are private: only your own seat shows the actual choice.
        skill: entry.id === this.myId ? entry.skill : '',
        hasSkill: !!entry.skill,
        team: entry.team,
        ready: entry.ready ?? entry.id === 'p1',
        host: entry.id === 'p1',
      })),
      teams: this.teamCount,
      capacity: this.roomCapacity,
      mode: settings.match.mode,
      myId: this.myId,
      isHost: this.lanRole === 'host',
      hostId: info.host ?? 'p1',
      match: { ...settings.match },
      roomUrl: this.roomUrl,
      map: this.lobbyMap(),
      maps: this.lanRole === 'host' ? this.roomMapChoices() : undefined,
    });
    if (wasPlaying) sound.ui();
  }

  /** Host pressed start (or a begin arrived): resume normal play. */
  private leaveLobby(): void {
    this.phase = 'ready';
    this.readyTimer = 1.1;
    this.emitOverlay({ kind: 'hidden' });
    this.hudDirty = true;
  }

  /** Called by the lobby overlay: this seat's skill choice. */
  setMySkill(skill: SkillId): void {
    if (this.lanMode && this.lan && this.myId) {
      this.lan.setSkill(skill);
      const entry = this.roster.find((r) => r.id === this.myId);
      if (entry) entry.skill = skill;
    }
    if (this.lanRole === 'host' || !this.lanMode) this.skillP1 = skill;
    else this.skillP2 = skill;
    // Keep the roster (and so the in-match skill lookup) in sync immediately.
    this.roster = this.roster.map((r) => (r.id === this.myId ? { ...r, skill } : r));
  }

  setReady(ready: boolean): void {
    this.lan?.setReady(ready);
    this.roster = this.roster.map((r) => (r.id === this.myId ? { ...r, ready } : r));
  }

  setTeamOf(id: string, team: number): void {
    this.lan?.setTeam(id, team);
    this.roster = this.roster.map((r) => (r.id === id ? { ...r, team } : r));
    this.syncRoster(this.roster);
  }

  autoTeams(): void {
    this.lan?.autoTeams();
  }

  /** Host: how many teams there are (2..6). */
  setTeamCount(count: number): void {
    const next = Math.max(2, Math.min(6, Math.round(count)));
    this.teamCount = next;
    this.lan?.setTeamCount(next);
    // Re-clamp every seat so nobody keeps a team that no longer exists.
    this.roster = this.roster.map((entry) => ({ ...entry, team: Math.min(entry.team, next - 1) }));
    this.syncRoster(this.roster);
  }

  /** Host: move players so no team is empty. */
  fillTeams(): void {
    this.lan?.fillTeams();
  }

  /** Teams that currently have nobody on them (team-mode only). */
  emptyTeams(): number[] {
    // FFA puts everyone on team 0 on purpose: "empty teams" is meaningless there
    // and used to block 乱斗 from starting at all (v1.5.2 fix).
    if (settings.match.mode !== 'team') return [];
    const sizes = new Array(this.teamCount).fill(0);
    for (const entry of this.roster) {
      const team = Math.max(0, Math.min(this.teamCount - 1, entry.team));
      sizes[team] += 1;
    }
    return sizes.map((size, index) => (size === 0 ? index : -1)).filter((index) => index >= 0);
  }

  /** Host: apply lobby rule changes to the room. */
  applyRoomConfig(match: typeof settings.match): void {
    settings.match = { ...match };
    if (this.lanRole === 'host' && this.lan) {
      this.lan.matchConfig = { ...settings.match, levelId: this.roomLevelId || settings.mapId };
      this.lan.send({ t: 'config', ...this.lan.matchConfig, tuning: { ...tuning() } });
    }
    this.hudDirty = true;
  }

  /** Host: start the match for the whole room. */
  startRoomMatch(): void {
    if (this.lanRole !== 'host' || !this.lan) return;
    // A match nobody can win is a bug, not a setting: refuse to start one.
    if (!matchHasEnder(settings.match)) {
      this.showBanner('没有结束条件（人头和时间都不限），先在房间面板里开一个', 2.4);
      return;
    }
    // Every team needs somebody; the server enforces it too, this is the fast path.
    if (settings.match.mode === 'team') {
      const empty = this.emptyTeams();
      if (empty.length) {
        this.showBanner(`${empty.map((i) => `第 ${i + 1} 队`).join('、')}还没有人，不能开始`, 2.2);
        return;
      }
    }
    // 'random' is rolled here, once, and then announced as a concrete map id:
    // otherwise the host and every guest would roll a different arena.
    if (settings.mapId === 'random') this.startIndex = randomLevelIndex(-1);
    if (settings.mapId !== 'random' && !this.pickedMapId()) {
      const index = levelIndexOf(settings.mapId);
      if (index >= 0) this.startIndex = index;
    }
    this.roomLevelId = this.pickedMapId()
      ? settings.mapId
      : settings.mapId === 'random'
        ? 'random'
        : levels()[this.startIndex]?.id ?? 'random';
    // Push the room's map first: guests have to confirm they hold it before the
    // server accepts `begin`, so nobody starts on a different arena.
    this.pushRoomMap();
    this.lan.matchConfig = { ...settings.match, levelId: this.roomLevelId };
    this.lan.send({ t: 'config', ...this.lan.matchConfig, tuning: { ...tuning() } });
    if (this.pickedMapId() && this.mapWaiting.length) {
      // Guests still owe an ack: the server would refuse `begin`, so remember
      // the click and finish it as soon as the last confirmation lands.
      this.startPending = true;
      this.showBanner(`等 ${this.mapWaiting.length} 台确认地图…`, 1.8);
      this.repaintLobby();
      return;
    }
    this.lan.begin();
    // The start happens when the server's `begin` arrives (onBegin), so the host
    // also keeps the lobby until every guest has the map and `begin` is allowed.
    this.repaintLobby();
  }

  /**
   * Host: push the room's map again. A guest that lost its ack (or walked in
   * mid-push) would otherwise block the start forever.
   */
  resendRoomMap(): void {
    if (this.lanRole !== 'host' || !this.lan) return;
    const map = getMap(this.pickedMapId());
    if (!map) return;
    this.lan.sendMap(map);
    this.mapReady = [];
    this.mapWaiting = this.roster.filter((seat) => seat.id !== 'p1').map((seat) => seat.id);
    this.showBanner('已重发地图，等待确认…', 1.6);
    this.repaintLobby();
  }

  // ------------------------------------------------------------------ maps

  /** The custom map this host picked for the room, or '' for a built-in. */
  private pickedMapId(): string {
    const chosen = settings.mapId;
    return chosen !== 'random' && isCustomLevel(chosen) ? chosen : '';
  }

  /** The room's advertised map id: a level id, `''` or `'random'`. */
  private roomLevel(): string {
    if (this.lanRole === 'host') return settings.mapId || 'random';
    return this.roomLevelId || '';
  }

  /** Display name of the room's map, for the lobby + banners. */
  private roomLevelName(): string {
    const id = this.roomLevel();
    if (!id) return '内置地图';
    if (id === 'random') return '随机地图';
    return levelById(id)?.name ?? (isCustomLevel(id) ? '自定义地图' : '内置地图');
  }

  /**
   * Host: make the room play `id` (a level id or 'random'). The map file goes
   * out for custom maps; built-ins only need the id, so any custom map cached
   * in the room is cleared. Safe to call from the lobby at any time.
   */
  public setRoomLevel(id: string): void {
    if (!this.lanMode || this.lanRole !== 'host' || !this.lan) return;
    // Only between matches: changing the arena under a running fight would
    // teleport everyone mid-shell.
    if (this.phase !== 'lobby') return;
    const next = id && id !== 'random' && (isCustomLevel(id) || levelIndexOf(id) >= 0) ? id : 'random';
    settings.mapId = next;
    this.roomLevelId = next;
    this.pushRoomMap();
    this.lan.matchConfig = { ...settings.match, levelId: next };
    this.lan.send({ t: 'config', ...this.lan.matchConfig, tuning: { ...tuning() } });
    this.showBanner(`房间地图：${this.roomLevelName()}`, 1.4);
    this.repaintLobby();
  }

  /**
   * Host: hand the room its map. Custom maps have to travel as a file (and be
   * acknowledged) before the server accepts `begin`; built-ins are an id.
   */
  private pushRoomMap(force = false): void {
    if (!this.lanMode || this.lanRole !== 'host' || !this.lan) return;
    const custom = this.pickedMapId();
    if (custom) {
      const map = getMap(custom);
      if (map) {
        const hash = mapHash(map);
        // Re-sending a map the room already holds clears every ack and makes the
        // host wait for a round trip it does not need.
        if (!force && hash === this.pushedMapHash && !this.mapWaiting.length) return;
        this.lan.sendMap(map);
        this.pushedMapHash = hash;
        this.mapReady = [];
        this.mapWaiting = this.roster.filter((seat) => seat.id !== 'p1').map((seat) => seat.id);
        this.mapConfirmed = false;
        return;
      }
    }
    this.lan.clearMap();
    this.pushedMapHash = '';
    this.mapReady = [];
    this.mapWaiting = [];
    this.mapConfirmed = true;
  }

  /** Index of a level id in this machine's list, or -1. */
  private indexOfLevel(id: unknown): number {
    if (typeof id !== 'string' || !id) return -1;
    // `levelIndexOf` clamps to 0, which would silently load the first arena for
    // an unknown id – including 'random', which only the host can resolve.
    return levels().findIndex((level) => level.id === id);
  }

  /**
   * Guests (and the host's own restart) take the map the room announced.
   * Returns true when the level actually changed.
   */
  private adoptRoomLevel(config: Record<string, unknown> | null | undefined): boolean {
    const id = typeof config?.levelId === 'string' ? config.levelId : this.roomMapId;
    const index = this.indexOfLevel(id);
    if (index < 0) return false;
    const changed = index !== this.levelIndex;
    this.startIndex = index;
    return changed;
  }

  /** What the lobby shows about the room's map. */
  private lobbyMap(): {
    id: string;
    name: string;
    custom: boolean;
    waiting: number;
    ready: number;
    total: number;
    synced: boolean;
  } | null {
    if (!this.lanMode) return null;
    const id = this.roomLevel();
    const custom = !!this.pickedMapId();
    const total = Math.max(0, this.roster.filter((seat) => seat.id !== 'p1').length);
    const waiting = this.lanRole === 'host' ? this.mapWaiting.filter((seat) => seat !== 'p1').length : 0;
    return {
      id,
      name: this.roomLevelName(),
      custom,
      waiting,
      ready: this.lanRole === 'host' ? this.mapReady.filter((seat) => seat !== 'p1').length : this.mapConfirmed ? 1 : 0,
      total,
      synced: this.lanRole === 'host' ? waiting === 0 : this.mapConfirmed,
    };
  }

  /** Host: every map this machine can put in the room. */
  private roomMapChoices(): { id: string; name: string; custom: boolean }[] {
    return [
      { id: 'random', name: '随机地图', custom: false },
      ...levels().map((level) => ({
        id: level.id,
        name: level.name,
        custom: isCustomLevel(level.id),
      })),
    ];
  }

  /** Repaints the room after a map confirmation, without rebuilding the arena. */
  private repaintLobby(): void {
    if (!this.lanMode || this.phase !== 'lobby' || !this.lastLobby) return;
    this.enterLobby(this.lastLobby);
  }

  /** Host: reset the arena without touching the socket. */
  /** Zoom + scroll rules for the current map. */
  private applyCamera(rect: PlayRect): void {
    const cam = this.cameras.main;
    cam.setZoom(1);
    if (this.worldMode) {
      // The map is bigger than the screen: scroll with the local tank instead
      // of shrinking it (zooming would scale the pinned HUD with it).
      cam.setBounds(rect.x, rect.y, rect.w, rect.h);
      cam.setBackgroundColor(0xf3ead9);
    } else {
      cam.setBounds(0, 0, GAME_W, GAME_H);
      cam.centerOn(GAME_W / 2, GAME_H / 2);
    }
    this.pinHud();
  }

  /** A HUD text that is created once and then only re-positioned / re-written. */
  private cachedText(key: string, x: number, y: number, size: number, align: 'left' | 'center' | 'right'): Phaser.GameObjects.Text {
    let text = this.cachedTexts.get(key);
    if (!text) {
      text = this.hud.text(x, y, '', size, COLORS.ink, align);
      this.cachedTexts.set(key, text);
      this.pinHud();
    }
    text.setPosition(x, y);
    return text;
  }

  /** Every HUD object, so a scrolling camera can pin them back to the screen. */
  private hudObjects(): Phaser.GameObjects.GameObject[] {
    const list: (Phaser.GameObjects.GameObject | undefined)[] = [
      this.hud.graphics,
      this.levelText,
      this.scoreText,
      this.modeText,
      this.hintText,
      this.skillChip,
      ...this.skillChipTexts,
      ...this.toastTexts,
      this.heatText,
      ...this.noticeLabels,
      ...this.cachedTexts.values(),
    ];
    return list.filter((o): o is Phaser.GameObjects.GameObject => !!o);
  }

  private pinHud(): void {
    const factor = this.worldMode ? 0 : 1;
    for (const obj of this.hudObjects()) {
      const scrollable = obj as Phaser.GameObjects.GameObject & { setScrollFactor?: (v: number) => unknown };
      scrollable.setScrollFactor?.(factor);
    }
  }

  /** Re-applies the camera rules after the seat (and so the followed tank) changed. */
  private applyCameraToLocal(): void {
    const rect = this.worldRect ?? PLAY_RECT;
    this.applyCamera(rect);
    const target = this.localTank();
    if (this.worldMode && target) {
      this.cameras.main.centerOn(target.x, target.y);
    }
  }

  /** Keeps the local tank centred while the map is bigger than the screen. */
  private followCamera(dt: number): void {
    if (!this.worldMode) return;
    const target = this.localTank();
    if (!target) return;
    const cam = this.cameras.main;
    const viewW = cam.width;
    const viewH = cam.height;
    const wantedX = target.x - viewW / 2;
    const wantedY = target.y - viewH / 2;
    const lerp = Math.min(1, dt * 7);
    cam.scrollX += (wantedX - cam.scrollX) * lerp;
    cam.scrollY += (wantedY - cam.scrollY) * lerp;
  }

  private restartLanMatch(): void {
    this.score = 0;
    this.bullets = [];
    this.particles = [];
    this.levelsCleared = 0;
    // A rematch starts with the room as it is now: nobody is "gone" any more.
    this.goneSeats.clear();
    this.leftSeat = null;
    // A rematch is a fresh match: without this the clock stayed maxed out and
    // the `matchOver` latch swallowed the second result card entirely.
    this.matchElapsed = 0;
    this.matchOver = false;
    this.respawnQueue.clear();
    // Menu choices take effect on the next match.
    if (!this.lanMode || this.lanRole === 'host') this.skillP1 = settings.skillP1;
    this.skillP2 = settings.skillP2;
    this.loadLevel(this.startIndex);
    // Announce the *resolved* map id: 'random' has just been rolled into a
    // concrete level here, so every guest loads exactly this arena.
    this.lan?.send({ t: 'restart', level: this.startIndex, levelId: levels()[this.startIndex]?.id });
    this.emitOverlay({ kind: 'hidden' });
  }

  private emitOverlay(state: OverlayState, error: Error | null = null): void {
    void error;
    this.game.events.emit(OVERLAY_EVENT, state);
  }

  private tanks(): Tank[] {
    return [this.p1, this.p2, this.enemy, ...this.extras].filter((t): t is Tank => !!t);
  }

  /** Everyone with a health bar: yourself first, then by seat id. */
  private scoreboardOrder(): Tank[] {
    const me = this.localTank();
    const list = this.tanks().filter((t) => t.id !== 'enemy' || !this.lanMode);
    list.sort((a, b) => {
      if (a === me) return -1;
      if (b === me) return 1;
      return a.id.localeCompare(b.id, undefined, { numeric: true });
    });
    return list;
  }

  private matchUsesTeams(): boolean {
    return settings.match.mode === 'team';
  }

  /** Any tank by network seat id. */
  private byId(id: string): Tank | undefined {
    return this.tanks().find((t) => t.id === id);
  }

  /** The tank this machine actually drives. */
  private localTank(): Tank | undefined {
    if (this.lanMode && this.lanRole === 'guest') return this.byId(this.myId) ?? this.p2 ?? this.p1;
    return this.p1;
  }

  /**
   * Where a joining seat should come in.
   *
   * Team mode drops you next to a living team-mate (that is the mode's promise);
   * every other mode picks the spawn farthest from everybody, so a newcomer is
   * never an instant free kill.
   */
  private pickSpawnFor(team: number): { x: number; y: number; angle: number } {
    const spawns = this.layout.spawns?.length ? this.layout.spawns : [this.layout.enemy];
    const others = this.tanks()
      .filter((t) => t.alive)
      .map((t) => ({ x: t.x, y: t.y, team: t.team, alive: t.alive }));
    const candidates: RespawnCandidate[] = spawns.map((spawn, index) => ({ ...spawn, id: index }));
    // v1.5.2: a map with two spawn points and six players put four tanks exactly
    // on top of each other, which looked like a frozen match. Score every spawn
    // point and take the best *free* one.
    const best = chooseRespawn({
      spawns: candidates,
      players: others,
      team,
      mode: settings.match.mode,
      // Free pockets are preferred; a fully occupied arena falls back to the
      // open-map rule instead of stacking.
      isFree: (x, y) => this.spotFree(x, y, TANK.radius),
    });
    return spawns[best?.id ?? 0] ?? this.layout.enemy;
  }

  /**
   * The nearest point to (x, y) that a tank fits in **and** that no other tank is
   * standing on. Spawn points are authored for 2–4 players; a ten-seat room has
   * to share them, so the overflow walks outward in rings.
   */
  private placeSpawn(x: number, y: number, radius: number, ignore?: Tank): { x: number; y: number } {
    const gap = TANK.radius * 2 + 6;
    const free = (px: number, py: number): boolean =>
      this.spawnClear(px, py, radius) &&
      this.tanks()
        .filter((t) => t !== ignore && t.alive)
        .every((t) => Math.hypot(t.x - px, t.y - py) >= gap);
    if (free(x, y)) return { x, y };
    const base = this.nudgeSpawn(x, y, radius);
    if (free(base.x, base.y)) return base;
    for (let ring = 1; ring <= 16; ring += 1) {
      const distance = ring * (gap * 0.8);
      for (let i = 0; i < 16; i += 1) {
        const angle = (i / 16) * Math.PI * 2 + ring * 0.37;
        const px = x + Math.cos(angle) * distance;
        const py = y + Math.sin(angle) * distance;
        if (free(px, py)) return { x: px, y: py };
      }
    }
    // Nowhere free at all (a tiny, packed map): the old behaviour, but at least
    // out of the walls.
    return base;
  }

  /** True when no tank is standing within one hull of (x, y). */
  private spotFree(x: number, y: number, radius: number): boolean {
    const gap = radius * 2 + 6;
    return this.tanks()
      .filter((t) => t.alive)
      .every((t) => Math.hypot(t.x - x, t.y - y) >= gap);
  }

  /**
   * Creates the tank for a remote seat. p2 is kept as "the first remote" for
   * all the versus/1v1 code paths; every further seat goes into `extras`.
   */
  private addRemoteTank(id: string, team = 0): Tank {
    const spawn = this.pickSpawnFor(team);
    const spot = this.placeSpawn(spawn.x, spawn.y, TANK.radius);
    const tank = new Tank(this, spot.x, spot.y, spawn.angle, id, 22, this.colorForSeat(id, team));
    tank.team = team;
    if (!this.p2) this.p2 = tank;
    else this.extras.push(tank);
    return tank;
  }

  private removeRemoteTank(id: string): void {
    if (this.p2 && this.p2.id === id) {
      this.p2.destroy();
      this.p2 = undefined;
      // Promote the first extra so "p2" still means "a remote player".
      const next = this.extras.shift();
      if (next) this.p2 = next;
      return;
    }
    const index = this.extras.findIndex((t) => t.id === id);
    if (index >= 0) {
      this.extras[index].destroy();
      this.extras.splice(index, 1);
    }
  }

  /** Team mode paints by side; FFA gives every seat its own colour. */
  private colorForSeat(id: string, team: number): number {
    return settings.match.mode === 'team' ? teamColor(team) : seatColor(id);
  }

  /** Makes the tank list match the roster the server just broadcast. */
  private syncRoster(
    players: { id: string; team: number; skill: string; hasSkill?: boolean; ready?: boolean; name?: string }[]
  ): void {
    this.roster = players;
    if (!this.lanMode) return;
    // A seat joining or leaving changes what everyone has to be told, so the
    // next snapshot is a full keyframe (v1.5.3 deltas).
    this.requestKeyframe();
    const wanted = new Set(players.map((p) => p.id));
    // A seat that is back in the roster is not a departure any more: it may have
    // reconnected after the grace period, so it rejoins the running match.
    if (this.leftSeat && wanted.has(this.leftSeat.id)) this.leftSeat = null;
    for (const id of [...this.goneSeats]) if (wanted.has(id)) this.goneSeats.delete(id);
    for (const tank of [...this.extras, this.p2].filter((t): t is Tank => !!t)) {
      if (!wanted.has(tank.id)) this.removeRemoteTank(tank.id);
    }
    for (const player of players) {
      const existing = this.byId(player.id);
      if (existing) {
        existing.team = player.team;
        existing.color = this.colorForSeat(player.id, player.team);
        existing.redraw();
        continue;
      }
      if (player.id === this.myId) continue;
      this.addRemoteTank(player.id, player.team);
    }
    this.hudDirty = true;
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

  /**
   * v1.5.3: a summoner-skill chip in the top-right corner.
   *
   * Only the seats this machine actually drives are shown: your own seat in
   * solo / LAN (a ten-player room must not print nine other people's cooldowns),
   * and both pads in local versus, because both players sit at this screen.
   */
  private refreshSkillChip(): void {
    const layer = this.skillChip;
    if (!layer) return;
    layer.clear();

    const rows: { tank: Tank; label: string }[] = [];
    if (settings.mode === 'versus') {
      if (this.p1) rows.push({ tank: this.p1, label: 'P1' });
      if (this.p2) rows.push({ tank: this.p2, label: 'P2' });
    } else {
      const mine = this.localTank();
      if (mine) rows.push({ tank: mine, label: '' });
    }

    const now = this.time.now;
    const w = 166;
    const h = 26;
    const right = PLAY_RECT.x + PLAY_RECT.w;
    let used = 0;

    rows.forEach((row, index) => {
      const def = skillById(this.skillFor(row.tank));
      const total = Math.max(1, def.cooldown * 1000);
      const left = Math.max(0, row.tank.skillReadyAt - now);
      const ready = left <= 0;
      const frac = ready ? 1 : 1 - left / total;
      const x = right - w;
      const y = 16 + index * (h + 6);
      const color = this.colorForSeat(row.tank.id, row.tank.team);

      layer.fillStyle(COLORS.paper, 0.86);
      layer.fillRect(x, y, w, h);
      layer.lineStyle(1.4, COLORS.ink, ready ? 0.6 : 0.35);
      layer.strokeRect(x, y, w, h);
      // Readiness bar along the bottom edge of the chip.
      layer.fillStyle(color, ready ? 0.55 : 0.28);
      layer.fillRect(x + 1, y + h - 3, Math.max(0, (w - 2) * frac), 2);
      // Skill-colour pip, so the three skills differ at a glance.
      layer.fillStyle(color, ready ? 0.9 : 0.45);
      layer.fillRect(x + 6, y + 7, 4, h - 16);

      const nameText = this.skillChipTexts[index * 2] ?? this.makeChipText(x + 16, y + h / 2, 'left');
      const timeText = this.skillChipTexts[index * 2 + 1] ?? this.makeChipText(x + w - 8, y + h / 2, 'right');
      this.skillChipTexts[index * 2] = nameText;
      this.skillChipTexts[index * 2 + 1] = timeText;
      nameText.setPosition(x + 16, y + h / 2);
      timeText.setPosition(x + w - 8, y + h / 2);

      const name = `${row.label ? `${row.label} ` : ''}${def.name}`;
      if (nameText.text !== name) nameText.setText(name);
      const time = ready ? '就绪' : `${(left / 1000).toFixed(1)}s`;
      if (timeText.text !== time) timeText.setText(time);
      nameText.setAlpha(ready ? 0.92 : 0.55);
      timeText.setAlpha(ready ? 0.92 : 0.55);
      timeText.setColor(ready ? '#26221d' : '#8a8377');
      used = index + 1;
    });

    // Freeze the unused slots from a previous mode instead of leaving them behind.
    for (let i = used * 2; i < this.skillChipTexts.length; i += 1) {
      const spare = this.skillChipTexts[i];
      if (spare.text !== '') spare.setText('');
    }
  }

  /** One lazily created, screen-pinned text for the skill chip. */
  private makeChipText(x: number, y: number, align: 'left' | 'right'): Phaser.GameObjects.Text {
    const text = this.hud.text(x, y, '', 13, COLORS.ink, align);
    // Above the chip's own card (depth 42), below nothing else.
    text.setDepth(43);
    return text;
  }

  /** Picks the map chosen in the menu ('random' rolls a fresh one) and starts. */
  private beginMatch(): void {
    const chosen = settings.mapId;
    this.startIndex = chosen === 'random' ? randomLevelIndex(-1) : levelIndexOf(chosen);
    this.levelsCleared = 0;
    // Menu choices take effect on the next match.
    if (!this.lanMode || this.lanRole === 'host') this.skillP1 = settings.skillP1;
    this.skillP2 = settings.skillP2;
    this.loadLevel(this.startIndex);
  }

  private loadLevel(index: number): void {
    this.levelIndex = index;
    // New arena → the next snapshot must describe everything (v1.5.3 deltas).
    this.requestKeyframe();
    // Every fresh arena starts with the full room: a seat that left the last
    // match may well be back in this one.
    this.goneSeats.clear();
    this.leftSeat = null;
    this.refreshHeaderText();
    const level = levels()[index];
    // v1.3: multiplayer maps are bigger than the screen, so the layout uses the
    // level's own world size and the camera follows instead of showing it all.
    this.worldMode = !!level.world;
    this.worldRect = level.world ? { x: 0, y: 0, w: level.world.w, h: level.world.h } : null;
    const rect: PlayRect = level.world
      ? { x: 0, y: 0, w: level.world.w, h: level.world.h }
      : PLAY_RECT;
    this.layout = buildLayout(level, rect);
    this.applyCamera(rect);
    this.resetPickups(index);

    for (const tank of this.tanks()) tank.destroy();
    this.p2 = undefined;
    this.enemy = undefined;
    this.extras = [];

    const d = preset();

    const p1Spot = this.nudgeSpawn(this.layout.player.x, this.layout.player.y, TANK.radius);
    this.p1 = new Tank(this, p1Spot.x, p1Spot.y, this.layout.player.angle, 'p1', 20);
    this.p1.setHp(this.versus ? VERSUS_HP : MAX_HP);
    this.p1.skillReadyAt = this.time.now + 1200;

    if (this.versus) {
      const p2Spot = this.nudgeSpawn(this.layout.enemy.x, this.layout.enemy.y, TANK.radius);
      this.p2 = new Tank(this, p2Spot.x, p2Spot.y, this.layout.enemy.angle, 'p2', 22);
      this.p2.setHp(VERSUS_HP);
      this.p2.team = 1;
      this.p2.skillReadyAt = this.time.now + 1200;
    } else {
      // Solo: the AI is health-based too; difficulty now only changes its aim,
      // reaction time and rate of fire.
      const cpuSpot = this.nudgeSpawn(this.layout.enemy.x, this.layout.enemy.y, TANK.radius);
      this.enemy = new Tank(this, cpuSpot.x, cpuSpot.y, this.layout.enemy.angle, 'enemy', 22);
      this.enemy.setHp(MAX_HP);
      this.enemy.team = 1;
    }

    this.crates = this.layout.crates.map((box) => ({ box, alive: true }));
    this.bullets = [];
    this.particles = [];
    this.fireCd.clear();

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

    // Rebuilding the arena must not forget the other seats: a LAN host puts
    // every player in the room back on the fresh map.
    if (this.lanMode && this.lanRole === 'host' && this.roster.length) this.syncRoster(this.roster);
  }

  /** Called by the DOM overlay. */
  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  /** Called by the DOM overlay to restart with the current settings. */
  restartGame(): void {
    // v1.5.3: 暂停 → 重新开始 used to leave `paused` set, so the overlay slid
    // away and the arena stayed frozen — the classic "button does nothing".
    this.paused = false;
    // Leaving LAN mode must actually drop the socket, not leave it half-open.
    if (!this.lanMode && this.lan) {
      this.lan.close();
      this.lan = null;
      this.lanRole = null;
    }
    // Leaving a room must not leave its seat list (and skills) behind.
    if (!this.lanMode) {
      this.roster = [];
      this.matchLive = false;
    }
    this.score = 0;
    this.bullets = [];
    this.particles = [];
    this.paused = false;
    // 再来一局 is a fresh match: the finished latches and the clock have to go,
    // otherwise the next result card never appears.
    this.matchOver = false;
    this.matchElapsed = 0;
    this.startPending = false;
    this.respawnQueue.clear();
    this.autoDodge = settings.autoDodge;
    this.beginMatch();
    // A host restart has to reach every guest explicitly: the guest keeps its
    // socket, so nothing else would ever tell it the match was reset.
    if (this.lanMode && this.lanRole === 'host') {
      this.lan?.send({ t: 'restart', level: this.startIndex, levelId: levels()[this.startIndex]?.id });
    }
    this.emitOverlay({ kind: 'hidden' });

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.lanClosed = true;
      this.lan?.close();
      this.lan = null;
      this.lanRole = null;
    });

    // Only redial when the room itself changed. A 再来一局 keeps its socket:
    // reconnecting as host drops the room back to the lobby and throws the
    // rematch away.
    if (this.lanMode) {
      const target = `${settings.lanRole}@${settings.lanAddress}`;
      if (!this.lan || this.lanClosed || this.lanTarget !== target) this.connectLan();
    }
  }

  /** Toggle the solo autopilot (menu checkbox or the G key). */
  setAutoDodge(on: boolean): void {
    this.autoDodge = on;
    settings.autoDodge = on;
    this.hudDirty = true;
    this.refreshHeaderText();
    this.showBanner(on ? '自动躲弹：开' : '自动躲弹：关', 0.9);
  }

  /** v1.5.3: pause-menu switch for the hit shake/flash (read live while on). */
  setHitEffects(on: boolean): void {
    settings.hitEffects = on;
    if (!on) {
      // Stop a shake/flash that is already running instead of letting it finish.
      this.cameras.main.resetFX();
    }
    this.showBanner(on ? '受击特效：开' : '受击特效：关', 0.9);
  }

  /**
   * All short-lived messages go to the corner stack instead of the middle of
   * the screen: the old 64px centre text covered the exact spot you aim at.
   * Newest message sits at the bottom, older ones slide up and fade out.
   */
  private showBanner(text: string, seconds: number): void {
    if (!text) return;
    const life = Math.max(0.4, seconds) * 1000 + 450;
    this.toasts.push({ text, life, total: life });
    // Three lines is enough; anything older is dropped rather than stacked.
    while (this.toasts.length > 3) this.toasts.shift();
  }

  /** Advances the corner messages and lays them out bottom-up. */
  private refreshToasts(dt: number): void {
    for (const toast of this.toasts) toast.life -= dt * 1000;
    this.toasts = this.toasts.filter((toast) => toast.life > 0);

    const baseY = GAME_H - 52;
    const lineHeight = 21;
    const x = PLAY_RECT.x + 10;

    // Newest at the bottom, walking upward.
    for (let i = 0; i < this.toasts.length; i++) {
      const toast = this.toasts[this.toasts.length - 1 - i];
      let label = this.toastTexts[i];
      if (!label) {
        label = this.hud.text(x, baseY - i * lineHeight, '', 16, COLORS.ink, 'left');
        this.toastTexts.push(label);
        this.pinHud();
      }
      if (label.text !== toast.text) label.setText(toast.text);
      label.setPosition(x, baseY - i * lineHeight);
      // Fade only in the last 400ms.
      const fade = Math.min(1, toast.life / 400);
      label.setAlpha(0.85 * fade);
    }
    for (let i = this.toasts.length; i < this.toastTexts.length; i++) {
      if (this.toastTexts[i].text !== '') this.toastTexts[i].setText('');
    }
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

  private drawHud(): void {
    this.hud.clear();

    // v1.4: everyone's health in one left-hand column, so a 10-player room is
    // readable at a glance. Old builds only ever drew p1 and p2, which is why
    // p3+ had no bar at all.
    const list = this.scoreboardOrder();
    const left = PLAY_RECT.x + 10;
    const top = 26;
    const rowH = 26;
    const barW = 118;

    list.forEach((tank, index) => {
      const y = top + index * rowH;
      const color = this.colorForSeat(tank.id, tank.team);
      const alive = tank.alive && !tank.awaitingRespawn;
      const label = `${this.nameOf(tank.id)}${tank.team >= 0 && this.matchUsesTeams() ? `·${tank.team + 1}队` : ''}`;
      this.drawHpBar(left, y, barW, 8, alive ? tank.hpRatio() : 0, color, label, index === 0 ? 'L' : 'L', 11);
      // Kills next to the bar – the number the win condition is checked against.
      const killText = this.cachedText(`hp${index}.kills`, left + barW + 8, y + 4, 11, 'left');
      const shown = `${tank.kills}`;
      if (killText.text !== shown) killText.setText(shown);
    });
    // Hide leftover rows from a bigger room.
    for (let i = list.length; i < this.hpRowCount; i += 1) {
      const name = this.cachedTexts.get(`hp${i}.name`);
      if (name?.text) name.setText('');
      const value = this.cachedTexts.get(`hp${i}.value`);
      if (value?.text) value.setText('');
      const kills = this.cachedTexts.get(`hp${i}.kills`);
      if (kills?.text) kills.setText('');
    }
    this.hpRowCount = list.length;

    if (this.lanMode) {
      // The clock and the kill target are the two numbers that decide the
      // match, so they live in the top bar instead of only on the result card.
      const parts: string[] = [];
      const clock = this.matchClockText();
      if (clock) parts.push(clock);
      const target = settings.match.killTarget;
      if (target > 0 && settings.match.winCondition !== 'time') parts.push(`目标 ${target} 杀`);
      this.scoreText.setText(parts.length ? parts.join('  ·  ') : '人头');
    } else if (this.versus && this.p2) {
      this.scoreText.setText(`P1 ${this.p1.kills} : ${this.p2.kills} P2`);
    } else if (this.enemy) {
      this.scoreText.setText(`得分  ${String(this.score).padStart(5, '0')}`);
    } else {
      this.scoreText.setText(this.scoreboardOrder().length ? '人头' : '');
    }

    // Your own barrel heat lives at the bottom and stays private.
    this.drawHeatGauge();
    this.hudDirty = false;
  }

  /** `剩 3:20` / `用时 1:05` for the top bar, or '' when the clock is off. */
  private matchClockText(): string {
    const limit = settings.match.timeLimit;
    const timed = limit > 0 && settings.match.winCondition !== 'kills';
    const seconds = Math.max(0, Math.round(timed ? limit - this.matchElapsed : this.matchElapsed));
    const text = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    return timed ? `剩 ${text}` : '';
  }

  /**
   * v1.3 公示区: the corner panel lists every seat with its team and the skill
   * that seat picked. Identical information for everyone in the room.
   */
  private refreshNotice(): void {
    const show = this.lanMode && this.roster.length > 2 && !this.matchOver;
    if (!show) {
      for (const label of this.noticeLabels) if (label.text !== '') label.setText('');
      return;
    }
    const right = PLAY_RECT.x + PLAY_RECT.w - 10;
    const top = 88;
    const lineHeight = 19;
    this.roster.forEach((entry, index) => {
      let label = this.noticeLabels[index];
      if (!label) {
        label = this.hud.text(right, top + index * lineHeight, '', 12, COLORS.ink, 'right');
        label.setAlpha(0.7);
        this.noticeLabels.push(label);
        this.pinHud();
      }
      const tank = this.byId(entry.id);
      // Skills stay private: you see your own, everyone else is just "已选".
      const mine = entry.id === this.myId;
      const skill = mine
        ? isSkillId(entry.skill)
          ? skillById(entry.skill).name
          : '—'
        : entry.hasSkill || entry.skill
          ? '已选'
          : '—';
      const teamSize = this.roster.filter((r) => r.team === entry.team).length;
      const team = teamSize > 1 ? `队${entry.team}` : 'FFA';
      const kills = tank ? `${tank.kills} 杀` : '—';
      label.setText(`${this.nameOf(entry.id)} · ${team} · ${skill} · ${kills}`);
    });
    for (let i = this.roster.length; i < this.noticeLabels.length; i++) {
      if (this.noticeLabels[i].text !== '') this.noticeLabels[i].setText('');
    }
  }

  /**
   * One public health bar. The name sits above the bar and the number inside
   * it, so a bar never shares a line with any other element.
   */
  private drawHpBar(
    x: number,
    y: number,
    w: number,
    h: number,
    ratio: number,
    color: number,
    label: string,
    slot: 'L' | 'R',
    size = 13,
    keyOverride?: string
  ): void {
    const onLeft = slot === 'L';
    this.hud.fillRect(x, y, w, h, COLORS.white, 0.9);
    if (ratio > 0) {
      this.hud.fillRect(x + 1, y + 1, Math.max(0, (w - 2) * ratio), h - 2, color, 0.9);
    }
    this.hud.rect(x, y, w, h, { width: 1.3, color: COLORS.ink, jitter: 0.5 });

    // A stable key per row keeps the text objects reused between redraws.
    const key = keyOverride ?? (onLeft ? `hp${label}` : `hpR${label}`);
    const name = this.cachedText(`${key}.name`, onLeft ? x : x + w, y - 9, size, onLeft ? 'left' : 'right');
    if (name.text !== label) name.setText(label);
    const value = this.cachedText(`${key}.value`, onLeft ? x + w - 5 : x + 5, y + h / 2, 10, onLeft ? 'right' : 'left');
    const shown = `${Math.max(0, Math.round(ratio * 100))}`;
    if (value.text !== shown) value.setText(shown);
  }

  /** Who is who on the minimap: yourself, your own team, everyone else. */
  minimapMarks(): { id: string; kind: 'me' | 'mate' | 'foe'; x: number; y: number; color: number; dead: boolean; body: number }[] {
    const me = this.localTank();
    const teamMode = settings.match.mode === 'team';
    const marks: { id: string; kind: 'me' | 'mate' | 'foe'; x: number; y: number; color: number; dead: boolean; body: number }[] = [];
    for (const tank of this.tanks()) {
      // The solo CPU is an enemy too: a map that only shows yourself is useless.
      const mate = !!me && teamMode && tank.id !== me.id && tank.team === me.team;
      marks.push({
        id: tank.id,
        kind: tank === me ? 'me' : mate ? 'mate' : 'foe',
        x: tank.x,
        y: tank.y,
        color: this.colorForSeat(tank.id, tank.team),
        dead: !tank.alive || tank.awaitingRespawn,
        body: tank.bodyAngle,
      });
    }
    return marks;
  }

  /**
   * v1.4 minimap (FFA and team alike), v1.5 friend/foe marking.
   *
   * Shows the arena's shape (walls, crates) plus every player, with the three
   * sides drawn as three different things so nobody has to guess:
   *   - 你自己: 白环 + 朝向刻度
   *   - 队友:   方块 + 墨线描边（方 = 自己人）
   *   - 敌人:   菱形 + 墨线描边（尖角 = 对手）
   * A small legend sits just above the card and follows the current mode.
   * Pinned to the bottom-right corner, drawn every frame, never scrolls.
   */
  private drawMinimap(): void {
    const g = this.minimap;
    g.clear();
    if (!this.layout) return;
    if (this.phase !== 'playing' && this.phase !== 'ready') return;

    const rect = this.worldRect ?? PLAY_RECT;
    // Big enough that the shape of a marker (…and not just its colour) reads at
    // a glance – the old 186px card was a row of indistinguishable dots.
    const boxW = 204;
    const ratio = rect.h / Math.max(1, rect.w);
    const boxH = Math.max(84, Math.min(172, boxW * ratio));
    const x = PLAY_RECT.x + PLAY_RECT.w - boxW - 10;
    const y = GAME_H - boxH - 14;
    const sx = (wx: number): number => x + ((wx - rect.x) / rect.w) * boxW;
    const sy = (wy: number): number => y + ((wy - rect.y) / rect.h) * boxH;

    // Paper card + frame so it reads as its own panel, not part of the arena.
    g.fillStyle(COLORS.paper, 0.82);
    g.fillRect(x - 6, y - 6, boxW + 12, boxH + 12);
    g.lineStyle(1.4, COLORS.ink, 0.55);
    g.strokeRect(x - 6, y - 6, boxW + 12, boxH + 12);

    // Terrain: walls solid, crates small ticks, so the map shape is recognisable.
    g.fillStyle(COLORS.ink, 0.72);
    for (const wall of this.layout.walls) {
      g.fillRect(sx(wall.x), sy(wall.y), Math.max(1, (wall.w / rect.w) * boxW), Math.max(1, (wall.h / rect.h) * boxH));
    }
    g.fillStyle(COLORS.crate, 0.8);
    for (const crate of this.crates) {
      if (!crate.alive) continue;
      g.fillRect(
        sx(crate.box.x),
        sy(crate.box.y),
        Math.max(1.5, (crate.box.w / rect.w) * boxW),
        Math.max(1.5, (crate.box.h / rect.h) * boxH)
      );
    }

    // Pickups: tiny faint dots, so you can see a fight forming around one.
    g.fillStyle(COLORS.grid, 0.9);
    for (const p of this.pickups) {
      if (p.respawn > 0) continue;
      g.fillCircle(sx(p.x), sy(p.y), 1.6);
    }

    // On a map bigger than the screen, outline where the camera is looking.
    if (this.worldMode) {
      const view = this.cameras.main.worldView;
      g.lineStyle(1, COLORS.ink, 0.4);
      g.strokeRect(
        sx(Phaser.Math.Clamp(view.x, rect.x, rect.x + rect.w)),
        sy(Phaser.Math.Clamp(view.y, rect.y, rect.y + rect.h)),
        Math.max(6, (Math.min(view.width, rect.w) / rect.w) * boxW),
        Math.max(6, (Math.min(view.height, rect.h) / rect.h) * boxH)
      );
    }

    // Players: shape carries the meaning, colour still carries the team/seat.
    for (const mark of this.minimapMarks()) {
      const px = sx(mark.x);
      const py = sy(mark.y);
      if (mark.dead) {
        // Dead: the same outline, hollow, so the slot is not silently empty.
        g.lineStyle(1.2, mark.color, 0.45);
        if (mark.kind === 'foe') g.strokePoints(diamond(px, py, 4.6), true, true);
        else if (mark.kind === 'mate') g.strokeRect(px - 3, py - 3, 6, 6);
        else g.strokeCircle(px, py, 3.4);
        continue;
      }
      if (mark.kind === 'me') {
        // Yourself: white halo, then a heading tick so you know where you face.
        g.fillStyle(COLORS.ink, 0.25);
        g.fillCircle(px, py, 7.4);
        g.fillStyle(COLORS.white, 0.98);
        g.fillCircle(px, py, 6);
        g.fillStyle(mark.color, 1);
        g.fillCircle(px, py, 4.2);
        g.lineStyle(1.8, COLORS.white, 0.95);
        g.lineBetween(px, py, px + Math.cos(mark.body) * 8, py + Math.sin(mark.body) * 8);
        continue;
      }
      if (mark.kind === 'mate') {
        // Team-mate: a square. Shape says "same side" — a white collar would
        // vanish on paper-coloured ground.
        g.fillStyle(COLORS.ink, 0.16);
        g.fillRect(px - 6, py - 6, 12, 12);
        g.fillStyle(mark.color, 1);
        g.fillRect(px - 4.5, py - 4.5, 9, 9);
        g.lineStyle(1.4, COLORS.ink, 0.9);
        g.strokeRect(px - 4.5, py - 4.5, 9, 9);
        continue;
      }
      // Enemy: a diamond with an ink edge — distinct at four pixels wide.
      const points = diamond(px, py, 5.6);
      g.fillStyle(COLORS.ink, 0.18);
      g.fillPoints(diamond(px, py, 7.2), true);
      g.fillStyle(mark.color, 1);
      g.fillPoints(points, true);
      g.lineStyle(1.4, COLORS.ink, 0.9);
      g.strokePoints(points, true, true);
    }

    this.drawMinimapLegend(x, y, boxW);
  }

  /** 你 / 队友 / 敌人, drawn above the minimap card. */
  private drawMinimapLegend(x: number, y: number, boxW: number): void {
    const g = this.minimap;
    const teamMode = settings.match.mode === 'team';
    const items: { label: string; kind: 'me' | 'mate' | 'foe' }[] = [{ label: '你', kind: 'me' }];
    if (teamMode) items.push({ label: '队友', kind: 'mate' });
    items.push({ label: '敌人', kind: 'foe' });

    const size = 10;
    const charW = size;
    const shapeR = 3.6;
    const shapeGap = 6;
    const slotGap = 12;
    const slotWidth = (item: { label: string }): number => shapeR * 2 + shapeGap + item.label.length * charW;
    const total = items.reduce((sum, item) => sum + slotWidth(item), 0) + slotGap * (items.length - 1);
    const top = y - 22;
    let cursor = x + boxW - total;

    // A faint paper strip keeps the legend readable over a busy arena.
    g.fillStyle(COLORS.paper, 0.7);
    g.fillRect(cursor - 5, top - 7, total + 10, 14);

    const color = this.localTank() ? this.colorForSeat(this.localTank()!.id, this.localTank()!.team) : COLORS.player;
    items.forEach((item, index) => {
      const cx = cursor + shapeR;
      if (item.kind === 'me') {
        g.fillStyle(COLORS.white, 1);
        g.fillCircle(cx, top, shapeR);
        g.lineStyle(1.4, COLORS.ink, 0.8);
        g.strokeCircle(cx, top, shapeR);
      } else if (item.kind === 'mate') {
        g.fillStyle(color, 1);
        g.fillRect(cx - shapeR, top - shapeR, shapeR * 2, shapeR * 2);
        g.lineStyle(1.2, COLORS.ink, 0.85);
        g.strokeRect(cx - shapeR, top - shapeR, shapeR * 2, shapeR * 2);
      } else {
        const points = diamond(cx, top, shapeR + 0.8);
        g.fillStyle(COLORS.enemy, 1);
        g.fillPoints(points, true);
        g.lineStyle(1.2, COLORS.ink, 0.9);
        g.strokePoints(points, true, true);
      }
      const text = this.cachedText(`mm.legend.${index}`, cursor + shapeR * 2 + shapeGap, top, size, 'left');
      if (text.text !== item.label) text.setText(item.label);
      text.setVisible(true);
      cursor += slotWidth(item) + slotGap;
    });
    // Modes change between matches: hide the slots this one does not use.
    for (let index = items.length; index < 3; index += 1) {
      this.cachedTexts.get(`mm.legend.${index}`)?.setVisible(false);
    }
  }

  /** The local player's barrel heat, drawn under the left-hand health bar. */
  private drawHeatGauge(): void {
    const mine = this.localTank();
    if (!mine) return;
    const ratio = heatRatio(mine.heat);
    const locked = mine.heat.locked;
    // Bottom edge, left of the minimap: private, so it never sits in the
    // shared scoreboard column.
    const x = PLAY_RECT.x + 10;
    const y = GAME_H - 30;
    const w = 140;
    const h = 8;

    this.hud.fillRect(x, y, w, h, COLORS.white, 0.85);
    if (ratio > 0) {
      // Blue while usable, red once the gun is locked out.
      const color = locked ? COLORS.danger : ratio > 0.66 ? 0xd4a72e : 0x2f6fb5;
      this.hud.fillRect(x + 1, y + 1, Math.max(0, (w - 2) * ratio), h - 2, color, 0.95);
    }
    this.hud.rect(x, y, w, h, { width: 1.2, color: COLORS.ink, jitter: 0.5 });

    const label = locked
      ? `过热 ${lockSecondsLeft(mine.heat).toFixed(1)}s`
      : `炮管 ${Math.round(ratio * 100)}%（${shotsToOverheat(heatCfg())} 发）`;
    this.heatText ??= this.hud.text(x + w + 8, y + h / 2, '', 12, COLORS.ink, 'left').setOrigin(0, 0.5).setAlpha(0.8);
    if (this.heatText.text !== label) this.heatText.setText(label);
    this.heatText.setColor(locked ? '#c0392b' : '#26221d');
  }

  // ------------------------------------------------------------------ update

  update(time: number, delta: number): void {
    // The player asked to leave: main.ts is already swapping scenes, so never
    // touch the HUD or the overlay again (that is what used to wedge the app).
    if (this.leaving) return;
    const dt = Math.min(delta, 50) / 1000;

    // Keyboard ownership follows the focused DOM element (text fields, sliders,
    // selects). Without this, every key the game binds was swallowed by Phaser
    // and could not be typed anywhere on the pause screen.
    this.syncKeyCapture();

    const pauseKey = this.keys.get('global.pause')!;
    const typing = this.captureReleased;
    if (!typing && (Phaser.Input.Keyboard.JustDown(pauseKey) || Phaser.Input.Keyboard.JustDown(this.keys.get('global.esc')!))) {
      this.togglePause();
    }
    const muteKey = this.keys.get('global.mute')!;
    if (!typing && muteKey && Phaser.Input.Keyboard.JustDown(muteKey)) {
      sound.setMuted(!sound.muted);
      this.showBanner(sound.muted ? '静音' : '开启声音', 0.8);
    }
    if (!typing && !this.versus) {
      const autoKey = this.keys.get('global.autoDodge');
      if (autoKey && Phaser.Input.Keyboard.JustDown(autoKey)) this.setAutoDodge(!this.autoDodge);
    }

    if (this.paused) {
      this.fx.clear();
      return;
    }

    // A decided match is frozen: no shooting, no driving behind the result card.
    if (this.matchOver && this.phase !== 'lobby') {
      this.fx.clear();
      if (this.hudDirty) this.drawHud();
      return;
    }

    // The heat gauge is private to the shooter and moves every frame, so the
    // HUD has to redraw whenever those two numbers change.
    const mine = this.localTank();
    if (mine) {
      const sig = `${Math.round(heatRatio(mine.heat) * 20)}|${mine.heat.locked ? 1 : 0}`;
      if (sig !== this.heatSig) {
        this.heatSig = sig;
        this.hudDirty = true;
      }
    }
    // The clock in the top bar changes once a second; redraw only then.
    if (this.lanMode && Math.ceil(this.matchElapsed) !== this.clockTick) {
      this.clockTick = Math.ceil(this.matchElapsed);
      this.hudDirty = true;
    }
    if (this.hudDirty) this.drawHud();

    const guest = this.lanMode && this.lanRole === 'guest';

    if (this.phase === 'lobby') {
      // Room lobby: nothing simulates, so nobody gets shot while picking sides.
      this.fx.clear();
      this.minimap.clear();
      return;
    }

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
      if (this.lanMode && this.lanRole === 'host') {
        // Seats p3…p10 each keep their own input line; a seat that has not
        // spoken yet just coasts, so a laggy player cannot stall the match.
        for (const tank of this.extras) {
          const input = this.remoteInputs.get(tank.id) ?? IDLE_INPUT;
          this.applyInput(tank, input, dt, { aimRate: 22 });
          if (input.skill) {
            input.skill = false;
            this.useSkill(tank);
          }
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
    this.updateRespawns();
    for (const tank of this.tanks()) tank.coolDown(dt);
    this.updateMatch(dt);
    this.updatePhase(dt);
    this.followCamera(dt);
    this.refreshToasts(dt);
    this.drawFrame(time);
    this.refreshSkillChip();
    this.refreshNotice();
    for (const tank of this.tanks()) tank.sync(time);
  }

  /**
   * Leaves the match on purpose. Solo and local versus just end; a LAN player
   * is reported as having surrendered, so the others see why the fight stopped.
   */
  public quitMatch(): void {
    if (this.leaving) return;
    this.leaving = true;
    if (this.lanMode) {
      // v1.5.3: name the seat that actually walked out (a guest used to always
      // report itself as p2, so the result card blamed the wrong player).
      this.lan?.send({ t: 'surrender', by: this.localSeatId() });
      this.lan?.close();
      this.lan = null;
    }
    this.paused = false;
    this.matchOver = true;
    this.phase = 'leaving';
    this.respawnQueue.clear();
    this.emitOverlay({ kind: 'hidden' });
    // Deliberately no `this.scene.restart()`: main.ts owns the scene swap
    // (stop Game → start Menu). Restarting here queued a fresh Game boot that
    // ran *after* that stop, so the match scene came back on top of the menu
    // and the whole app looked frozen.
    this.game.events.emit(MATCH_LEFT_EVENT);
  }

  /** This machine's own seat – what the 赢/输 line on the result card reads. */
  private localSeatId(): string {
    if (this.lanMode) return this.myId || (this.lanRole === 'host' ? 'p1' : 'p2');
    return 'p1';
  }

  /** The public scoreboard rows, with the seat names filled in. */
  private resultLines(): { id: string; name: string; team: number; kills: number; deaths: number; hp: number }[] {
    return this.scoreLines().map((line) => ({ ...line, name: this.nameOf(line.id) }));
  }

  /** Extra fields every result card carries (sides + your own verdict). */
  private resultExtras(winners: string[], draw: boolean): {
    mode: 'ffa' | 'team';
    teams: number;
    verdict: 'win' | 'lose' | 'draw';
    elapsed: number;
    canRestart: boolean;
  } {
    const me = this.localSeatId();
    return {
      mode: settings.match.mode,
      teams: this.teamCount,
      verdict: draw ? 'draw' : winners.includes(me) ? 'win' : 'lose',
      elapsed: this.matchElapsed,
      // Only the host can restart a LAN match for everybody.
      canRestart: !this.lanMode || this.lanRole !== 'guest',
    };
  }

  /**
   * Someone left the room in the middle of a match.
   *
   * v1.5.2: a departing player used to end the whole match ("everyone else
   * wins"), which meant one person closing their laptop killed a ten-player
   * game. Now their tank simply leaves the arena, everyone still playing is
   * told who walked out, and the match goes on. It only ends when it is really
   * decided: one player (or one team) is left standing, or the *host* left —
   * in that case nobody is refereeing any more and there is nothing to play.
   */
  private seatLeft(by: string): void {
    if (this.matchOver) return;
    // Before the first shot the roster broadcast already updates the seat list;
    // there is no match to keep alive yet.
    if (this.phase === 'lobby') return;
    this.leftSeat = null;
    const name = this.nameOf(by);
    const first = !this.goneSeats.has(by);
    this.goneSeats.add(by);

    // The host runs the simulation and owns the verdict: for everyone else its
    // exit is the end of this match, not a player walking off the field.
    if (by === 'p1' && this.lanMode) {
      if (this.lanRole === 'guest') {
        this.showBanner('房主离开了房间，这一局作废', 2.6);
        this.finishMatch({
          winners: [],
          draw: false,
          reason: 'host-left',
          scoreboard: this.resultLines(),
          elapsed: this.matchElapsed,
          mode: settings.match.mode,
          teams: this.teamCount,
          surrenderBy: by,
        });
      }
      return;
    }

    // Drop everything that belonged to that seat.
    if (this.byId(by)) this.removeRemoteTank(by);
    this.respawnQueue.delete(by);
    this.remoteInputs.delete(by);
    this.fireCd.delete(by);
    if (first) this.showBanner(`${name} 退出了游戏`, 2.4);
    this.hudDirty = true;
    // Only the host decides whether that was the end of the match.
    if (this.lanMode && this.lanRole === 'host') this.checkLastStanding();
  }

  /**
   * Host: is the match over because everybody else left?
   *
   * FFA: one player left → that player wins. Team mode: one whole team left →
   * that team wins. Zero players left → nobody to tell, nothing to send.
   */
  private checkLastStanding(): void {
    if (!this.lanMode || this.lanRole !== 'host') return;
    if (this.matchOver) return;
    if (this.phase !== 'playing' && this.phase !== 'ready') return;
    const lines = this.resultLines();
    if (!lines.length) return;
    const teamMode = settings.match.mode === 'team';
    let winners: string[] = [];
    if (teamMode) {
      const teams = new Set(lines.map((line) => line.team));
      if (teams.size > 1) return;
      winners = lines.map((line) => line.id);
    } else {
      if (lines.length > 1) return;
      winners = [lines[0].id];
    }
    const payload = {
      winners,
      draw: false,
      reason: 'left' as const,
      scoreboard: lines,
      elapsed: this.matchElapsed,
      mode: settings.match.mode,
      teams: this.teamCount,
      surrenderBy: this.goneSeats.values().next().value as string | undefined,
    };
    this.lan?.send({ t: 'result', ...payload });
    this.finishMatch(payload);
    this.showBanner(
      teamMode
        ? `只剩一队了：${winners.map((id) => this.nameOf(id)).join('、')} 获胜`
        : `只剩 ${this.nameOf(winners[0])} 一个人，这一局归你`,
      2.6
    );
  }

  /** A seat vanished mid-match: wait for a reconnect, then act on it. */
  private checkLeftSeat(): void {
    if (!this.leftSeat || this.time.now < this.leftSeat.at) return;
    const id = this.leftSeat.id;
    this.leftSeat = null;
    this.seatLeft(id);
  }

  private nameOf(id: string): string {
    if (id === 'enemy') return 'CPU';
    if (!this.lanMode) return id === 'p1' ? 'P1' : id.toUpperCase();
    // Ten seats are possible now, so names come from the seat id itself.
    if (id === 'p1') return '房主';
    const seat = id.replace(/^p/, '');
    return `P${seat}`;
  }

  /** Checks the kill target / clock and closes the match when it is decided. */
  private checkMatchEnd(): void {
    if (!this.lanMode || this.matchOver || this.phase !== 'playing') return;
    // Only the host is the referee. Two machines running the win check on their
    // own numbers is how a guest ended up "平局" while the host had a winner.
    if (this.lanRole !== 'host') return;
    const result = this.matchResult();
    if (result.kind === 'running') return;
    const winners = result.kind === 'win' ? result.winners : [];
    const draw = result.kind === 'draw';
    const scoreboard = this.resultLines();
    const payload = {
      winners,
      draw,
      reason: (draw ? 'time' : result.reason) as 'kills' | 'time',
      scoreboard,
      elapsed: this.matchElapsed,
      mode: settings.match.mode,
      teams: this.teamCount,
    };
    // Tell the room first, so every seat shows the same card at the same time.
    this.lan?.send({ t: 'result', ...payload });
    this.finishMatch(payload);
  }

  /** Turns a verdict (host-computed, or relayed by the host) into the result card. */
  private finishMatch(payload: {
    winners: string[];
    draw: boolean;
    reason: 'kills' | 'time' | 'surrender' | 'left' | 'host-left';
    scoreboard: { id: string; name: string; team: number; kills: number; deaths: number; hp: number }[];
    elapsed: number;
    mode?: 'ffa' | 'team';
    teams?: number;
    surrenderBy?: string;
  }): void {
    if (this.matchOver) return;
    this.matchOver = true;
    this.phase = 'matchOver';
    this.leftSeat = null;
    // Whatever ended it (kills, clock, a wipe), every seat gets a card that says
    // 你赢了 / 你输了 from its own point of view.
    this.emitOverlay({
      kind: 'matchOver',
      reason: payload.reason,
      scoreboard: payload.scoreboard,
      winners: payload.winners,
      draw: payload.draw,
      surrenderBy: payload.surrenderBy,
      ...this.resultExtras(payload.winners, payload.draw),
      elapsed: payload.elapsed,
    });
    const verdict = this.resultExtras(payload.winners, payload.draw).verdict;
    if (verdict === 'draw') sound.ping();
    else sound[verdict === 'win' ? 'win' : 'lose']();
  }

  /** Runs the LAN clock and the win check; a no-op outside LAN matches. */
  private updateMatch(dt: number): void {
    if (!this.lanMode || this.matchOver) return;
    const playing = this.phase === 'playing';
    // A seat can also walk out during the 1s countdown, so 'ready' counts too.
    if (!playing && this.phase !== 'ready') return;
    if (playing && this.lanRole === 'host') {
      this.matchElapsed += dt;
      this.checkMatchEnd();
    }
    this.checkLeftSeat();
  }

  private togglePause(): void {
    if (this.phase === 'over' || this.phase === 'victory' || this.phase === 'versusOver') return;
    // Esc on the result card must not turn it into a pause card.
    if (this.matchOver || this.phase === 'matchOver' || this.leaving) return;
    this.paused = !this.paused;
    sound.ui();
    this.emitOverlay(this.paused ? { kind: 'paused' } : { kind: 'hidden' });
  }

  private updatePhase(dt: number): void {
    if (
      this.phase === 'ready' ||
      this.phase === 'playing' ||
      this.phase === 'over' ||
      this.phase === 'victory' ||
      this.phase === 'versusOver' ||
      this.phase === 'matchOver' ||
      this.phase === 'leaving'
    ) {
      return;
    }

    this.phaseTimer -= dt;
    if (this.phaseTimer > 0) return;

    if (this.phase === 'dying') {
      if (this.lanMode) {
        // LAN: dying players come back at a safe point, the match goes on.
        for (const tank of this.tanks()) {
          if (tank.awaitingRespawn) this.scheduleRespawn(tank);
        }
        this.phase = 'playing';
        return;
      }
      if (this.versus) {
        // Local versus: no respawns, whoever is down loses the round outright.
        if (this.p1.hp <= 0 || (this.p2 && this.p2.hp <= 0)) {
          this.phase = 'versusOver';
          const winner: 'p1' | 'p2' = this.p1.hp <= 0 ? 'p2' : 'p1';
          this.emitOverlay({
            kind: 'versusOver',
            winner,
            p1Lives: Math.max(0, Math.round(this.p1.hp)),
            p2Lives: Math.max(0, Math.round(this.p2?.hp ?? 0)),
          });
          sound.lose();
          return;
        }
        return;
      }
      if (this.p1.hp > 0) {
        this.p1.awaitingRespawn = false;
        this.respawn(this.p1);
      } else {
        this.phase = 'over';
        this.emitOverlay({ kind: 'gameover', score: this.score, level: levels()[this.levelIndex].name });
        sound.lose();
      }
      return;
    }

    if (this.phase === 'cleared') {
      this.levelsCleared += 1;
      if (this.levelsCleared < SOLO_CAMPAIGN_LENGTH) {
        this.loadLevel((this.levelIndex + 1) % levels().length);
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

    // v1.3: one control for turning. The gun rides the hull, so aiming is
    // either "the mouse" or "straight ahead" – no second pair of keys.
    let aim: number;
    if (mouseAim) {
      const pointer = this.input.activePointer;
      const mx = pointer.worldX || GAME_W / 2;
      const my = pointer.worldY || GAME_H / 2;
      aim = Math.atan2(my - tank.y, mx - tank.x);
    } else {
      aim = tank.bodyAngle;
    }
    void dt;

    if (this.keyJustDown(prefix, 'skill')) this.useSkill(tank);

    const mouseFire = mouseAim && this.input.activePointer.leftButtonDown();
    const fire = this.keyDown(prefix, 'fire') || mouseFire;
    const slow = this.keyDown(prefix, 'slow');
    return { turn, drive, aim, fire, slow };
  }

  /** Applies one input frame to a tank – shared by local players and the guest. */
  private applyInput(tank: Tank, input: TankInput, dt: number, opts: { slow?: boolean; aimRate?: number } = {}): void {
    if (!tank.alive || tank.awaitingRespawn) return;

    const slow = opts.slow ?? input.slow ?? false;
    // The gun is bolted to the hull: turning the hull turns the barrel too, at
    // the same instant and by the same amount (this is the v1.3 fix – the old
    // order let the barrel stay put in world space while the hull rotated).
    const tune = tuning();
    tank.turnHull(input.turn * tune.turnRate * (slow ? 0.8 : 1) * dt);

    const mul = tank.speedMultiplier(this.time.now);
    const fwd = (slow ? TANK.tacticalSpeed : tune.driveSpeed) * mul;
    const rev = (slow ? TANK.tacticalReverse : tune.reverseSpeed) * mul;
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
      // A finite aim is a *world* angle; the hull angle already includes this
      // frame's turn, so the offset is measured against the new heading.
      tank.aimAt(input.aim, opts.aimRate ?? 10, dt);
    }

    this.separateTanks();

    // Per-tank trigger cooldown (see the field comment). A shot that never left
    // the barrel – muzzle buried in a wall, gun heat-locked – does not eat it.
    const left = (this.fireCd.get(tank.id) ?? 0) - dt;
    if (input.fire && left <= 0) {
      if (this.fire(tank)) this.fireCd.set(tank.id, tune.fireCooldown);
      else this.fireCd.set(tank.id, 0);
    } else {
      this.fireCd.set(tank.id, left);
    }
  }

  // ------------------------------------------------------------------ skills

  /** The skill this seat picked in the menu. */
  private skillFor(tank: Tank): SkillId {
    // v1.4: every seat picks its own skill in the lobby, so the roster wins –
    // but only while a LAN room is open. Solo/versus use the menu choice.
    const chosen = this.lanMode ? this.roster.find((entry) => entry.id === tank.id)?.skill : undefined;
    if (chosen && isSkillId(chosen)) return chosen;
    if (tank.id === 'p2') return this.skillP2;
    return this.skillP1;
  }

  /** Fires the summoner skill, if it is off cooldown. Host-authoritative. */
  useSkill(tank: Tank): boolean {
    if (!tank.alive || this.phase !== 'playing' && this.phase !== 'ready') return false;
    const def = skillById(this.skillFor(tank));
    if (this.time.now < tank.skillReadyAt) {
      sound.ping();
      return false;
    }
    if (def.id === 'weaken' && !this.weakenTarget(tank)) {
      // Nothing legal to hit (a solo run with the CPU already down): do not
      // burn the cooldown on a skill that cannot do anything.
      sound.ping();
      return false;
    }
    tank.skillReadyAt = this.time.now + def.cooldown * 1000;

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
          // A blink that lands you in a stream of shells is not a dodge, so the
          // dash carries 0.5s of invulnerability.
          tank.invulnerableUntil = Math.max(tank.invulnerableUntil, this.time.now + tuning().blinkProtect * 1000);
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
        // Nearest target we are actually allowed to hurt. The old version took
        // `tanks().find(t => t !== tank && t.id !== 'enemy')`, which did nothing
        // at all in solo and slowed a random – often friendly – player in a room.
        const target = this.weakenTarget(tank);
        if (!target) return false;
        target.slowUntil = Math.max(target.slowUntil, this.time.now + def.duration * 1000);
        this.ring(target.x, target.y, def.color);
        this.netEvent('skill', target.x, target.y, { id: target.id, color: def.color });
        break;
      }
    }

    this.showBanner(`${tank.id === 'p1' ? 'P1' : tank.id === 'p2' ? 'P2' : 'CPU'} · ${def.name}`, 0.9);
    sound.ui();
    this.hudDirty = true;
    return true;
  }

  /** Nearest tank that `weaken` may legally slow (see `canDamage`). */
  private weakenTarget(tank: Tank): Tank | null {
    const me = { id: tank.id, team: tank.team, alive: tank.alive };
    let best: Tank | null = null;
    let bestDist = Infinity;
    for (const other of this.tanks()) {
      if (other === tank || !other.alive) continue;
      if (!canDamage(me, { id: other.id, team: other.team, alive: other.alive }, settings.match)) continue;
      const d = Math.hypot(other.x - tank.x, other.y - tank.y);
      if (d < bestDist) {
        bestDist = d;
        best = other;
      }
    }
    return best;
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
    const spots = levels()[levelIndex]?.pickups ?? [];
    const t = tuning();
    this.pickups = spots.map((p, index) =>
      makePickup(
        rollPickupKind(),
        this.layout.rect.x + p.x * this.layout.rect.w,
        this.layout.rect.y + p.y * this.layout.rect.h,
        // v1.3.1: every pickup starts on cooldown and they come back one by
        // one, so the opening seconds are not a race for the health pack.
        t.pickupWarmupStart + index * t.pickupWarmupGap
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
      tank.setHp(tank.hp + 40);
      tank.damage = Math.max(0, tank.damage - 1);
      tank.redraw();
    } else if (p.kind === 'speed') {
      tank.speedUntil = Math.max(tank.speedUntil, now + def.duration * 1000);
    } else {
      tank.shieldUntil = Math.max(tank.shieldUntil, now + def.duration * 1000);
    }

    p.respawn = tuning().pickupRespawn;
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

  /** Throttles the "overheated" banner so it does not spam. */
  private lastHeatWarn = 0;

  // ---- v1.3 multiplayer
  /** Our own seat in a LAN room ('p1' on the host). */
  private myId = 'p1';
  /** Extra remote tanks beyond p2: a room can hold ten players. */
  private extras: Tank[] = [];
  /** Latest input from each remote seat, keyed by id. */
  private remoteInputs = new Map<string, TankInput>();
  /** Seat order + teams, straight from the server (identical for everyone). */
  private roster: {
    id: string;
    team: number;
    skill: string;
    hasSkill?: boolean;
    ready?: boolean;
    name?: string;
  }[] = [];
  /** True once the host pressed 开始; until then the arena is a lobby. */
  matchLive = false;
  /** Seats the room allows, straight from the server. */
  private roomCapacity = 6;
  /** How many teams team-mode currently has (the host can add/remove). */
  private teamCount = 2;
  /** Big maps scroll; small ones keep the classic fixed view. */
  private worldMode = false;
  private worldRect: PlayRect | null = null;
  private noticeLabels: Phaser.GameObjects.Text[] = [];

  /** Seconds since the LAN match started – the time-limit tiebreaker. */
  private matchElapsed = 0;
  /** Whole seconds already painted in the top bar (see update()). */
  private clockTick = -1;
  private matchOver = false;

  /** Guest: the whole match lives on the host, we only read input here. */
  private readGuestInput(_dt: number): TankInput {
    const prefix = 'guest';
    const pointer = this.input.activePointer;
    const tank = this.byId(this.myId) ?? this.p2;
    const aim = tank ? Math.atan2((pointer.worldY || 0) - tank.y, (pointer.worldX || 0) - tank.x) : 0;
    if (this.keyJustDown(prefix, 'skill')) this.guestSkillLatch = true;
    const skill = this.guestSkillLatch;
    // v1.3: no trim keys – the barrel points where the hull points unless the
    // mouse says otherwise.
    const useMouse = Math.abs(pointer.worldX) > 0 || Math.abs(pointer.worldY) > 0;
    const worldAim = useMouse && tank ? aim : (tank?.bodyAngle ?? 0);
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
        if (d < 1e-3) {
          // Two tanks sitting on the exact same pixel (a spawn point shared by
          // more seats than the map has): there is no direction to push along,
          // so pick one that is stable for this pair. Without this they could
          // never come apart and the match looked frozen.
          const seed = ((a.id.charCodeAt(1) || 1) * 31 + (b.id.charCodeAt(1) || 1) * 17) % 360;
          const angle = (seed * Math.PI) / 180;
          a.x -= Math.cos(angle) * 0.8;
          a.y -= Math.sin(angle) * 0.8;
          b.x += Math.cos(angle) * 0.8;
          b.y += Math.sin(angle) * 0.8;
          this.resolveTankWalls(a);
          this.resolveTankWalls(b);
        } else if (d < min) {
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

  /**
   * True when a tank-sized circle fits at (x, y) without touching terrain.
   * Respawn points authored on a coarse grid can sit flush against a wall, and
   * with a 22px hull that put players *inside* the wall on spawn.
   */
  private spawnClear(x: number, y: number, radius: number): boolean {
    const margin = radius + 3;
    for (const box of this.layout.walls) {
      if (circleBox(x, y, margin, box)) return false;
    }
    for (const crate of this.crates) {
      if (crate.alive && circleBox(x, y, margin, crate.box)) return false;
    }
    // Keep everyone inside the playable rect too.
    const r = this.worldRect ?? PLAY_RECT;
    if (x < r.x + margin || y < r.y + margin || x > r.x + r.w - margin || y > r.y + r.h - margin) return false;
    return true;
  }

  /**
   * Finds a spot near `x,y` a tank actually fits in. Tries the point itself, a
   * ring of small offsets, then the arena centre as a last resort.
   */
  private nudgeSpawn(x: number, y: number, radius: number): { x: number; y: number } {
    if (this.spawnClear(x, y, radius)) return { x, y };
    for (let ring = 1; ring <= 6; ring += 1) {
      const distance = ring * (radius + 6);
      for (let i = 0; i < 12; i += 1) {
        const angle = (i / 12) * Math.PI * 2;
        const nx = x + Math.cos(angle) * distance;
        const ny = y + Math.sin(angle) * distance;
        if (this.spawnClear(nx, ny, radius)) return { x: nx, y: ny };
      }
    }
    const r = this.worldRect ?? PLAY_RECT;
    return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
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

  private fire(tank: Tank): boolean {
    if (!tank.alive) return false;
    // Barrel heat: you can tap all day, but holding the trigger cooks the gun.
    if (!tank.canShoot()) {
      if (tank === this.localTank() && this.time.now - this.lastHeatWarn > 700) {
        this.lastHeatWarn = this.time.now;
        this.showBanner('炮管过热，等它冷却', 0.9);
        sound.ping();
      }
      return false;
    }
    const dir = tank.turretAngle;
    const t = tuning();
    const speed = tank.id === 'enemy' ? preset().shellSpeed : t.bulletSpeed;
    // v1.3.1: exactly `maxBounces` for everyone. The old "+1 for the AI" meant
    // the hard preset fired shells that bounced four times.
    const maxBounces = t.maxBounces;

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
      return false;
    }

    const m = tank.muzzle(len, dir);
    tank.addHeat();
    if (!tank.canShoot()) {
      // This shot was the one that filled the bar.
      this.hudDirty = true;
      if (tank === this.localTank()) this.showBanner('炮管过热！强制冷却中…', 1.1);
    }
    const empowered = tank.rageShots > 0;
    if (empowered) tank.rageShots -= 1;
    this.spawnBullet(m.x, m.y, dir, tank.id, speed, maxBounces, empowered ? 2 : 1);
    this.burst(m.x, m.y, dir, tank.id);
    // The angle travels with the event: a guest cannot guess a muzzle direction
    // from a bare (x, y), and drawing every shot pointing right looked broken.
    this.netEvent('fire', m.x, m.y, { id: tank.id, angle: Math.round(dir * 1000) / 1000 });
    // v1.5.3: only a shot fired from this machine kicks this screen. The host
    // simulates every seat's trigger, so a ten-player room used to shake the
    // host's camera ten times a second — the same strobe as a full-screen hit.
    if (this.versus || tank === this.localTank()) this.cameras.main.shake(60, 0.002);
    if (tank.id === 'enemy') sound.enemyFire();
    else sound.fire();

    tank.x -= Math.cos(dir) * 1.4;
    tank.y -= Math.sin(dir) * 1.4;
    this.resolveTankWalls(tank);
    return true;
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
      e.bodyAngle += st.turn * tuning().turnRate * 0.95 * dt;
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
      e.turnHull(st.turn * tuning().turnRate * 0.85 * dt);
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
        const level = levels()[this.levelIndex];
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
          // v1.3.1: the third argument is the shell's *travel angle*. Passing
          // the damage multiplier here (as 1.3.0 did) made the hit-zone maths
          // read a fake bearing, which reversed front and rear damage.
          if (victim) this.damage(victim, b.owner, Math.atan2(b.vy, b.vx), b.dmg);
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

  /**
   * v1.3: health-based, per-part damage.
   *
   * @param incoming direction the shell was travelling (radians). Omitted for
   *   scripted/effect damage, which then uses the frontal value.
   */
  private damage(victim: Tank, attacker: TankId, incoming?: number, multiplier = 1): void {
    if (!victim.alive || victim.awaitingRespawn || this.phase !== 'playing') return;

    // Friendly fire and self damage are two separate switches (see rules.ts).
    const attackerTank = this.tanks().find((t) => t.id === attacker) ?? null;
    if (!canDamage(
      attackerTank ? { id: attackerTank.id, team: attackerTank.team, alive: true } : null,
      { id: victim.id, team: victim.team, alive: victim.alive },
      settings.match
    )) {
      // Blocked by a toggle: still show that the shell connected.
      this.puff(victim.x, victim.y, COLORS.ink, 3);
      return;
    }

    const zone: HitZone = incoming === undefined ? 'front' : hitZone(victim.bodyAngle, incoming);
    const t = tuning();
    const base = zone === 'front' ? t.dmgFront : zone === 'side' ? t.dmgSide : t.dmgBack;
    // 狂暴 shells carry a x2 flag; before 1.3.1 this multiplier was dropped on
    // the floor because it was passed in as the shell's bearing instead.
    const amount = Math.max(1, Math.round(base * (multiplier > 0 ? multiplier : 1)));
    if (victim.shielded()) {
      // Shield / invulnerability: absorb the hit with a visible, audible block.
      this.ring(victim.x, victim.y, PICKUPS.shield.color);
      this.puff(victim.x, victim.y, PICKUPS.shield.color, 5);
      this.netEvent('hit', victim.x, victim.y, { id: victim.id, color: PICKUPS.shield.color });
      sound.ping();
      // v1.3: the *pickup* shield is one-shot – it eats a single hit and is
      // gone. Skill invulnerability still runs for its full duration.
      if (victim.shieldUntil > this.time.now) {
        victim.shieldUntil = 0;
        this.showBanner('护盾挡下一击，已消耗', 1.0);
      }
      return;
    }

    const self = attacker === victim.id;
    victim.setHp(victim.hp - amount);
    victim.damage += 1;
    victim.redraw();
    this.hudDirty = true;
    // Public float: everyone sees the same number, including the shooter.
    this.floatText(victim.x, victim.y - 26, `-${amount}`, zone === 'back' ? COLORS.danger : COLORS.ink);

    if (!this.versus && victim.id !== 'p1') this.score += 150;

    // v1.5.3: only *your own* hull shakes the screen. A hit on somebody else
    // used to flash the whole arena white, which read like you had been hit —
    // and in a ten-player room that is a strobe light. The setting turns even
    // your own shake/flash off.
    if (victim === this.localTank() && settings.hitEffects) {
      this.cameras.main.shake(self ? 150 : 120, self ? 0.006 : 0.004);
      this.cameras.main.flash(90, 220, 200, 170);
    }
    this.puff(victim.x, victim.y, victim.color, 10);
    this.ring(victim.x, victim.y, victim.color);
    this.netEvent('hit', victim.x, victim.y, { id: victim.id, color: victim.color });
    sound.hit();

    if (self) {
      this.showBanner('被自己的炮弹打到了！', 1.0);
    }

    if (victim.hp <= 0) {
      victim.setAlive(false, this.time.now);
      victim.deaths += 1;
      victim.awaitingRespawn = true;
      const killer = this.tanks().find((t) => t.id === attacker);
      if (killer && killer !== victim) killer.kills += 1;
      this.explode(victim.x, victim.y, victim.color);
      // Clear the *victim's* shells, not everyone else's: the old filter kept
      // only the killer's bullets, so one kill wiped every other player's shots
      // out of the air in a free-for-all.
      this.bullets = this.bullets.filter((b) => b.owner !== victim.id);
      if (victim.id === 'enemy') {
        this.score += 1000;
        this.hudDirty = true;
        this.phase = 'cleared';
        this.phaseTimer = 1.5;
        this.showBanner('击毁！', 1.2);
      } else if (this.lanMode) {
        // LAN: a death is a short timeout, never a phase change. Freezing the
        // whole scene here (the old `dying` path) stopped the clock and the win
        // check, so one kill left the match running forever with no result.
        this.queueRespawn(victim);
        this.showBanner(
          `${this.nameOf(victim.id)} 被击毁 · ${tuning().respawnDelay.toFixed(1)} 秒后复活`,
          1.6
        );
      } else {
        this.phase = 'dying';
        this.phaseTimer = tuning().respawnDelay;
        if (!this.versus) this.showBanner('被击毁！', 1.1);
      }
    }
  }

  // ------------------------------------------------------------------ v1.3 match

  /** Current score lines – the single source of truth for the win check. */
  private scoreLines(): ScoreLine[] {
    const list: ScoreLine[] = [];
    for (const tank of this.tanks()) {
      if (tank.id === 'enemy' && !this.lanMode) {
        // Solo: the AI is an opponent but not a competitor for the win check.
        continue;
      }
      list.push({
        id: tank.id,
        team: tank.team,
        kills: tank.kills,
        deaths: tank.deaths,
        hp: tank.hp,
        connected: true,
      });
    }
    if (this.p2) {
      // p2 is already in tanks(); nothing extra.
    }
    return list;
  }

  private matchResult(): MatchResult {
    return evaluateMatch(this.scoreLines(), settings.match, this.matchElapsed);
  }

  /** LAN: park a dead tank for `respawnDelay` seconds, then bring it back. */
  private queueRespawn(tank: Tank): void {
    tank.awaitingRespawn = true;
    const delay = Math.max(0.2, tuning().respawnDelay);
    this.respawnQueue.set(tank.id, this.time.now + delay * 1000);
  }

  /** LAN: hands out respawns whose timeout has elapsed. */
  private updateRespawns(): void {
    if (!this.respawnQueue.size) return;
    const now = this.time.now;
    for (const [id, due] of [...this.respawnQueue]) {
      if (due > now) continue;
      this.respawnQueue.delete(id);
      const tank = this.byId(id);
      if (!tank) continue;
      if (this.matchOver) {
        tank.awaitingRespawn = false;
        continue;
      }
      this.scheduleRespawn(tank);
    }
  }

  /** Hands out a respawn point: mates first in team mode, farthest-away in FFA. */
  private scheduleRespawn(tank: Tank): void {
    const spawns: RespawnCandidate[] = (this.layout.spawns ?? [
      { x: this.layout.player.x, y: this.layout.player.y, angle: this.layout.player.angle, id: 0 },
      { x: this.layout.enemy.x, y: this.layout.enemy.y, angle: this.layout.enemy.angle, id: 1 },
    ]).map((spawn, index) => ({ ...spawn, id: index }));

    const others = this.tanks()
      .filter((t) => t !== tank)
      .map((t) => ({ x: t.x, y: t.y, team: t.team, alive: t.alive && !t.awaitingRespawn }));
    const chosen = chooseRespawn({
      spawns,
      players: others,
      team: tank.team,
      mode: settings.match.mode,
      // Same rule as the first spawn: never come back inside a team-mate.
      isFree: (x, y) =>
        this.spawnClear(x, y, tank.radius) &&
        others.every((o) => !o.alive || Math.hypot(o.x - x, o.y - y) >= TANK.radius * 2 + 6),
    });

    if (!chosen) {
      this.respawn(tank);
      return;
    }
    // Never materialise inside a wall or into another hull: nudge, then walk
    // outward if the point is taken (a ten-seat room shares six spawn points).
    const spot = this.placeSpawn(chosen.x, chosen.y, tank.radius, tank);
    tank.x = spot.x;
    tank.y = spot.y;
    tank.bodyAngle = chosen.angle;
    tank.turretAngle = chosen.angle;
    tank.turretOffset = 0;
    tank.setHp(tank.maxHp);
    tank.coldBarrel();
    tank.setAlive(true, this.time.now);
    // Brief protection so a spawn can never be turned into a free kill.
    tank.invulnerableUntil = this.time.now + tuning().respawnProtect * 1000;
    tank.awaitingRespawn = false;
    tank.sync(this.time.now);
    this.ring(tank.x, tank.y, tank.color);
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

  /** Small drifting number, e.g. the damage a hit just did. */
  private floatText(x: number, y: number, value: string, color: number): void {
    const label = this.add
      .text(x, y, value, {
        fontFamily: FONT,
        fontSize: '20px',
        color: `#${color.toString(16).padStart(6, '0')}`,
      })
      .setOrigin(0.5)
      .setDepth(60);
    this.tweens.add({
      targets: label,
      y: y - 34,
      alpha: 0,
      duration: 700,
      ease: 'Quad.easeOut',
      onComplete: () => label.destroy(),
    });
  }

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

  /**
   * One snapshot for the room.
   *
   * v1.5.3: a *delta* snapshot — only fields that changed since the last one are
   * sent, except for a full keyframe every second (and right after anything
   * structural: a new level, a seat joining, a rematch). Before this, ten tanks
   * × eighteen fields went out thirty times a second, mostly repeating
   * `"hp":100,"kills":0,"shield":0,…` at 60 kB/s per guest.
   *
   * Safety: WebSocket is ordered and reliable, so a delta can never arrive out
   * of order or be lost; the keyframe means a guest that joined mid-match is at
   * most one second away from the full truth.
   */
  private buildSnapshot(): Snapshot {
    this.netSeq += 1;
    const events = this.netEvents;
    this.netEvents = [];
    const keyframe = this.netKeyframe || this.netSeq % 30 === 1;
    this.netKeyframe = false;

    const snap: Snapshot = {
      t: 'state',
      seq: this.netSeq,
      tanks: [],
      bullets: [],
      events,
    };
    if (keyframe) snap.kf = 1;

    // ---- match-wide scalars: only when they differ from what the room has.
    if (keyframe || this.levelIndex !== this.netLast.level) {
      snap.level = this.levelIndex;
      this.netLast.level = this.levelIndex;
    }
    if (keyframe || this.phase !== this.netLast.phase) {
      snap.phase = this.phase;
      this.netLast.phase = this.phase;
    }
    const elapsed = Math.round(this.matchElapsed * 10) / 10;
    if (keyframe || elapsed !== this.netLast.elapsed) {
      snap.elapsed = elapsed;
      this.netLast.elapsed = elapsed;
    }
    if (keyframe || this.score !== this.netLast.score) {
      snap.score = this.score;
      this.netLast.score = this.score;
    }

    // ---- crates: a 0/1 per crate is only worth its bytes when one broke.
    const crates = this.crates.map((c) => (c.alive ? 1 : 0));
    const crateSig = crates.join('');
    if (keyframe || crateSig !== this.netLast.crates) {
      snap.crates = crates;
      this.netLast.crates = crateSig;
    }

    // ---- tanks: per-field diff against the last thing we sent for that seat.
    const now = this.time.now;
    for (const tank of this.tanks()) {
      if (tank.id === 'enemy') continue;
      const left = (until: number): number => Math.max(0, Math.round((until - now) / 100) * 100);
      const full: Required<Omit<TankSnapshot, 'id'>> = {
        x: Math.round(tank.x * 10) / 10,
        y: Math.round(tank.y * 10) / 10,
        body: Math.round(tank.bodyAngle * 100) / 100,
        turret: Math.round(tank.turretAngle * 100) / 100,
        hp: Math.round(tank.hp),
        kills: tank.kills,
        deaths: tank.deaths,
        team: tank.team,
        damage: tank.damage,
        alive: tank.alive ? 1 : 0,
        shield: left(tank.shieldUntil),
        speed: left(tank.speedUntil),
        rage: left(tank.rageUntil),
        slow: left(tank.slowUntil),
        rageShots: tank.rageShots,
        skillCd: left(tank.skillReadyAt),
        heat: Math.round(tank.heat.heat),
        heatLocked: tank.heat.locked ? 1 : 0,
      };
      const previous = this.netLast.tanks.get(tank.id);
      const row: Record<string, string | number> = { id: tank.id };
      let sent = 0;
      for (const key of TANK_WIRE_KEYS) {
        const value = full[key];
        if (keyframe || !previous || previous[key] !== value) {
          row[key] = value;
          sent += 1;
        }
      }
      this.netLast.tanks.set(tank.id, full as unknown as Record<string, number>);
      // A seat that has not moved a millimetre still has to be named, otherwise
      // the guest cannot tell "unchanged" from "gone".
      if (sent || keyframe) snap.tanks.push(row as unknown as TankSnapshot);
    }
    // Seats that left are simply absent; the roster message owns removals.

    // ---- shells are all new every tick: no diff to make, just fewer digits.
    snap.bullets = this.bullets.map((b) => ({
      x: Math.round(b.x * 10) / 10,
      y: Math.round(b.y * 10) / 10,
      vx: Math.round(b.vx),
      vy: Math.round(b.vy),
      owner: b.owner,
      // 1 is the default; only an empowered shell needs the field.
      ...(b.dmg && b.dmg !== 1 ? { dmg: b.dmg } : {}),
    }));

    // ---- pickups: quantised to a tenth of a second, and only when they moved.
    const pickups = this.pickups.map((p) => ({
      kind: p.kind,
      respawn: Math.round(p.respawn * 10) / 10,
    }));
    const pickupSig = pickups.map((p) => `${p.kind}${p.respawn}`).join('|');
    if (keyframe || pickupSig !== this.netLast.pickups) {
      snap.pickups = pickups;
      this.netLast.pickups = pickupSig;
    }

    return snap;
  }

  /** Next snapshot is a full keyframe (level change, new seat, rematch). */
  private requestKeyframe(): void {
    this.netKeyframe = true;
    this.netLast.tanks.clear();
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
    // The host owns the clock: both machines must agree on the time limit.
    if (typeof snap.elapsed === 'number') this.matchElapsed = snap.elapsed;
    const age = Math.min(0.12, (this.time.now - this.snapAt) / 1000);

    // Tanks: smooth towards the authoritative transform.
    //
    // v1.5.3: the host sends deltas, so each row is merged into what this seat
    // last received. A field that is missing simply keeps its previous value —
    // the host re-sends everything once a second (and right after a level
    // change or a new seat), so nothing can drift for long.
    const lerp = Math.min(1, dt * 18);
    for (const st of snap.tanks) {
      // v1.3: any seat, not just p1/p2 – the host tells us who is in the room.
      const tank = this.byId(st.id) ?? (st.id === 'p1' ? this.p1 : this.addRemoteTank(st.id, st.team ?? 0));
      if (!tank) continue;
      const cached = this.tankWire.get(st.id);
      const state: Record<string, number> = cached
        ? { ...cached }
        : {
            x: tank.x, y: tank.y, body: tank.bodyAngle, turret: tank.turretAngle,
            hp: tank.hp, kills: tank.kills, deaths: tank.deaths, team: tank.team,
            damage: tank.damage, alive: tank.alive ? 1 : 0,
            shield: 0, speed: 0, rage: 0, slow: 0, rageShots: 0, skillCd: 0,
            heat: tank.heat.heat, heatLocked: tank.heat.locked ? 1 : 0,
          };
      for (const [key, value] of Object.entries(st)) {
        if (key !== 'id' && typeof value === 'number') state[key] = value;
      }
      this.tankWire.set(st.id, state);

      tank.team = state.team;
      tank.x += (state.x - tank.x) * lerp;
      tank.y += (state.y - tank.y) * lerp;
      tank.bodyAngle = angleLerp(tank.bodyAngle, state.body, lerp);
      tank.turretAngle = angleLerp(tank.turretAngle, state.turret, lerp);
      tank.syncTurret();
      const now = this.time.now;
      tank.shieldUntil = now + state.shield;
      tank.speedUntil = now + state.speed;
      tank.rageUntil = now + state.rage;
      tank.slowUntil = now + state.slow;
      tank.rageShots = state.rageShots;
      tank.skillReadyAt = now + state.skillCd;
      if (tank.hp !== state.hp) tank.setHp(state.hp);
      if (tank.kills !== state.kills || tank.deaths !== state.deaths) {
        // The scoreboard used to stay at 0 on every guest: the host sends these
        // numbers, nobody ever wrote them back.
        tank.kills = state.kills;
        tank.deaths = state.deaths;
        this.hudDirty = true;
      }
      tank.heat = { heat: state.heat, locked: state.heatLocked === 1 };
      if (tank.damage !== state.damage) {
        tank.damage = state.damage;
        tank.redraw();
      }
      if (state.alive === 1 !== tank.alive) tank.setAlive(state.alive === 1, this.time.now);
    }

    // Shells: draw from the snapshot, extrapolated by its age.
    this.bullets = snap.bullets.map((b) => ({
      x: b.x + b.vx * age,
      y: b.y + b.vy * age,
      vx: b.vx,
      vy: b.vy,
      owner: b.owner,
      color: this.byId(b.owner)?.color ?? COLORS.player,
      bounces: 0,
      maxBounces: tuning().maxBounces,
      life: BULLET.lifetime,
      dead: false,
      dmg: b.dmg ?? 1,
      trail: [],
    }));

    if (typeof snap.score === 'number' && this.score !== snap.score) {
      this.score = snap.score;
      this.hudDirty = true;
    }
    if (typeof snap.phase === 'string' && snap.phase !== this.phase && (snap.phase === 'versusOver' || snap.phase === 'playing')) {
      this.phase = snap.phase as Phase;
      this.hudDirty = true;
    }
    if (snap.phase === 'matchOver' && !this.matchOver) {
      // Safety net: the host's `result` message can be lost with the socket at
      // the exact moment a match ends. Rebuild the same verdict from the synced
      // numbers instead of leaving a frozen arena with no card.
      const result = this.matchResult();
      const winners = result.kind === 'win' ? result.winners : [];
      this.finishMatch({
        winners,
        draw: result.kind === 'draw',
        reason: result.kind === 'win' ? result.reason : 'time',
        scoreboard: this.resultLines(),
        elapsed: this.matchElapsed,
        mode: settings.match.mode,
        teams: this.teamCount,
      });
    }
  }

  /** Guest: adopt a snapshot, replaying effects and syncing the level. */
  private applySnapshot(snap: Snapshot): void {
    this.snap = snap;
    this.snapAt = this.time.now;

    if (typeof snap.level === 'number' && snap.level !== this.levelIndex) {
      // Level changed on the host – rebuild the arena locally. Every remote
      // tank is re-created from the snapshot that follows, so ten-player
      // rooms survive a map change too.
      const keepHp = new Map<string, number>();
      for (const tank of this.tanks()) keepHp.set(tank.id, tank.hp);
      const level = levels()[snap.level];
      this.levelIndex = snap.level;
      this.tankWire.clear();
      this.worldMode = !!level.world;
      this.worldRect = level.world ? { x: 0, y: 0, w: level.world.w, h: level.world.h } : null;
      this.layout = buildLayout(level, this.worldRect ?? PLAY_RECT);
      this.applyCamera(this.worldRect ?? PLAY_RECT);
      for (const tank of this.tanks()) tank.destroy();
      this.extras = [];
      this.p2 = undefined;
      const p1Spot = this.nudgeSpawn(this.layout.player.x, this.layout.player.y, TANK.radius);
    this.p1 = new Tank(this, p1Spot.x, p1Spot.y, this.layout.player.angle, 'p1', 20);
      this.p1.setHp(keepHp.get('p1') ?? VERSUS_HP);
      this.enemy = undefined;
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

    // Crates (v1.5.3: only sent when one changed).
    if (snap.crates) {
      let cratesChanged = false;
      snap.crates.forEach((alive, i) => {
        const crate = this.crates[i];
        if (crate && crate.alive !== (alive === 1)) {
          crate.alive = alive === 1;
          cratesChanged = true;
        }
      });
      if (cratesChanged) this.drawCrates();
    }

    // Pickups: the host owns their kinds and respawn timers.
    if (snap.pickups) {
      snap.pickups.forEach((sp, i) => {
        const local = this.pickups[i];
        if (!local) return;
        if (sp.kind && local.kind !== sp.kind) local.kind = sp.kind;
        if (typeof sp.respawn === 'number') {
          local.respawn = sp.respawn;
          if (sp.respawn === 0 && local.pop < 1) local.pop = Math.min(1, local.pop + 0.15);
        }
      });
    }

    // Effects.
    for (const ev of snap.events) {
      if (ev.k === 'fire') {
        this.burst(ev.x, ev.y, ev.angle ?? 0, ev.id ?? 'p1');
        sound.fire();
      } else if (ev.k === 'hit') {
        this.puff(ev.x, ev.y, ev.color ?? COLORS.danger, 8);
        this.ring(ev.x, ev.y, ev.color ?? COLORS.danger);
        // Same rule as the host: only a hit on your own seat moves the camera.
        if (settings.hitEffects && ev.id && ev.id === this.localTank()?.id) {
          this.cameras.main.shake(100, 0.004);
        }
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
    this.drawMinimap();

    if (this.phase === 'playing' || this.phase === 'ready') {
      if (this.lanMode) {
        const mine = this.localTank();
        if (mine?.alive) this.drawAimGuide(g, mine, mine.color, 0.5);
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
        const k = 1 - Math.min(1, p.respawn / Math.max(1, tuning().pickupRespawn));
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

  /** How many bounces the dashed aiming line shows (内测可调, 0..6). */
  aimPreviewBounces(): number {
    const value = tuning().aimBounces;
    return Math.max(0, Math.min(6, Math.round(Number.isFinite(value) ? value : 2)));
  }

  /**
   * The geometry of the preview line: one leg per straight run, plus whether a
   * real reflection happens at its end.
   *
   * A shell with `maxBounces` survives that many bounces and dies on the wall
   * after them, so the preview stops after `bounces + 1` legs. Crates eat
   * shells, so a crate ends the line without a reflection.
   */
  private aimPreviewLegs(
    tank: Tank
  ): { x1: number; y1: number; x2: number; y2: number; bounce: boolean }[] {
    const start = tank.muzzle(44);
    let px = start.x;
    let py = start.y;
    let dx = Math.cos(tank.turretAngle);
    let dy = Math.sin(tank.turretAngle);
    const range = 2200;
    const bounces = this.aimPreviewBounces();
    const crateBoxes = this.crates.filter((crate) => crate.alive).map((crate) => crate.box);
    const legs: { x1: number; y1: number; x2: number; y2: number; bounce: boolean }[] = [];

    for (let b = 0; b <= bounces; b += 1) {
      const wallHit = sweepCircleBox(px, py, BULLET.radius, dx * range, dy * range, this.layout.walls);
      const crateHit = sweepCircleBox(px, py, BULLET.radius, dx * range, dy * range, crateBoxes);
      // `remaining` is the distance left after the hit, so the bigger one is nearer.
      const crateFirst = !!crateHit && (!wallHit || crateHit.remaining > wallHit.remaining);
      const hit = crateFirst ? crateHit : wallHit;
      const len = hit ? range - hit.remaining : range;
      legs.push({
        x1: px,
        y1: py,
        x2: px + dx * len,
        y2: py + dy * len,
        // Only a wall that is not the final stop reflects the shell.
        bounce: b < bounces && !!wallHit && !crateFirst,
      });
      px += dx * len;
      py += dy * len;
      if (!hit || crateFirst) break;
      const r = reflect(dx, dy, hit.nx, hit.ny);
      dx = r.x;
      dy = r.y;
      px += hit.nx * 0.6;
      py += hit.ny * 0.6;
    }
    return legs;
  }

  /**
   * The dashed aiming line: exactly `aimPreviewBounces()` reflections, so the
   * dot count *is* the bounce count. Cosmetic only — `maxBounces` still decides
   * what real shells do.
   */
  private drawAimGuide(g: Phaser.GameObjects.Graphics, tank: Tank, color: number, baseAlpha: number): void {
    const legs = this.aimPreviewLegs(tank);
    const bounces = this.aimPreviewBounces();
    legs.forEach((leg, b) => {
      // Fade along the path, so the far legs read as "maybe" instead of "there".
      const alpha = Math.max(0.12, baseAlpha * (1 - b / (bounces + 1)));
      this.dashedLine(g, leg.x1, leg.y1, leg.x2, leg.y2, color, alpha, 14, 9, b === 0 ? 2.3 : 1.7);
      if (leg.bounce) {
        g.lineStyle(1.4, color, alpha + 0.1);
        g.strokeCircle(leg.x2, leg.y2, 4);
      }
    });
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
