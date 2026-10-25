/**
 * Rebinding support.
 *
 * Keys are stored as numeric `keyCode` values because that is exactly what
 * Phaser's `addKey` accepts, and it lets the menu "press the key you want"
 * flow work without any name parsing. Everything is kept per context so solo,
 * local versus and LAN can each have their own layout.
 */

export type SeatAction = 'up' | 'down' | 'left' | 'right' | 'fire' | 'aimLeft' | 'aimRight' | 'slow' | 'skill';
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

export const SEAT_ACTIONS: SeatAction[] = ['up', 'down', 'left', 'right', 'fire', 'aimLeft', 'aimRight', 'slow', 'skill'];

export const ACTION_LABEL: Record<SeatAction, string> = {
  up: '前进 / 加速',
  down: '后退',
  left: '左转',
  right: '右转',
  fire: '开火',
  aimLeft: '炮口左调',
  aimRight: '炮口右调',
  slow: '慢速微调',
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
    solo: { ...WASD_DRIVE, fire: K.SPACE, aimLeft: K.Q, aimRight: K.E, slow: K.SHIFT, skill: K.F },
    versus: {
      p1: { ...WASD_DRIVE, fire: K.SPACE, aimLeft: K.Q, aimRight: K.E, slow: K.SHIFT, skill: K.R },
      p2: { ...ARROW_DRIVE, fire: K.ENTER, aimLeft: K.COMMA, aimRight: K.PERIOD, slow: K.SHIFT, skill: K.SLASH },
    },
    lan: {
      host: { ...WASD_DRIVE, fire: K.SPACE, aimLeft: K.Q, aimRight: K.E, slow: K.SHIFT, skill: K.F },
      guest: { ...WASD_DRIVE, fire: K.SPACE, aimLeft: K.Q, aimRight: K.E, slow: K.SHIFT, skill: K.F },
    },
    global: { pause: K.P, mute: K.M, autoDodge: K.G },
  };
}

const STORAGE_KEY = 'tankgame.bindings.v1';
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

/** Actions whose key collides with another action in the same group. */
export function findConflicts(bindings: BindingsFile): { scope: string; code: number }[] {
  const out: { scope: string; code: number }[] = [];
  const scan = (scope: string, map: Record<string, number>, shared: number[] = []) => {
    const seen = new Map<number, string>();
    for (const [action, code] of Object.entries(map)) {
      if (!code || shared.includes(code)) continue;
      if (seen.has(code)) out.push({ scope, code });
      else seen.set(code, action);
    }
  };
  scan('单人', bindings.solo);
  scan('双人 P1', bindings.versus.p1);
  scan('双人 P2', bindings.versus.p2);
  scan('联机房主', bindings.lan.host);
  scan('联机访客', bindings.lan.guest);
  scan('系统', bindings.global);
  return out;
}
