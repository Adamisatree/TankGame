/**
 * Map pickups. Touching one fires it immediately and cannot be declined –
 * that is the point: you have to think about where they are before you drive.
 */

export type PickupKind = 'health' | 'speed' | 'shield';

export interface PickupDef {
  kind: PickupKind;
  name: string;
  blurb: string;
  color: number;
  /** Seconds the effect lasts (0 = instant). */
  duration: number;
}

export const PICKUPS: Record<PickupKind, PickupDef> = {
  health: {
    kind: 'health',
    name: '医疗包',
    blurb: '立刻回 40 血（不超过 100）',
    color: 0xc0392b,
    duration: 0,
  },
  speed: {
    kind: 'speed',
    name: '加速',
    blurb: '8 秒内移动速度 +40%',
    color: 0x3f9c8f,
    duration: 8,
  },
  shield: {
    kind: 'shield',
    name: '护盾',
    blurb: '6 秒内挡下一次伤害（挡完就碎）',
    color: 0x2f6fb5,
    duration: 6,
  },
};

export const PICKUP_KINDS: PickupKind[] = ['health', 'speed', 'shield'];

/** Radius used for both drawing and the touch test. */
export const PICKUP_RADIUS = 17;

/** Seconds until a collected pickup comes back. */
export const PICKUP_RESPAWN = 12;

/** Weighted roll – health is the most common, shield the rarest. */
export function rollPickupKind(random: () => number = Math.random): PickupKind {
  const r = random();
  if (r < 0.45) return 'health';
  if (r < 0.75) return 'speed';
  return 'shield';
}

export interface Pickup {
  kind: PickupKind;
  x: number;
  y: number;
  /** Seconds until it returns; 0 = available right now. */
  respawn: number;
  /** Grows 0 -> 1 while the item pops in, drives the little scale animation. */
  pop: number;
}

export function makePickup(kind: PickupKind, x: number, y: number): Pickup {
  return { kind, x, y, respawn: 0, pop: 1 };
}
