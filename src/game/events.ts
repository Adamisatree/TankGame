export interface LobbySeat {
  id: string;
  name: string;
  /** Only filled in for your own seat – other players' picks stay private. */
  skill: string;
  /** Everyone else only learns that this seat has picked something. */
  hasSkill?: boolean;
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
  /** Map editor, working on a copy of this map. */
  | { kind: 'mapEditor'; map: import('../maps/format').MapFile }
  /** Room lobby: everyone waits here until the host starts. */
  | {
      kind: 'lobby';
      roster: LobbySeat[];
      /** How many teams team-mode has right now. */
      teams: number;
      capacity: number;
      mode: 'ffa' | 'team';
      myId: string;
      isHost: boolean;
      hostId: string;
      match: LobbyMatch;
      roomUrl: string;
      /** The map the room will play, and whether every seat has it yet. */
      map?: {
        name: string;
        custom: boolean;
        waiting: number;
        /** Seats that have confirmed the map (guests, or just you). */
        ready: number;
        total: number;
        synced: boolean;
      } | null;
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
