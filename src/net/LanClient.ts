import {
  PROTOCOL_VERSION,
  resolveSocketUrl,
  type HostMessage,
  type NetRole,
  type ServerMessage,
  type Snapshot,
  type TankInput,
} from './protocol';
import { APP_VERSION } from '../version';
import { DEFAULT_MATCH, type MatchConfig } from '../game/rules';
import { looksLikeMap, mapHash, normalizeMapFile, type MapFile } from '../maps/format';
import { archiveReceived, isLibraryFull } from '../maps/store';
import { refreshLevels } from '../maps/registry';

export type LanStatus = 'idle' | 'connecting' | 'waiting' | 'playing' | 'closed' | 'error' | 'rejected';

/**
 * One id per tab, kept alive across scene restarts.
 *
 * The server remembers which seat a session owned for a couple of minutes, so
 * a dropped guest reconnects into *its own* seat and tank instead of walking in
 * as a brand-new player (which also used to drop the whole room to the lobby).
 */
const SESSION_KEY = 'tankduel.session';
function sessionId(): string {
  try {
    const store = globalThis.sessionStorage;
    const existing = store?.getItem(SESSION_KEY);
    if (existing) return existing;
    const fresh = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    store?.setItem(SESSION_KEY, fresh);
    return fresh;
  } catch {
    return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  }
}

export interface LanHandlers {
  onStatus?: (status: LanStatus, detail?: string) => void;
  onSnapshot?: (snap: Snapshot) => void;
  /** Host side: input from a guest, tagged with the seat it came from. */
  onInput?: (input: TankInput, from: string) => void;
  /** Everyone: the current player list (order = seat order). */
  onRoster?: (
    players: {
      id: string;
      team: number;
      skill: string;
      hasSkill?: boolean;
      host: boolean;
      ready?: boolean;
      name?: string;
    }[],
    capacity: number,
    info: {
      started: boolean;
      mode: 'ffa' | 'team';
      host: string | null;
      config: Record<string, unknown> | null;
      teams: number;
    }
  ) => void;
  /** The lobby refused to start (e.g. an empty team, or the map is not synced). */
  onLobbyError?: (info: {
    reason: 'empty-team' | 'map-pending' | 'map-failed';
    teams?: number[];
    waiting?: string[];
    detail?: string;
  }) => void;
  /** The host started the match. */
  onBegin?: (info: { mode: 'ffa' | 'team'; config: Record<string, unknown> | null; teams: number }) => void;
  /** Guest: the host's map arrived (and whether its hash matched). */
  onMap?: (map: MapFile, ok: boolean) => void;
  /** Guest: the room went back to a built-in arena, nothing to store. */
  onMapCleared?: () => void;
  /** Host: how many seats have confirmed the room's map. */
  onMapStatus?: (info: { waiting: string[]; ready: string[] }) => void;
  /** Everyone: the room's shared rules, as set by the host. */
  onConfig?: (config: MatchConfig, tuning?: Record<string, number>) => void;
  /** Our own seat in the room. */
  onSeat?: (id: string, role: 'host' | 'guest') => void;
  onHostMessage?: (msg: HostMessage) => void;
  /** Fired when another seat joins or leaves; `id` is that seat. */
  onPeer?: (state: 'joined' | 'left', id?: string) => void;
  /** The other player's summoner skill choice, announced when pairing. */
  onPeerSkill?: (skill: string) => void;
  onLog?: (line: string) => void;
  /** The other side quit on purpose (not a dropped connection). */
  onSurrender?: (by: string) => void;
}

/**
 * Thin WebSocket wrapper. The host pushes snapshots and consumes `onInput`;
 * the guest consumes `onSnapshot` and pushes input. No game logic lives here.
 */
export class LanClient {
  readonly role: NetRole;
  private ws: WebSocket | null = null;
  private handlers: LanHandlers;
  private seq = 0;
  private status: LanStatus = 'idle';
  private retry = 0;
  private closedByUser = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private url: string;
  /**
   * v1.5.4: a drop is a hiccup, not the end of the match. The server keeps a
   * seat for SESSION_TTL_MS (two minutes), so keep dialling for a bit longer
   * than that with a growing delay; 30 tries ≈ 2.5 minutes.
   */
  private static readonly MAX_RETRIES = 30;
  /** Two frames closer together than this are a backlog, not a live stream. */
  private static readonly SNAP_MIN_GAP_MS = 20;
  /** Snapshot coalescing: the last frame not yet applied, and its arrival time. */
  private snapPending: Snapshot | null = null;
  private snapPendingAt = 0;
  private snapTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSnapAt = 0;
  /** Summoner skill this machine picked; sent with the join message. */
  skill = '';
  /** Messages queued while the socket was still connecting (e.g. a restart). */
  private pending: string[] = [];
  /** Match rules this machine wants the room to use (host only). */
  matchConfig: (MatchConfig & { levelId?: string }) | null = null;
  /** Balance knobs this machine wants the room to use (host only). */
  tuning: Record<string, number> | null = null;
  /** The map this host is putting into the room; sent with `join`. */
  hostMap: MapFile | null = null;
  /** Which map the room plays, as announced by the host (guest side). */
  roomMapId = '';

  constructor(role: NetRole, serverAddress: string, handlers: LanHandlers = {}) {
    this.role = role;
    this.url = resolveSocketUrl(serverAddress);
    this.handlers = handlers;
  }

  get address(): string {
    return this.url;
  }

  get currentStatus(): LanStatus {
    return this.status;
  }

  private setStatus(status: LanStatus, detail?: string): void {
    this.status = status;
    this.handlers.onStatus?.(status, detail);
  }

  connect(): void {
    this.clearRetry();
    // v1.6.2: a frame that was waiting in the burst coalescer belongs to the
    // previous socket; replaying it after a reconnect shows a stale arena.
    this.clearSnapCoalesce();
    this.closedByUser = false;
    this.setStatus('connecting');
    // v1.6 (review finding 1): leftover frames belong to the *previous* socket,
    // which is dead — drop them as this dial starts, not when it succeeds.
    // Clearing in `onopen` instead threw away everything queued *during* this
    // dial too (a 准备 click or 再来一局 in the 0.8–5 s retry window simply
    // vanished), which made those buttons look dead until pressed again.
    this.pending.length = 0;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      this.setStatus('error', String(err));
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.retry = 0;
      // The socket can already be closing here (the server went away between
      // the handshake and this callback); a throwing send would kill the loop.
      this.trySend(
        ws,
        JSON.stringify({
          t: 'join',
          role: this.role,
          session: sessionId(),
          skill: this.skill || undefined,
          version: APP_VERSION,
          protocol: PROTOCOL_VERSION,
          ...(this.role === 'host' && this.hostMap
            ? { map: this.hostMap, mapHash: mapHash(this.hostMap) }
            : {}),
        })
      );
      this.setStatus('waiting');
      // Host-owned rules go out as soon as the room exists, so guests never
      // have to guess the capacity or the damage switches.
      if (this.role === 'host' && this.matchConfig) {
        this.send({ t: 'config', ...this.matchConfig, tuning: this.tuning ?? undefined });
      }
      this.handlers.onLog?.(`已连接 ${this.url}`);
      // Anything asked for while we were still dialling goes out now, in order.
      for (const message of this.pending.splice(0)) {
        this.trySend(ws, message);
      }
    };

    ws.onmessage = (event) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      switch (msg.t) {
        case 'reject':
          // Different build: refuse clearly instead of desyncing five seconds in.
          this.closedByUser = true;
          this.setStatus(
            'rejected',
            msg.reason === 'version'
              ? `版本不一致：房主 ${msg.hostVersion ?? '?'}，你是 ${msg.yourVersion ?? APP_VERSION}。请两边用同一版本。`
              : '房间拒绝了这次连接。'
          );
          try {
            this.ws?.close();
          } catch {
            /* already gone */
          }
          break;
        case 'surrender':
          // Relayed by the server when the other side quits on purpose.
          this.handlers.onSurrender?.(msg.by);
          break;
        case 'joined':
          if (msg.id) this.handlers.onSeat?.(msg.id, this.role);
          if (msg.skill) this.handlers.onPeerSkill?.(msg.skill);
          if (this.role === 'guest' && msg.host) this.setStatus('playing');
          break;
        case 'paired':
          if (msg.skill) this.handlers.onPeerSkill?.(msg.skill);
          this.setStatus('playing');
          this.handlers.onPeer?.('joined');
          this.handlers.onLog?.('对手已加入');
          break;
        case 'peer':
          if (msg.skill) this.handlers.onPeerSkill?.(msg.skill);
          this.handlers.onPeer?.(msg.state, msg.id);
          if (msg.state === 'joined') this.setStatus('playing');
          if (msg.state === 'left') this.setStatus('waiting', '对手已离开');
          break;
        case 'input':
          this.handlers.onInput?.(msg.input, msg.from ?? 'p2');
          break;
        case 'config': {
          const raw = (msg.config ?? {}) as Record<string, unknown>;
          const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
          const hostTuning = raw.tuning && typeof raw.tuning === 'object' ? (raw.tuning as Record<string, number>) : undefined;
          this.handlers.onConfig?.({
            mode: raw.mode === 'team' ? 'team' : 'ffa',
            winCondition:
              raw.winCondition === 'kills' || raw.winCondition === 'time' || raw.winCondition === 'both'
                ? raw.winCondition
                : DEFAULT_MATCH.winCondition,
            capacity: num(raw.capacity, DEFAULT_MATCH.capacity),
            killTarget: num(raw.killTarget, DEFAULT_MATCH.killTarget),
            timeLimit: num(raw.timeLimit, DEFAULT_MATCH.timeLimit),
            friendlyFire: raw.friendlyFire === true,
            selfDamage: raw.selfDamage !== false,
          }, hostTuning);
          break;
        }
        case 'roster':
          this.handlers.onRoster?.(msg.players ?? [], msg.capacity ?? 0, {
            started: !!msg.started,
            mode: msg.mode === 'team' ? 'team' : 'ffa',
            host: msg.host ?? null,
            config: (msg.config as Record<string, unknown> | undefined) ?? null,
            teams: typeof msg.teams === 'number' ? msg.teams : 2,
          });
          break;
        case 'lobby-error':
          this.handlers.onLobbyError?.({
            reason: msg.reason ?? 'empty-team',
            teams: msg.teams ?? [],
            waiting: msg.waiting ?? [],
            detail: msg.detail,
          });
          break;
        case 'map':
          // Host already owns the map; only a guest has to store it.
          if (this.role !== 'guest') break;
          // `map: null` = the room went back to a built-in arena.
          if (!msg.map) {
            this.roomMapId = '';
            this.handlers.onMapCleared?.();
            break;
          }
          this.takeMap(msg.map, msg.hash);
          break;
        case 'map-status':
          this.handlers.onMapStatus?.({ waiting: msg.waiting ?? [], ready: msg.ready ?? [] });
          break;
        case 'begin':
          this.handlers.onBegin?.({
            mode: msg.mode === 'team' ? 'team' : 'ffa',
            config: (msg.config as Record<string, unknown> | undefined) ?? null,
            teams: msg.teams ?? 2,
          });
          break;
        case 'bye':
          this.handlers.onLog?.('连接结束');
          break;
        case 'replaced':
          // v1.6.2: the server now strips the old socket's privileges, and this
          // side closes too — a replaced connection has nothing left to say.
          this.handlers.onLog?.('房间被同一角色的新连接取代');
          this.closedByUser = true;
          this.handlers.onStatus?.('closed', '这个座位已在别处重新连接');
          try {
            this.ws?.close();
          } catch {
            /* already gone */
          }
          break;
        default:
          break;
      }

      // Host messages (state/start/restart/chat) reach guests here.
      const maybe = msg as unknown as HostMessage;
      if (
        maybe &&
        (maybe.t === 'state' ||
          maybe.t === 'start' ||
          maybe.t === 'restart' ||
          maybe.t === 'chat' ||
          maybe.t === 'result')
      ) {
        if (maybe.t === 'state') this.routeSnapshot(maybe);
        else this.handlers.onHostMessage?.(maybe);
      }
    };

    ws.onerror = () => {
      this.setStatus('error', '无法连接，请检查地址 / 防火墙');
    };

    ws.onclose = () => {
      // v1.6.2: `reject` (version mismatch, full room) closes the socket itself,
      // and the follow-up `closed` overwrote the explanation within a frame —
      // players saw 「连接已断开」 and never learned why.
      if (this.status === 'rejected') return;
      if (this.closedByUser) {
        this.setStatus('closed');
        return;
      }
      // v1.5.4: keep dialling. Two tries (~2 s) used to turn one Wi-Fi hiccup
      // into a permanent "连接已断开" — the server holds our seat for two
      // minutes, so retry with a growing delay for about 2.5 minutes and let
      // the room hand the old seat (and tank) back.
      if (this.retry < LanClient.MAX_RETRIES) {
        this.retry += 1;
        const delay = LanClient.retryDelay(this.retry);
        this.setStatus('connecting', `连接中断，正在自动重连（第 ${this.retry} 次）…`);
        this.clearRetry();
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          if (!this.closedByUser) this.connect();
        }, delay);
      } else {
        this.setStatus('closed', '多次重连失败：房主可能已离线，回菜单重新加入');
      }
    };
  }

  /** Lobby: announce what this seat picked / whether it is ready. */
  setSkill(skill: string): void {
    this.skill = skill;
    this.sendRaw({ t: 'skill', skill });
  }

  setReady(ready: boolean): void {
    this.sendRaw({ t: 'ready', ready });
  }

  setTeam(id: string, team: number): void {
    this.sendRaw({ t: 'team', id, team });
  }

  autoTeams(): void {
    this.sendRaw({ t: 'auto-teams' });
  }

  /** Host: how many teams team-mode has. */
  setTeamCount(count: number): void {
    this.sendRaw({ t: 'teams', count });
  }

  /** Host: move players so no team is empty. */
  fillTeams(): void {
    this.sendRaw({ t: 'fill-teams' });
  }

  /** Host only: start the match for everyone. */
  begin(): void {
    this.sendRaw({ t: 'begin' });
  }

  /**
   * Host only: put this map into the room. The server caches it, hands it to
   * every guest and waits for their confirmations before `begin` is accepted.
   */
  sendMap(map: MapFile): void {
    this.hostMap = map;
    this.send({ t: 'map', map, hash: mapHash(map) });
  }

  /**
   * Host: the room switched back to a built-in map. Clearing has to reach the
   * server (it caches the map and gates `begin` on the acks), otherwise the
   * room would sit waiting for a file that is never coming.
   */
  clearMap(): void {
    this.hostMap = null;
    this.send({ t: 'map', map: null, hash: '' });
  }

  /**
   * Guest: store the host's map, then answer with its revision + hash so the
   * host can tell "same map" from "a different map that happens to share an id".
   */
  private takeMap(raw: unknown, hash: string): void {
    let stored: MapFile | null = null;
    let ok = false;
    // v1.6.2: every failure used to report 「地图文件读不出来」, including a full
    // library. The host needs the real reason to know whether to retry.
    let reason = '地图文件读不出来';
    try {
      if (!looksLikeMap(raw)) {
        reason = '收到的不是地图文件';
      } else {
        stored = archiveReceived(normalizeMapFile(raw));
        if (!stored) {
          reason = isLibraryFull() ? '本机地图库满了，存不下这张图' : '本机存不下这张图（浏览器存储已满或被禁用）';
        } else {
          // The library may have kept a newer revision of the same id; the hash
          // has to match what the host is about to play, or the arena would differ.
          ok = mapHash(stored) === hash;
          if (!ok) reason = '地图校验失败';
        }
      }
    } catch {
      ok = false;
    }
    if (stored) {
      this.roomMapId = stored.id;
      refreshLevels();
      this.handlers.onMap?.(stored, ok);
      this.sendRaw({
        t: 'map-ack',
        id: stored.id,
        rev: stored.rev,
        hash,
        ok,
        ...(ok ? {} : { reason }),
      });
      this.handlers.onLog?.(ok ? `收到房主地图 ${stored.name}` : `地图 ${stored.name} 校验失败`);
      return;
    }
    this.sendRaw({ t: 'map-ack', id: '', rev: 0, hash, ok: false, reason });
  }

  /**
   * v1.5.4: the one place a frame leaves this machine.
   *
   * A browser WebSocket that is CLOSING / CLOSED throws `InvalidStateError` from
   * `send()`, and between the `readyState` check and the call there is a real
   * race (the socket can die in that gap). An exception thrown from here used to
   * escape the Phaser `update()` — a snapshot is sent 30 times a second — and
   * kill the requestAnimationFrame loop for good: the whole screen froze.
   * Nothing in the game may throw because a socket went away, so every send is
   * funnelled through this and swallows the failure. Returns false when the
   * frame was not written.
   */
  private trySend(ws: WebSocket | null, payload: string): boolean {
    if (!ws) return false;
    try {
      if (ws.readyState !== WebSocket.OPEN) return false;
      ws.send(payload);
      return true;
    } catch {
      return false;
    }
  }

  /** Raw envelope for lobby messages that are not HostMessages. */
  private sendRaw(message: Record<string, unknown>): void {
    this.write(message, true);
  }

  /** 30Hz guest → host. */
  sendInput(input: TankInput): void {
    if (this.role !== 'guest') return;
    this.seq += 1;
    // Input is state, not an event: a frame that missed its moment is worthless,
    // so this never queues and never throws.
    this.write({ t: 'input', input, seq: this.seq }, false);
  }

  /** 30Hz host → guest. */
  sendSnapshot(snap: Snapshot): void {
    // Deltas are only meaningful in order: queueing a stale one and replaying it
    // later would apply an old diff to a newer state. The next keyframe (≤1 s)
    // repairs whatever was dropped, so a closed socket simply skips it.
    this.write(snap, false);
  }

  send(message: HostMessage): void {
    // Control traffic (restart / config / map) still gets the short queue so a
    // frame fired right after connect() survives the handshake.
    this.write(message, true);
  }

  /** Serialise once, then either write it now or keep it for the handshake. */
  private write(message: object, queue: boolean): void {
    let payload: string;
    try {
      payload = JSON.stringify(message);
    } catch {
      return;
    }
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN && this.trySend(ws, payload)) return;
    if (!queue) return;
    // v1.6.2: a full queue used to drop the new message silently. Control
    // messages are *state* (ready / begin / config / map): only the newest one
    // matters, so replace the previous message of the same kind.
    if (this.pending.length >= 20) {
      const kind = (message as { t?: string }).t;
      const at = kind ? this.pending.findIndex((m) => m.startsWith(`{"t":"${kind}"`)) : -1;
      if (at < 0) return;
      this.pending.splice(at, 1);
    }
    this.pending.push(payload);
  }

  /**
   * v1.5.4: hand a snapshot to the game, unless frames are arriving faster than
   * the screen can use them.
   *
   * A guest that was throttled (background tab, slow machine) comes back to a
   * burst of queued frames. Applying all of them plays minutes of old sounds and
   * leaves the arena interpolating towards where the host was several seconds
   * ago — the "everyone else is fine, I am stuck" freeze. Frames at the normal
   * 30 Hz cadence go straight through; only a burst is collapsed, keeping the
   * newest frame (a keyframe always wins: it is the only thing that repairs a
   * delta that was dropped).
   */
  private routeSnapshot(snap: Snapshot): void {
    // v1.6 (review finding 2): a monotonic clock. On Windows `Date.now()` can
    // tick in ~15.6 ms steps, which is the same order as the 20 ms window — a
    // real 30 Hz stream could then read as a burst (and be folded), or a burst
    // as a live stream. `performance.now()` is sub-millisecond everywhere we
    // run (browser, jsdom, Node) and never jumps when the system clock is set.
    const now = LanClient.clock();
    const gap = now - this.lastSnapAt;
    this.lastSnapAt = now;

    if (gap >= LanClient.SNAP_MIN_GAP_MS && !this.snapTimer) {
      this.handlers.onSnapshot?.(snap);
      return;
    }

    // Burst: keep the newest, but never throw away a keyframe in favour of an
    // older delta.
    const pendingIsKeyframe = this.snapPending?.kf === 1;
    if (snap.kf === 1 || !pendingIsKeyframe) {
      this.snapPending = snap;
      this.snapPendingAt = now;
    }
    if (this.snapTimer) return;
    this.snapTimer = setTimeout(() => {
      this.snapTimer = null;
      const kept = this.snapPending;
      this.snapPending = null;
      if (kept && !this.closedByUser) {
        this.lastSnapAt = Math.max(this.lastSnapAt, this.snapPendingAt);
        this.handlers.onSnapshot?.(kept);
      }
    }, LanClient.SNAP_MIN_GAP_MS);
  }

  /** Anything queued from a burst is dropped on teardown. */
  private clearSnapCoalesce(): void {
    if (this.snapTimer !== null) {
      clearTimeout(this.snapTimer);
      this.snapTimer = null;
    }
    this.snapPending = null;
  }

  /** Monotonic milliseconds; falls back if a host has no `performance`. */
  private static clock(): number {
    const perf = globalThis.performance;
    return typeof perf?.now === 'function' ? perf.now() : Date.now();
  }

  /** Exponential backoff: 0.8 s, 1.6 s, 3.2 s, then 5 s. */
  private static retryDelay(attempt: number): number {
    return Math.min(800 * 2 ** Math.max(0, attempt - 1), 5000);
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  close(): void {
    this.closedByUser = true;
    this.clearRetry();
    this.clearSnapCoalesce();
    this.pending.length = 0;
    const ws = this.ws;
    this.ws = null;
    // Drop the handlers first: a socket closing during teardown must not trigger
    // a reconnect or touch a scene that is already shutting down.
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      try {
        ws.close();
      } catch {
        /* already gone */
      }
    }
    this.status = 'closed';
  }
}

/** Best-effort LAN address list, used by the host panel to tell friends where to go. */
export async function fetchLanInfo(
  serverAddress: string
): Promise<{ addresses: string[]; players: number; port?: number } | null> {
  try {
    const socket = resolveSocketUrl(serverAddress);
    const base = socket.replace(/^ws/, 'http').replace(/\/ws$/, '');
    const res = await fetch(`${base}/info`, { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as { addresses: string[]; players: number; port?: number };
  } catch {
    return null;
  }
}
