/** Design resolution – the game scales to fit any window, keeping this ratio. */
export const GAME_W = 1280;
export const GAME_H = 720;

/** Sketchbook palette. Ink on paper, with a couple of accent colours. */
export const COLORS = {
  paper: 0xf3ead9,
  paperShade: 0xe7d9c2,
  ink: 0x26221d,
  grid: 0xcbbda4,
  /** Player one / friendly. */
  player: 0x3f9c8f,
  /** Player two in local versus. */
  player2: 0x6f5aa8,
  /** Enemy / hostile. */
  enemy: 0xd4552e,
  /** Enemy shells. */
  danger: 0xc0392b,
  crate: 0xb8873f,
  crateLight: 0xd6a75c,
  wallFill: 0xe3d6bf,
  wallHatch: 0xc2b096,
  white: 0xfaf5ea,
  shadow: 0x000000,
} as const;

/** CSS colours for the DOM overlay. */
export const CSS = {
  ink: '#26221d',
  paper: '#f3ead9',
  player: '#3f9c8f',
  player2: '#6f5aa8',
  enemy: '#d4552e',
  danger: '#c0392b',
  muted: '#7a6f5f',
} as const;

export const TANK = {
  radius: 22,
  /** Tactical (driving) speed, px/s. */
  driveSpeed: 232,
  reverseSpeed: 152,
  /** While aiming: slower hull, turret follows the mouse. */
  tacticalSpeed: 128,
  tacticalReverse: 92,
  turnRate: 3.5,
  /** Recoil kick applied to the hull on firing. */
  recoil: 55,
};

export const BULLET = {
  radius: 4.5,
  speedPlayer: 830,
  /** Default enemy speed; the difficulty preset can override it. */
  speedEnemy: 600,
  maxBounces: 4,
  lifetime: 6,
};

/** Seconds of mercy after taking a hit, so one wild shell can't chain-kill you. */
export const HIT_MERCY = 1.1;

export const FONT = '"Patrick Hand", "Comic Sans MS", "Segoe Print", system-ui, sans-serif';

/** A small random rotation, so repeated pencil strokes don't look cloned. */
export function jitterDeg(range = 0.9): number {
  return -range + Math.random() * range * 2;
}
