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
        /** Level id, so the room screen can preselect it. */
        id: string;
        name: string;
        custom: boolean;
        waiting: number;
        /** Seats that have confirmed the map (guests, or just you). */
        ready: number;
        total: number;
        synced: boolean;
      } | null;
      /** Every map this machine can offer the room (host-only picker). */
      maps?: { id: string; name: string; custom: boolean }[];
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
      /** Which ruleset decided it, so the card can name the sides. */
      mode?: 'ffa' | 'team';
      /** Team-mode size (2..6); unused in a free-for-all. */
      teams?: number;
      /** The local player's own outcome – the 赢/输 line on the card. */
      verdict?: 'win' | 'lose' | 'draw';
      /** Seconds the match ran, for the "用时" line. */
      elapsed?: number;
      /** False on a LAN guest: the host owns the rematch, not this machine. */
      canRestart?: boolean;
    };

export const OVERLAY_EVENT = 'sketch-tank-overlay';

/**
 * Fired by GameScene when the player leaves a match (pause menu, result card,
 * or the LAN room screen). `main.ts` owns the scene swap, so there is exactly
 * one place that knows how to get back to the menu.
 */
export const MATCH_LEFT_EVENT = 'sketch-tank-match-left';
