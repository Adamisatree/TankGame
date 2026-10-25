/** Wire format shared by the LAN server, the host and the guest. */

/**
 * Bumped whenever the netcode changes shape. Two machines on different
 * versions refuse to play instead of silently desyncing.
 */
export const PROTOCOL_VERSION = 7;

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

export interface TankSnapshot {
  /** v1.3: p1…p10 – a room can hold ten players. */
  id: string;
  x: number;
  y: number;
  body: number;
  turret: number;
  /** v1.3: health, not lives. */
  hp: number;
  kills: number;
  deaths: number;
  team: number;
  damage: number;
  alive: number;
  /** Milliseconds left on each effect (0 = inactive). */
  shield: number;
  speed: number;
  rage: number;
  slow: number;
  /** Shells left with double damage. */
  rageShots: number;
  /** Milliseconds until the skill is ready again. */
  skillCd: number;
  /** Barrel heat 0..100 and whether the gun is locked out. */
  heat: number;
  heatLocked: number;
  /** Summoner skill the player picked (for the notice panel). */
  skill?: string;
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
  kind: 'health' | 'speed' | 'shield';
  /** Seconds until it comes back; 0 = on the ground. */
  respawn: number;
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
}

export interface Snapshot {
  t: 'state';
  seq: number;
  level: number;
  phase: string;
  score: number;
  crates: number[];
  tanks: TankSnapshot[];
  bullets: BulletSnapshot[];
  /** One entry per authored pickup spot, in level order. */
  pickups: PickupSnapshot[];
  events: NetEvent[];
}

/**
 * Client → server lobby traffic. Kept apart from `ServerMessage` so a `begin`
 * can never be confused with the server's own broadcasts.
 */
export type LobbyMessage =
  | { t: 'skill'; skill: string }
  | { t: 'ready'; ready: boolean }
  | { t: 'team'; id: string; team: number }
  | { t: 'teams'; count: number }
  | { t: 'auto-teams' }
  | { t: 'fill-teams' }
  | { t: 'begin' };

export type HostMessage =
  | Snapshot
  | { t: 'start'; level: number }
  | { t: 'restart'; level: number }
  | { t: 'chat'; text: string }
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
  | { t: 'begin'; config?: Record<string, unknown>; roster?: RosterEntry[]; mode?: 'ffa' | 'team'; teams?: number }
  | { t: 'config'; config: Record<string, unknown>; tuning?: Record<string, number> }
  | { t: 'peer'; state: 'joined' | 'left'; id?: string; host?: boolean; skill?: string; version?: string }
  | { t: 'reject'; reason: 'version' | 'full' | 'unknown'; hostVersion?: string; yourVersion?: string }
  | { t: 'surrender'; by: string }
  | { t: 'input'; input: TankInput; seq: number; from?: string }
  /** The host tried to start but the lobby is not valid yet. */
  | { t: 'lobby-error'; reason: 'empty-team'; teams: number[] }
  | { t: 'bye' }
  | { t: 'replaced' };

export const DEFAULT_LAN_PORT = 8787;

/**
 * Works out where the match server lives.
 *  - `same`    : the page was served by the LAN server itself
 *  - an IP/host: explicitly typed (guest pointing at the host machine)
 *  - a full URL: used verbatim
 */
export function resolveSocketUrl(raw: string): string {
  const value = raw.trim();
  if (!value) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}/ws`;
  }
  if (/^wss?:\/\//i.test(value)) return value.endsWith('/ws') ? value : value.replace(/\/$/, '') + '/ws';
  if (/^https?:\/\//i.test(value)) {
    const url = new URL(value);
    const proto = url.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${url.host}/ws`;
  }
  const withPort = /:\d+$/.test(value) ? value : `${value}:${DEFAULT_LAN_PORT}`;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${withPort}/ws`;
}

export function httpBaseOf(raw: string): string {
  const socket = resolveSocketUrl(raw);
  return socket.replace(/^ws/, 'http').replace(/\/ws$/, '');
}
