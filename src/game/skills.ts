/**
 * "Summoner" skills: picked once, before the match, then used with one key
 * during the fight. Pure data plus small helpers – the scene applies the
 * effects, so everything here stays testable.
 */

export type SkillId = 'blink' | 'invincible' | 'rage' | 'weaken';

export interface SkillDef {
  id: SkillId;
  name: string;
  blurb: string;
  /** Seconds before it can be used again. */
  cooldown: number;
  /** Effect length in seconds (0 = instant). */
  duration: number;
  color: number;
}

export const SKILLS: SkillDef[] = [
  {
    id: 'blink',
    name: '闪现',
    blurb: '瞬间向前闪 170 像素，撞墙会自动缩短距离，用来脱身或换位。',
    cooldown: 8,
    duration: 0,
    color: 0x3f9c8f,
  },
  {
    id: 'invincible',
    name: '无敌',
    blurb: '3.5 秒内免疫一切伤害，可以顶着弹雨往前压。',
    cooldown: 18,
    duration: 3.5,
    color: 0xd4a72e,
  },
  {
    id: 'rage',
    name: '狂暴',
    blurb: '8 秒内移速 +30%，接下来 5 发炮弹伤害翻倍。',
    cooldown: 16,
    duration: 8,
    color: 0xd4552e,
  },
  {
    id: 'weaken',
    name: '弱化',
    blurb: '让对手 6 秒内移速 -40%，追不上也跑不掉。',
    cooldown: 14,
    duration: 6,
    color: 0x6f5aa8,
  },
];

export const DEFAULT_SKILL: SkillId = 'blink';

export function skillById(id: SkillId): SkillDef {
  return SKILLS.find((s) => s.id === id) ?? SKILLS[0];
}

export function isSkillId(value: unknown): value is SkillId {
  return SKILLS.some((s) => s.id === value);
}

/** Rage grants this many double-damage shells. */
export const RAGE_SHOTS = 5;
