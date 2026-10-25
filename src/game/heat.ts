/**
 * Barrel heat.
 *
 * Every shot adds heat, heat bleeds off all the time, and hitting the cap locks
 * the gun until the barrel has cooled back down. The idea is to punish holding
 * the trigger forever without touching the per-shot damage: tapping is free,
 * spraying is not.
 *
 * Pure maths only, so the test suite can check the exact break points.
 */

/** 0..100. */
export const HEAT_MAX = 100;

/** Added per shot. Six shots back-to-back reach the cap. */
export const HEAT_PER_SHOT = 26;

/** Heat bled per second while the barrel is usable. */
export const HEAT_DECAY = 9;

/** Faster bleed while the gun is locked out (overheated). */
export const OVERHEAT_COOL = 45;

/** The lock lifts once heat drops this low. */
export const OVERHEAT_RELEASE = 30;

export interface HeatState {
  /** 0..HEAT_MAX */
  heat: number;
  /** True while the barrel is locked out. */
  locked: boolean;
}

export const coldHeat = (): HeatState => ({ heat: 0, locked: false });

export function canFire(state: HeatState): boolean {
  return !state.locked;
}

/** Applies one shot. Reaching the cap locks the barrel. */
export function afterShot(state: HeatState): HeatState {
  const heat = Math.min(HEAT_MAX, state.heat + HEAT_PER_SHOT);
  return { heat, locked: state.locked || heat >= HEAT_MAX };
}

/** Bleeds heat over `dt` seconds, lifting the lock at the release threshold. */
export function cool(state: HeatState, dt: number): HeatState {
  if (dt <= 0) return state;
  const rate = state.locked ? OVERHEAT_COOL : HEAT_DECAY;
  const heat = Math.max(0, state.heat - rate * dt);
  const locked = state.locked ? heat > OVERHEAT_RELEASE : false;
  return { heat, locked };
}

export function heatRatio(state: HeatState): number {
  return Math.max(0, Math.min(1, state.heat / HEAT_MAX));
}

/** Seconds until the lock lifts, for the HUD countdown. */
export function lockSecondsLeft(state: HeatState): number {
  if (!state.locked) return 0;
  return Math.max(0, (state.heat - OVERHEAT_RELEASE) / OVERHEAT_COOL);
}
