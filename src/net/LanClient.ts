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
import { mapHash, normalizeMapFile, type MapFile } from '../maps/format';
import { archiveReceived } from '../maps/store';
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
  private retryTimer: number | null = null;
  private url: string;
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
    this.closedByUser = false;
    this.setStatus('connecting');
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
      ws.send(
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
      // Anything asked for while we were still dialling goes out now.
      for (const message of this.pending.splice(0)) {
        try {
          ws.send(message);
        } catch {
          /* socket died mid-flush */
        }
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
          this.handlers.onLog?.('房间被同一角色的新连接取代');
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
        if (maybe.t === 'state') this.handlers.onSnapshot?.(maybe);
        else this.handlers.onHostMessage?.(maybe);
      }
    };

    ws.onerror = () => {
      this.setStatus('error', '无法连接，请检查地址 / 防火墙');
    };

    ws.onclose = () => {
      if (this.closedByUser) {
        this.setStatus('closed');
        return;
      }
      // One quick automatic retry keeps a flaky Wi-Fi hiccup from ending the match.
      if (this.retry < 2) {
        this.retry += 1;
        this.setStatus('connecting', `连接中断，重试中 (${this.retry}/2)`);
        this.clearRetry();
        this.retryTimer = window.setTimeout(() => {
          this.retryTimer = null;
          if (!this.closedByUser) this.connect();
        }, 900);
      } else {
        this.setStatus('closed', '连接已断开');
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
    try {
      stored = archiveReceived(normalizeMapFile(raw));
      // The library may have kept a newer revision of the same id; the hash has
      // to match what the host is about to play, or the arena would differ.
      ok = !!stored && mapHash(stored) === hash;
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
        ...(ok ? {} : { reason: '地图校验失败' }),
      });
      this.handlers.onLog?.(ok ? `收到房主地图 ${stored.name}` : `地图 ${stored.name} 校验失败`);
      return;
    }
    this.sendRaw({ t: 'map-ack', id: '', rev: 0, hash, ok: false, reason: '地图文件读不出来' });
  }

  /** Raw envelope for lobby messages that are not HostMessages. */
  private sendRaw(message: Record<string, unknown>): void {
    const payload = JSON.stringify(message);
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      if (this.pending.length < 20) this.pending.push(payload);
      return;
    }
    this.ws.send(payload);
  }

  /** 30Hz guest → host. */
  sendInput(input: TankInput): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.role !== 'guest') return;
    this.seq += 1;
    this.ws.send(JSON.stringify({ t: 'input', input, seq: this.seq }));
  }

  /** 30Hz host → guest. */
  sendSnapshot(snap: Snapshot): void {
    this.send(snap);
  }

  send(message: HostMessage): void {
    const payload = JSON.stringify(message);
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // Queue briefly: a restart fired right after connect() must not be lost.
      if (this.pending.length < 20) this.pending.push(payload);
      return;
    }
    this.ws.send(payload);
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  close(): void {
    this.closedByUser = true;
    this.clearRetry();
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
