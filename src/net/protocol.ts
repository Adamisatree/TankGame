/** Wire format shared by the LAN server, the host and the guest. */

/**
 * Bumped whenever the netcode changes shape. Two machines on different
 * versions refuse to play instead of silently desyncing.
 */
export const PROTOCOL_VERSION = 4;

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
  id: 'p1' | 'p2';
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
}

export interface BulletSnapshot {
  x: number;
  y: number;
  vx: number;
  vy: number;
  owner: 'p1' | 'p2';
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

export type HostMessage =
  | Snapshot
  | { t: 'start'; level: number }
  | { t: 'restart'; level: number }
  | { t: 'chat'; text: string }
  /** A player left on purpose; everyone else sees it as a surrender. */
  | { t: 'surrender'; by: string };

export type ServerMessage =
  | { t: 'joined'; role: NetRole; guest?: boolean; host?: boolean; skill?: string; version?: string; peerVersion?: string }
  | { t: 'paired'; skill?: string }
  | { t: 'peer'; state: 'joined' | 'left'; skill?: string; version?: string }
  | { t: 'reject'; reason: 'version' | 'full' | 'unknown'; hostVersion?: string; yourVersion?: string }
  | { t: 'surrender'; by: string }
  | { t: 'input'; input: TankInput; seq: number }
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
