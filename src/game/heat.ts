/**
 * Barrel heat.
 *
 * Every shot adds heat, heat bleeds off all the time, and hitting the cap locks
 * the gun until the barrel has cooled back down. The idea is to punish holding
 * the trigger forever without touching the per-shot damage: tapping is free,
 * spraying is not.
 *
 * The numbers come from `tuning()` (内测面板), so a balance pass never needs a
 * code change. Pure maths only, so the test suite can check exact break points.
 */

import { tuning } from './tuning';

/** 0..100 – the gauge is a percentage, so the cap never moves. */
export const HEAT_MAX = 100;

export interface HeatConfig {
  /** Added per shot. */
  perShot: number;
  /** Heat bled per second while the barrel is usable. */
  decay: number;
  /** Faster bleed while the gun is locked out (overheated). */
  overheatCool: number;
  /** The lock lifts once heat drops this low. */
  release: number;
}

/** Snapshot of the current tuning, safe to pass around inside one update. */
export function heatCfg(): HeatConfig {
  const t = tuning();
  return {
    perShot: t.heatPerShot,
    decay: t.heatDecay,
    overheatCool: t.overheatCool,
    release: t.overheatRelease,
  };
}

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
export function afterShot(state: HeatState, cfg: HeatConfig = heatCfg()): HeatState {
  const heat = Math.min(HEAT_MAX, state.heat + cfg.perShot);
  return { heat, locked: state.locked || heat >= HEAT_MAX };
}

/** Bleeds heat over `dt` seconds, lifting the lock at the release threshold. */
export function cool(state: HeatState, dt: number, cfg: HeatConfig = heatCfg()): HeatState {
  if (dt <= 0) return state;
  const rate = state.locked ? cfg.overheatCool : cfg.decay;
  const heat = Math.max(0, state.heat - rate * dt);
  const locked = state.locked ? heat > cfg.release : false;
  return { heat, locked };
}

export function heatRatio(state: HeatState): number {
  return Math.max(0, Math.min(1, state.heat / HEAT_MAX));
}

/** Seconds until the lock lifts, for the HUD countdown. */
export function lockSecondsLeft(state: HeatState, cfg: HeatConfig = heatCfg()): number {
  if (!state.locked) return 0;
  return Math.max(0, (state.heat - cfg.release) / cfg.overheatCool);
}

/** How many shots fit in a cold barrel before it locks – used by the panel. */
export function shotsToOverheat(cfg: HeatConfig = heatCfg()): number {
  if (cfg.perShot <= 0) return 99;
  return Math.max(1, Math.ceil(HEAT_MAX / cfg.perShot));
}
