/** Wire format shared by the LAN server, the host and the guest. */

export type NetRole = 'host' | 'guest';

export interface TankInput {
  /** -1 turn left, 1 turn right. */
  turn: number;
  /** -1 reverse, 1 forward. */
  drive: number;
  /** Absolute turret angle in radians. */
  aim: number;
  fire: boolean;
}

export interface TankSnapshot {
  id: 'p1' | 'p2';
  x: number;
  y: number;
  body: number;
  turret: number;
  lives: number;
  damage: number;
  alive: number;
}

export interface BulletSnapshot {
  x: number;
  y: number;
  vx: number;
  vy: number;
  owner: 'p1' | 'p2';
}

export type NetEventKind = 'fire' | 'hit' | 'bounce' | 'explode' | 'crate' | 'ping';

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
  events: NetEvent[];
}

export type HostMessage =
  | Snapshot
  | { t: 'start'; level: number }
  | { t: 'restart'; level: number }
  | { t: 'chat'; text: string };

export type ServerMessage =
  | { t: 'joined'; role: NetRole; guest?: boolean; host?: boolean }
  | { t: 'paired' }
  | { t: 'peer'; state: 'joined' | 'left' }
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
