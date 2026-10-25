export interface LobbySeat {
  id: string;
  name: string;
  skill: string;
  team: number;
  ready: boolean;
  host: boolean;
}

export interface LobbyMatch {
  mode: 'ffa' | 'team';
  winCondition: 'kills' | 'time' | 'both';
  capacity: number;
  killTarget: number;
  timeLimit: number;
  friendlyFire: boolean;
  selfDamage: boolean;
}

export type OverlayState =
  | { kind: 'start' }
  /** Room lobby: everyone waits here until the host starts. */
  | {
      kind: 'lobby';
      roster: LobbySeat[];
      capacity: number;
      mode: 'ffa' | 'team';
      myId: string;
      isHost: boolean;
      hostId: string;
      match: LobbyMatch;
      roomUrl: string;
    }
  | { kind: 'hidden' }
  | { kind: 'paused' }
  | { kind: 'gameover'; score: number; level: string }
  | { kind: 'victory'; score: number }
  | { kind: 'versusOver'; winner: 'p1' | 'p2'; p1Lives: number; p2Lives: number }
  /** LAN match ended: kills/time, with the full public scoreboard. */
  | {
      kind: 'matchOver';
      reason: 'kills' | 'time' | 'surrender';
      scoreboard: { id: string; name: string; team: number; kills: number; deaths: number; hp: number }[];
      winners: string[];
      draw: boolean;
      /** Set when a player left mid-match. */
      surrenderBy?: string;
    };

export const OVERLAY_EVENT = 'sketch-tank-overlay';
