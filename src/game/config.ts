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
  /** v1.3: two bounces, down from four – long bank shots were too strong. */
  maxBounces: 2,
  lifetime: 6,
};

/**
 * Seconds between your own shots. 0.24s (four a second) made duels a spray
 * fight; one second per shot makes every trigger pull a decision.
 */
export const FIRE_COOLDOWN = 1.0;

/**
 * v1.3 removed the post-hit mercy window entirely – with 100 HP and per-part
 * damage there is no one-shot kill to protect against. Only respawning gives
 * brief protection, so people can't be spawn-camped.
 */
export const RESPAWN_PROTECT = 1.0;
export const RESPAWN_DELAY = 2.5;

export const FONT = '"Patrick Hand", "Comic Sans MS", "Segoe Print", system-ui, sans-serif';

/** A small random rotation, so repeated pencil strokes don't look cloned. */
export function jitterDeg(range = 0.9): number {
  return -range + Math.random() * range * 2;
}
