export type OverlayState =
  | { kind: 'start' }
  | { kind: 'hidden' }
  | { kind: 'paused' }
  | { kind: 'gameover'; score: number; level: string }
  | { kind: 'victory'; score: number };

export const OVERLAY_EVENT = 'sketch-tank-overlay';
