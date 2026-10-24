export type OverlayState =
  | { kind: 'start' }
  | { kind: 'hidden' }
  | { kind: 'paused' }
  | { kind: 'gameover'; score: number; level: string }
  | { kind: 'victory'; score: number }
  | { kind: 'versusOver'; winner: 'p1' | 'p2'; p1Lives: number; p2Lives: number };

export const OVERLAY_EVENT = 'sketch-tank-overlay';
