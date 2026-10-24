export type GameMode = 'solo' | 'versus' | 'lan';
export type Difficulty = 'easy' | 'normal' | 'hard';

export interface DifficultyPreset {
  key: Difficulty;
  label: string;
  blurb: string;
  /** Lives for the human player in solo. */
  lives: number;
  /** Hits needed to destroy the AI tank. */
  enemyLives: number;
  /** Seconds between AI shots (before per-level scaling). */
  reload: number;
  /** Seconds the AI telegraphs its shot with a dashed line. */
  telegraph: number;
  /** How many bank shots the AI will search for. */
  maxBounces: number;
  /** 0 = never dodges, 1 = dodges everything it can see. */
  dodgeSkill: number;
  /** AI hull speed. */
  enemySpeed: number;
  /** AI shell speed. */
  shellSpeed: number;
  /** Quiet time at the start of a level. */
  grace: number;
  /** Whether the AI leads its shots by predicting your movement. */
  leadTarget: boolean;
}

export const DIFFICULTIES: Record<Difficulty, DifficultyPreset> = {
  easy: {
    key: 'easy',
    label: '轻松',
    blurb: '5 条命 · 敌人慢、少反弹 · 偶尔才躲',
    lives: 5,
    enemyLives: 3,
    reload: 3.6,
    telegraph: 1.0,
    maxBounces: 1,
    dodgeSkill: 0.35,
    enemySpeed: 92,
    shellSpeed: 500,
    grace: 3.5,
    leadTarget: false,
  },
  normal: {
    key: 'normal',
    label: '标准',
    blurb: '4 条命 · 敌人会打反弹 · 会躲',
    lives: 4,
    enemyLives: 3,
    reload: 2.6,
    telegraph: 0.85,
    maxBounces: 2,
    dodgeSkill: 0.7,
    enemySpeed: 118,
    shellSpeed: 600,
    grace: 2.8,
    leadTarget: true,
  },
  hard: {
    key: 'hard',
    label: '困难',
    blurb: '3 条命 · 敌人精准多反弹 · 很会躲',
    lives: 3,
    enemyLives: 3,
    reload: 1.9,
    telegraph: 0.65,
    maxBounces: 3,
    dodgeSkill: 1,
    enemySpeed: 142,
    shellSpeed: 660,
    grace: 2.2,
    leadTarget: true,
  },
};

export interface Settings {
  mode: GameMode;
  difficulty: Difficulty;
  /** Solo only: the hull dodges shells on its own, you keep the trigger. */
  autoDodge: boolean;
  /** LAN: who this machine is in the match. */
  lanRole: 'host' | 'guest';
  /** LAN: host IP / URL. Empty = the page's own server. */
  lanAddress: string;
}

/** Mutated by the DOM overlay, read by the game scene when it boots. */
export const settings: Settings = {
  mode: 'solo',
  // The first version was too punishing, so the game now opens on the gentle preset.
  difficulty: 'easy',
  autoDodge: false,
  lanRole: 'host',
  lanAddress: '',
};

export function preset(): DifficultyPreset {
  return DIFFICULTIES[settings.difficulty];
}

/** Lives each side starts a versus (and LAN) match with. */
export const VERSUS_LIVES = 3;

/** Default port of the bundled LAN server. */
export { DEFAULT_LAN_PORT } from '../net/protocol';
