/** Wire format shared by the LAN server, the host and the guest. */

/**
 * Bumped whenever the netcode changes shape. Two machines on different
 * versions refuse to play instead of silently desyncing.
 */
export const PROTOCOL_VERSION = 11;

/**
 * Hard cap on a transferred map blob. A 40×24 grid map is a few kilobytes, so
 * anything near this is either a bug or an attempt to stall the room.
 */
export const MAX_MAP_BYTES = 48 * 1024;

export type NetRole = 'host' | 'guest';

export interface TankInput {
  /** -1 turn left, 1 turn right. */
  turn: number;
  /** -1 reverse, 1 forward. */
  drive: number;
  /** Absolute turret angle in radians. */
  aim: number;
  fire: boolean;
  /** Tactical slow-walk (fine aiming). */
  slow?: boolean;
  /** Set for one frame when the summoner skill button is pressed. */
  skill?: boolean;
}

/**
 * One seat's state.
 *
 * v1.5.3: every field except `id` is optional. A snapshot only carries the
 * fields that changed since the previous one (a full "keyframe" goes out every
 * second and whenever the room changes), so a steady ten-player tick is a
 * fraction of what it used to be. A receiver treats a missing field as "same as
 * last time" — WebSocket is ordered and reliable, and the keyframe bounds any
 * mistake to one second.
 */
export interface TankSnapshot {
  /** v1.3: p1…p10 – a room can hold ten players. */
  id: string;
  x?: number;
  y?: number;
  body?: number;
  turret?: number;
  /** v1.3: health, not lives. */
  hp?: number;
  kills?: number;
  deaths?: number;
  team?: number;
  damage?: number;
  alive?: number;
  /** Milliseconds left on each effect (0 = inactive). */
  shield?: number;
  speed?: number;
  rage?: number;
  slow?: number;
  /** Shells left with double damage. */
  rageShots?: number;
  /** Milliseconds until the skill is ready again. */
  skillCd?: number;
  /** Barrel heat 0..100 and whether the gun is locked out. */
  heat?: number;
  heatLocked?: number;
}

export interface BulletSnapshot {
  x: number;
  y: number;
  vx: number;
  vy: number;
  owner: string;
  /** 1 = normal, 2 = empowered by 狂暴. */
  dmg?: number;
}

/** Pickup state the guest needs to draw the arena identically. */
export interface PickupSnapshot {
  kind?: 'health' | 'speed' | 'shield';
  /** Seconds until it comes back; 0 = on the ground. */
  respawn?: number;
}

export type NetEventKind =
  | 'fire'
  | 'hit'
  | 'bounce'
  | 'explode'
  | 'crate'
  | 'ping'
  | 'pickup'
  | 'skill'
  | 'blink';

export interface NetEvent {
  k: NetEventKind;
  x: number;
  y: number;
  /** For hits/explosions: which tank, or which colour. */
  id?: string;
  color?: number;
  /** Muzzle events: the world angle the shell left at, so guests draw it right. */
  angle?: number;
}

/**
 * The host's map, pushed into the room before a match may start. Receivers
 * normalise the file, store it in their own library and hash it back, so a
 * damaged or stale copy is caught before the first shot is fired.
 */
export interface MapTransfer {
  /** The whole map file (see `maps/format.ts`). */
  map: unknown;
  /** FNV-1a hash of the canonical map, computed by the sender. */
  hash: string;
}

/** One row of the final scoreboard (what the result card renders). */
export interface ResultRow {
  id: string;
  name: string;
  team: number;
  kills: number;
  deaths: number;
  hp: number;
}

/**
 * The host's verdict, sent once when a match ends. Guests do not re-run the
 * win check themselves: two machines must never disagree about who won.
 */
/**
 * Why a match ended.
 *
 * `left` means "everybody else walked out, this is what is left"; `host-left`
 * means the referee itself is gone, so there is no match to continue.
 */
export type MatchEndReason = 'kills' | 'time' | 'surrender' | 'left' | 'host-left';

export interface MatchResultPayload {
  winners: string[];
  draw: boolean;
  reason: MatchEndReason;
  scoreboard: ResultRow[];
  elapsed: number;
  mode: 'ffa' | 'team';
  teams: number;
  /** Seat that quit mid-match (only for a surrender). */
  surrenderBy?: string;
}

export interface Snapshot {
  t: 'state';
  seq: number;
  /** Present on a keyframe and whenever they changed (v1.5.3 deltas). */
  level?: number;
  /**
   * v1.5.4: the room's map *id*, next to the index.
   *
   * Two machines can order their custom-map libraries differently (a map
   * imported on one side, a deleted map on the other), so an index alone can
   * point at a different arena — both sides then play "their own" map, which
   * looks exactly like the game being stuck. The id is resolved first; the
   * index stays as a fallback for a library that does not have the id yet.
   */
  levelId?: string;
  phase?: string;
  /**
   * v1.5.4: the host is paused. Pausing stops the host's update loop, so this
   * is only ever sent in the frame the pause happens — a guest that keeps
   * receiving nothing otherwise cannot tell "host paused" from "host died".
   */
  paused?: 1;
  /** Host's match clock in seconds, so a guest's top bar shows the same time. */
  elapsed?: number;
  score?: number;
  /** One 0/1 per crate; only sent when a crate changed (or on a keyframe). */
  crates?: number[];
  tanks: TankSnapshot[];
  bullets: BulletSnapshot[];
  /**
   * One entry per authored pickup spot, in level order. Only sent when a spot
   * changed (or on a keyframe) — the kinds come from the shared map.
   */
  pickups?: PickupSnapshot[];
  events: NetEvent[];
  /** Set on a full snapshot (every second / after any structural change). */
  kf?: 1;
}

/**
 * Client → server lobby traffic. Kept apart from `ServerMessage` so a `begin`
 * can never be confused with the server's own broadcasts.
 */
export type LobbyMessage =
  | { t: 'skill'; skill: string }
  /** Guest → server: "I have the host's map" (or why I could not take it). */
  | { t: 'map-ack'; id: string; rev: number; hash: string; ok: boolean; reason?: string }
  | { t: 'ready'; ready: boolean }
  | { t: 'team'; id: string; team: number }
  | { t: 'teams'; count: number }
  | { t: 'auto-teams' }
  | { t: 'fill-teams' }
  | { t: 'begin' };

export type HostMessage =
  | Snapshot
  /** Host → room: the map everyone will play (also cached by the server). */
  | ({ t: 'map' } & MapTransfer)
  | { t: 'start'; level: number; levelId?: string }
  | { t: 'restart'; level: number; levelId?: string }
  | { t: 'chat'; text: string }
  /** Host → room: the match is over, and here is exactly how it ended. */
  | ({ t: 'result' } & MatchResultPayload)
  /** A player left on purpose; everyone else sees it as a surrender. */
  | { t: 'surrender'; by: string }
  /** Host → server: room capacity, mode and the shared match rules. */
  | {
      t: 'config';
      mode?: 'ffa' | 'team';
      winCondition?: 'kills' | 'time' | 'both';
      capacity?: number;
      killTarget?: number;
      timeLimit?: number;
      friendlyFire?: boolean;
      selfDamage?: boolean;
      /** Which map the room plays; the guest resolves it by id, not by index. */
      levelId?: string;
      /** 内测 balance knobs, so every machine simulates the same physics. */
      tuning?: Record<string, number>;
    };

export interface RosterEntry {
  id: string;
  /** Display name the player joined with (falls back to the seat id). */
  name?: string;
  /** Only filled in for your own seat (and the host's view). */
  skill: string;
  /** True once that seat has picked a skill – safe to show to everyone. */
  hasSkill?: boolean;
  team: number;
  /** Guests press 准备 in the lobby; the host counts as ready. */
  ready?: boolean;
  host: boolean;
}

export type ServerMessage =
  | {
      t: 'joined';
      role: NetRole;
      /** The seat the server handed us (p1 for the host, p2… for guests). */
      id?: string;
      /** True when this is a reconnecting client taking its old seat back. */
      resumed?: boolean;
      guest?: boolean;
      host?: boolean;
      skill?: string;
      version?: string;
      peerVersion?: string;
      capacity?: number;
    }
  | { t: 'paired'; skill?: string }
  | {
      t: 'roster';
      players: RosterEntry[];
      capacity: number;
      mode: 'ffa' | 'team';
      host: string | null;
      /** How many teams team-mode uses (host can add/remove). */
      teams?: number;
      /** False = still in the lobby; true = a match is running. */
      started?: boolean;
      config?: Record<string, unknown>;
    }
  /** The host started the match; carries the final rules and roster. */
  | {
      t: 'begin';
      config?: Record<string, unknown>;
      roster?: RosterEntry[];
      mode?: 'ffa' | 'team';
      teams?: number;
    }
  | { t: 'config'; config: Record<string, unknown>; tuning?: Record<string, number> }
  | { t: 'peer'; state: 'joined' | 'left'; id?: string; host?: boolean; skill?: string; version?: string }
  | { t: 'reject'; reason: 'version' | 'full' | 'unknown'; hostVersion?: string; yourVersion?: string }
  | { t: 'surrender'; by: string }
  | { t: 'input'; input: TankInput; seq: number; from?: string }
  /** The host's map arrived; store it, then answer with `map-ack`. */
  | ({ t: 'map' } & MapTransfer)
  /** Host only: how many seats have confirmed the map, and who has not. */
  | { t: 'map-status'; waiting: string[]; ready: string[] }
  /** The host tried to start but the lobby is not valid yet. */
  | {
      t: 'lobby-error';
      reason: 'empty-team' | 'map-pending' | 'map-failed';
      teams?: number[];
      /** Seats still missing a map confirmation. */
      waiting?: string[];
      /** Human-readable reason for `map-failed`. */
      detail?: string;
    }
  | { t: 'bye' }
  | { t: 'replaced' };

export const DEFAULT_LAN_PORT = 8787;

/**
 * Works out where the match server lives.
 *  - `same`    : the page was served by the LAN server itself
 *  - an IP/host: explicitly typed (guest pointing at the host machine)
 *  - a full URL: used verbatim
 */
/**
 * Appends the game's socket path to whatever the user typed.
 *
 * v1.6.2: the old version pasted `"/ws"` onto a raw string, so `ws://host:8787/ws/`
 * became `/ws/ws`, and a full `http://host/foo` address lost its path entirely
 * (the room lives under a path when the server is behind a proxy). Now the URL is
 * parsed and the path is kept.
 */
function withSocketPath(url: URL): string {
  const path = url.pathname.replace(/\/+$/, '');
  const full = path.endsWith('/ws') ? path : `${path}/ws`;
  const proto = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${url.host}${full}${url.search}`;
}

export function resolveSocketUrl(raw: string): string {
  const value = raw.trim();
  if (!value) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}/ws`;
  }
  if (/^wss?:\/\//i.test(value) || /^https?:\/\//i.test(value)) {
    try {
      return withSocketPath(new URL(value));
    } catch {
      return value;
    }
  }
  const withPort = /:\d+$/.test(value) ? value : `${value}:${DEFAULT_LAN_PORT}`;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${withPort}/ws`;
}

export function httpBaseOf(raw: string): string {
  const socket = resolveSocketUrl(raw);
  return socket.replace(/^ws/, 'http').replace(/\/ws$/, '');
}
