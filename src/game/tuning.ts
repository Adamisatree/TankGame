/**
 * Internal-test tuning.
 *
 * Every number that decides how the game *feels* lives here instead of being
 * scattered across config.ts, so the balance can be changed from inside the
 * app (内测面板, password-gated) without a rebuild.
 *
 * Rules for this file:
 *  - the defaults below are the shipped balance;
 *  - saved values are merged over the defaults, so a future build that adds a
 *    knob gives it a sane value instead of `undefined`;
 *  - the host's tuning travels with the room config in LAN matches, so two
 *    machines can never simulate different physics.
 */

export type TuningGroup = '开火' | '热量' | '伤害' | '车身' | '复活' | '道具';

export interface Tuning {
  /** Seconds between your own shots. */
  fireCooldown: number;
  /** Player shell speed, px/s. */
  bulletSpeed: number;
  /** How many times a shell may bounce before it dies. */
  maxBounces: number;
  /**
   * How many bounces the dashed aiming line previews. Only cosmetic — it never
   * changes what a shell does — but it is the whole point of the line, so it is
   * tunable per build/room like everything else.
   */
  aimBounces: number;

  /** Heat added per shot (cap is always 100). */
  heatPerShot: number;
  /** Heat bled per second while the gun is usable. */
  heatDecay: number;
  /** Heat bled per second while overheated. */
  overheatCool: number;
  /** The lock lifts once heat drops this low. */
  overheatRelease: number;

  /** Damage by hit zone – nose / flank / engine deck. */
  dmgFront: number;
  dmgSide: number;
  dmgBack: number;
  /** 狂暴 multiplier on the next few shells. */
  rageMultiplier: number;

  /** Hull speeds, px/s. */
  driveSpeed: number;
  reverseSpeed: number;
  /** Hull turn rate, rad/s. */
  turnRate: number;

  /** Seconds a destroyed tank stays out. */
  respawnDelay: number;
  /** Milliseconds of protection after respawning (0..5s). */
  respawnProtect: number;
  /** Seconds of invulnerability a blink grants. */
  blinkProtect: number;

  /** Seconds a picked-up spot stays empty. */
  pickupRespawn: number;
  /** Seconds before the first pickup appears at match start. */
  pickupWarmupStart: number;
  /** Extra delay per pickup, so they do not all pop at once. */
  pickupWarmupGap: number;
}

export const TUNING_DEFAULTS: Tuning = {
  fireCooldown: 0.75,
  bulletSpeed: 830,
  maxBounces: 2,
  aimBounces: 2,

  heatPerShot: 17,
  heatDecay: 12,
  overheatCool: 70,
  overheatRelease: 20,

  dmgFront: 7,
  dmgSide: 9,
  dmgBack: 12,
  rageMultiplier: 2,

  driveSpeed: 232,
  reverseSpeed: 152,
  turnRate: 3.5,

  respawnDelay: 2.5,
  respawnProtect: 1,
  blinkProtect: 0.5,

  pickupRespawn: 12,
  pickupWarmupStart: 3,
  pickupWarmupGap: 1.5,
};

export interface TuningSpec {
  key: keyof Tuning;
  label: string;
  group: TuningGroup;
  min: number;
  max: number;
  step: number;
  unit: string;
  /** Short hint shown next to the slider. */
  hint?: string;
}

/** What the in-app panel renders, in this order. */
export const TUNING_SPEC: TuningSpec[] = [
  { key: 'fireCooldown', label: '射速间隔', group: '开火', min: 0.2, max: 2, step: 0.05, unit: 's', hint: '越小越快' },
  { key: 'bulletSpeed', label: '炮弹速度', group: '开火', min: 300, max: 1500, step: 10, unit: 'px/s' },
  { key: 'maxBounces', label: '反弹次数', group: '开火', min: 0, max: 4, step: 1, unit: '次' },
  {
    key: 'aimBounces',
    label: '瞄准线反弹',
    group: '开火',
    min: 0,
    max: 6,
    step: 1,
    unit: '次',
    hint: '只改那条虚线',
  },

  { key: 'heatPerShot', label: '每发加热', group: '热量', min: 4, max: 50, step: 1, unit: '' },
  { key: 'heatDecay', label: '平时散热', group: '热量', min: 1, max: 40, step: 1, unit: '/s' },
  { key: 'overheatCool', label: '过热散热', group: '热量', min: 10, max: 160, step: 5, unit: '/s' },
  { key: 'overheatRelease', label: '解锁阈值', group: '热量', min: 0, max: 80, step: 5, unit: '' },

  { key: 'dmgFront', label: '正面伤害', group: '伤害', min: 1, max: 40, step: 1, unit: '' },
  { key: 'dmgSide', label: '侧面伤害', group: '伤害', min: 1, max: 40, step: 1, unit: '' },
  { key: 'dmgBack', label: '车尾伤害', group: '伤害', min: 1, max: 40, step: 1, unit: '' },
  { key: 'rageMultiplier', label: '狂暴倍率', group: '伤害', min: 1, max: 3, step: 0.5, unit: '×' },

  { key: 'driveSpeed', label: '前进速度', group: '车身', min: 100, max: 420, step: 4, unit: 'px/s' },
  { key: 'reverseSpeed', label: '倒车速度', group: '车身', min: 60, max: 320, step: 4, unit: 'px/s' },
  { key: 'turnRate', label: '转向速度', group: '车身', min: 1.5, max: 7, step: 0.1, unit: 'rad/s' },

  { key: 'respawnDelay', label: '复活等待', group: '复活', min: 0, max: 10, step: 0.5, unit: 's' },
  { key: 'respawnProtect', label: '复活保护', group: '复活', min: 0, max: 5, step: 0.5, unit: 's' },
  { key: 'blinkProtect', label: '闪现无敌', group: '复活', min: 0, max: 2, step: 0.1, unit: 's' },

  { key: 'pickupRespawn', label: '道具刷新', group: '道具', min: 2, max: 60, step: 1, unit: 's' },
  { key: 'pickupWarmupStart', label: '开局冷却', group: '道具', min: 0, max: 20, step: 0.5, unit: 's', hint: '开局先进 CD' },
  { key: 'pickupWarmupGap', label: '逐个间隔', group: '道具', min: 0, max: 10, step: 0.5, unit: 's' },
];

export const TUNING_GROUPS: TuningGroup[] = ['开火', '热量', '伤害', '车身', '复活', '道具'];

export const TUNING_VERSION = 1;

const STORAGE_KEY = 'tankduel.tuning';

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function clamp(spec: TuningSpec, value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : TUNING_DEFAULTS[spec.key];
  const stepped = Math.round(n / spec.step) * spec.step;
  const bounded = Math.min(spec.max, Math.max(spec.min, stepped));
  // Kill floating noise from the stepping (0.30000000000000004 etc).
  return Math.round(bounded * 1000) / 1000;
}

/** Fills in anything missing, so an old save never breaks a new build. */
export function normalizeTuning(raw: unknown): Tuning {
  const input = (raw ?? {}) as Partial<Record<keyof Tuning, unknown>>;
  const out = { ...TUNING_DEFAULTS };
  for (const spec of TUNING_SPEC) out[spec.key] = clamp(spec, input[spec.key]);
  return out;
}

let active: Tuning = loadTuning();

function loadTuning(): Tuning {
  const store = storage();
  if (!store) return { ...TUNING_DEFAULTS };
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return { ...TUNING_DEFAULTS };
    const parsed = JSON.parse(raw) as { version?: number; values?: unknown };
    // The version is informational: normalizeTuning already tolerates gaps.
    return normalizeTuning(parsed?.values ?? parsed);
  } catch {
    return { ...TUNING_DEFAULTS };
  }
}

/** The numbers the game currently uses. Read it per frame – never cache it. */
export function tuning(): Tuning {
  return active;
}

export function setTuning(patch: Partial<Tuning>): Tuning {
  active = normalizeTuning({ ...active, ...patch });
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify({ version: TUNING_VERSION, values: active }));
  } catch {
    /* private mode / quota – the session still plays with the new values */
  }
  return active;
}

export function setTuningValue(key: keyof Tuning, value: number): Tuning {
  return setTuning({ [key]: value } as Partial<Tuning>);
}

export function resetTuning(): Tuning {
  active = { ...TUNING_DEFAULTS };
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  return active;
}

/** True when anything differs from the shipped balance. */
export function tuningIsCustom(): boolean {
  return TUNING_SPEC.some((spec) => Math.abs(active[spec.key] - TUNING_DEFAULTS[spec.key]) > 1e-9);
}

/** Compact list of what was changed, for the LAN badge / logs. */
export function tuningDiff(): { key: keyof Tuning; label: string; from: number; to: number }[] {
  return TUNING_SPEC.filter((spec) => Math.abs(active[spec.key] - TUNING_DEFAULTS[spec.key]) > 1e-9).map((spec) => ({
    key: spec.key,
    label: spec.label,
    from: TUNING_DEFAULTS[spec.key],
    to: active[spec.key],
  }));
}

// ------------------------------------------------------------------ export / import

export interface TuningFile {
  format: 'tanktuning';
  version: number;
  values: Tuning;
}

export function exportTuning(): TuningFile {
  return { format: 'tanktuning', version: TUNING_VERSION, values: { ...active } };
}

/** Returns null when the payload is not a tuning file. */
export function importTuning(raw: string): Tuning | null {
  try {
    const parsed = JSON.parse(raw) as Partial<TuningFile> & Partial<Tuning>;
    const values = (parsed as TuningFile).values ?? parsed;
    if (!values || typeof values !== 'object') return null;
    return setTuning(values as Partial<Tuning>);
  } catch {
    return null;
  }
}
