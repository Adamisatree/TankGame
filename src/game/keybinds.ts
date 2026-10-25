/**
 * Rebinding support.
 *
 * Keys are stored as numeric `keyCode` values because that is exactly what
 * Phaser's `addKey` accepts, and it lets the menu "press the key you want"
 * flow work without any name parsing. Everything is kept per context so solo,
 * local versus and LAN can each have their own layout.
 */

/**
 * v1.3 dropped the separate "swing the gun left/right" actions: turning the
 * hull turns the gun with it, and the barrel only trims inside its arc.
 */
export type SeatAction = 'up' | 'down' | 'left' | 'right' | 'fire' | 'slow' | 'skill';
export type GlobalAction = 'pause' | 'mute' | 'autoDodge';
export type BindingContext = 'solo' | 'versus' | 'lan';

export type SeatBindings = Record<SeatAction, number>;
export type GlobalBindings = Record<GlobalAction, number>;

export interface BindingsFile {
  version: 1;
  solo: SeatBindings;
  versus: { p1: SeatBindings; p2: SeatBindings };
  lan: { host: SeatBindings; guest: SeatBindings };
  global: GlobalBindings;
}

export const SEAT_ACTIONS: SeatAction[] = ['up', 'down', 'left', 'right', 'fire', 'slow', 'skill'];

export const ACTION_LABEL: Record<SeatAction, string> = {
  up: '前进 / 加速',
  down: '后退',
  left: '左转',
  right: '右转',
  fire: '开火',
  slow: '慢速微调（曲射/稳住）',
  skill: '召唤师技能',
};

export const GLOBAL_LABEL: Record<GlobalAction, string> = {
  pause: '暂停',
  mute: '静音',
  autoDodge: '自动躲弹（单人）',
};

/** keyCode values, matching Phaser.Input.Keyboard.KeyCodes. */
const K = {
  W: 87,
  A: 65,
  S: 83,
  D: 68,
  Q: 81,
  E: 69,
  F: 70,
  P: 80,
  M: 77,
  G: 71,
  SPACE: 32,
  ENTER: 13,
  SHIFT: 16,
  COMMA: 188,
  PERIOD: 190,
  SLASH: 191,
  UP: 38,
  DOWN: 40,
  LEFT: 37,
  RIGHT: 39,
  TAB: 9,
  X: 88,
  Z: 90,
  C: 67,
  V: 86,
  B: 66,
  R: 82,
  T: 84,
  Y: 89,
  U: 85,
  I: 73,
  O: 79,
  J: 74,
  K: 75,
  L: 76,
  N: 78,
  H: 72,
  ONE: 49,
  TWO: 50,
  THREE: 51,
};

const WASD_DRIVE = { up: K.W, down: K.S, left: K.A, right: K.D };
const ARROW_DRIVE = { up: K.UP, down: K.DOWN, left: K.LEFT, right: K.RIGHT };

export function defaultBindings(): BindingsFile {
  return {
    version: 1,
    solo: { ...WASD_DRIVE, fire: K.SPACE, slow: K.SHIFT, skill: K.F },
    versus: {
      p1: { ...WASD_DRIVE, fire: K.SPACE, slow: K.SHIFT, skill: K.R },
      p2: { ...ARROW_DRIVE, fire: K.ENTER, slow: K.SHIFT, skill: K.SLASH },
    },
    lan: {
      host: { ...WASD_DRIVE, fire: K.SPACE, slow: K.SHIFT, skill: K.F },
      guest: { ...WASD_DRIVE, fire: K.SPACE, slow: K.SHIFT, skill: K.F },
    },
    global: { pause: K.P, mute: K.M, autoDodge: K.G },
  };
}

// v2: the aimLeft/aimRight actions are gone.
const STORAGE_KEY = 'tankgame.bindings.v2';
let current: BindingsFile | null = null;

function sanitize(raw: unknown): BindingsFile {
  const fallback = defaultBindings();
  if (!raw || typeof raw !== 'object') return fallback;
  const src = raw as Partial<BindingsFile>;

  const seat = (value: unknown, base: SeatBindings): SeatBindings => {
    const out = { ...base };
    if (value && typeof value === 'object') {
      for (const action of SEAT_ACTIONS) {
        const code = (value as Record<string, unknown>)[action];
        if (typeof code === 'number' && code > 0 && code < 256) out[action] = code;
      }
    }
    return out;
  };

  const global = { ...fallback.global };
  if (src.global && typeof src.global === 'object') {
    for (const action of ['pause', 'mute', 'autoDodge'] as GlobalAction[]) {
      const code = (src.global as Record<string, unknown>)[action];
      if (typeof code === 'number' && code > 0 && code < 256) global[action] = code;
    }
  }

  return {
    version: 1,
    solo: seat(src.solo, fallback.solo),
    versus: {
      p1: seat(src.versus?.p1, fallback.versus.p1),
      p2: seat(src.versus?.p2, fallback.versus.p2),
    },
    lan: {
      host: seat(src.lan?.host, fallback.lan.host),
      guest: seat(src.lan?.guest, fallback.lan.guest),
    },
    global,
  };
}

export function getBindings(): BindingsFile {
  if (current) return current;
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    current = sanitize(raw ? JSON.parse(raw) : null);
  } catch {
    current = defaultBindings();
  }
  return current;
}

export function saveBindings(next: BindingsFile): void {
  current = sanitize(next);
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    /* private mode: keep the in-memory copy */
  }
}

export function resetBindings(): BindingsFile {
  current = defaultBindings();
  try {
    globalThis.localStorage?.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  return current;
}

/** Which seats this machine drives in the current context. */
export function localSeats(context: BindingContext, lanRole: 'host' | 'guest' = 'host'): { seat: 1 | 2; keys: SeatBindings; label: string }[] {
  const b = getBindings();
  if (context === 'solo') return [{ seat: 1, keys: b.solo, label: '玩家' }];
  if (context === 'versus') {
    return [
      { seat: 1, keys: b.versus.p1, label: 'P1' },
      { seat: 2, keys: b.versus.p2, label: 'P2' },
    ];
  }
  return lanRole === 'host'
    ? [{ seat: 1, keys: b.lan.host, label: '房主' }]
    : [{ seat: 2, keys: b.lan.guest, label: '访客' }];
}

export function seatBindingsFor(context: BindingContext, seat: 1 | 2): SeatBindings {
  const b = getBindings();
  if (context === 'solo') return b.solo;
  if (context === 'versus') return seat === 1 ? b.versus.p1 : b.versus.p2;
  return seat === 1 ? b.lan.host : b.lan.guest;
}

/** Human-readable key name for the bind editor. */
export function keyLabel(code: number): string {
  if (!code) return '未设置';
  const special: Record<number, string> = {
    8: '⌫',
    9: 'Tab',
    13: 'Enter',
    16: 'Shift',
    17: 'Ctrl',
    18: 'Alt',
    20: 'Caps',
    27: 'Esc',
    32: '空格',
    33: 'PgUp',
    34: 'PgDn',
    37: '←',
    38: '↑',
    39: '→',
    40: '↓',
    45: 'Ins',
    46: 'Del',
    186: ';',
    187: '=',
    188: ',',
    189: '-',
    190: '.',
    191: '/',
    192: '`',
    219: '[',
    220: '\\',
    221: ']',
    222: "'",
  };
  if (special[code]) return special[code];
  if (code >= 65 && code <= 90) return String.fromCharCode(code);
  if (code >= 48 && code <= 57) return String.fromCharCode(code);
  if (code >= 96 && code <= 105) return `小键盘${code - 96}`;
  if (code >= 112 && code <= 123) return `F${code - 111}`;
  return `#${code}`;
}

/** Normalises a KeyboardEvent to the stored keyCode. */
export function eventToKeyCode(event: KeyboardEvent): number {
  return event.keyCode || event.which || 0;
}

/** Scopes a conflict can be reported for (`versus` means "both local seats"). */
export type ConflictScope = BindingContext | 'versus.p1' | 'versus.p2' | 'lan.host' | 'lan.guest' | 'global' | 'versus';

/**
 * Keys that are bound twice in a way that can actually bite.
 *
 * Three things count as a conflict:
 *  - the same key twice inside one seat map (`前进` and `后退` on W);
 *  - a seat key that is also a *system* key (`暂停`/`静音`/`自动躲`), because both
 *    fire off the same keyboard at the same time;
 *  - the two local-versus seats sharing one key for *different* actions
 *    (P1 前进 on the key P2 uses to fire). Both seats using the same key for the
 *    same action — SHIFT slows either tank — is the shipped default, not a bug.
 *
 * Keys from scopes that never run together (solo vs. LAN host) are ignored on
 * purpose: reporting them would train people to ignore the warning.
 */
export function findConflicts(bindings: BindingsFile): { scope: ConflictScope; code: number }[] {
  const out: { scope: ConflictScope; code: number }[] = [];
  const pushed = new Set<string>();
  const report = (scope: ConflictScope, code: number): void => {
    const key = `${scope}:${code}`;
    if (pushed.has(key)) return;
    pushed.add(key);
    out.push({ scope, code });
  };

  const globalCodes = new Set(Object.values(bindings.global).filter((code) => code > 0));

  const scan = (scope: ConflictScope, map: Record<string, number>, shareWith: Set<number> = new Set()): void => {
    const seen = new Set<number>();
    for (const code of Object.values(map)) {
      if (!code) continue;
      if (seen.has(code)) report(scope, code);
      seen.add(code);
      if (shareWith.has(code)) report(scope, code);
    }
  };

  scan('solo', bindings.solo, globalCodes);
  scan('versus.p1', bindings.versus.p1, globalCodes);
  scan('versus.p2', bindings.versus.p2, globalCodes);
  scan('lan.host', bindings.lan.host, globalCodes);
  scan('lan.guest', bindings.lan.guest, globalCodes);
  scan('global', bindings.global);

  // Local versus: one keyboard, two players. Same key for the same job is fine;
  // the same key for two different jobs means one player presses for the other.
  const p1 = bindings.versus.p1 as unknown as Record<string, number>;
  const p2 = bindings.versus.p2 as unknown as Record<string, number>;
  for (const [action, code] of Object.entries(p1)) {
    if (!code) continue;
    const other = Object.entries(p2).find(([, c]) => c === code);
    if (other && other[0] !== action) {
      report('versus.p1', code);
      report('versus.p2', code);
    }
  }

  return out;
}
