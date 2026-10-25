export type OverlayState =
  | { kind: 'start' }
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
