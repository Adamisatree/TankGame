/**
 * v1.3 combat rules – pure data and maths, no Phaser.
 *
 * Everything that decides "how much damage does this shot do", "who won" and
 * "where does a dead player come back" lives here so the Node test suite can
 * check it without booting a renderer.
 */

/** Every tank has the same pool; damage is per hit, by body part. */
export const MAX_HP = 100;

/**
 * Where the shell hit, from the shooter's point of view.
 * `front` = the nose, `back` = the engine deck, `side` = either flank.
 */
export type HitZone = 'front' | 'side' | 'back';

/** Damage per zone. Rear shots hurt most – that is the whole point of flanking. */
export const ZONE_DAMAGE: Record<HitZone, number> = {
  front: 7,
  side: 9,
  back: 12,
};

/** ±60° around the nose counts as the front; ±60° around the tail as the back. */
export const ZONE_ARC = Math.PI / 3;

/**
 * Classifies a hit.
 * @param hullAngle the victim's facing, radians
 * @param incomingAngle direction the shell was travelling, radians
 */
export function hitZone(hullAngle: number, incomingAngle: number): HitZone {
  // A shell flying "right" hits the left flank; the impact point sits opposite
  // its travel direction, so compare the nose against the *reverse* heading.
  const rel = wrapAngle(incomingAngle + Math.PI - hullAngle);
  const abs = Math.abs(rel);
  if (abs <= ZONE_ARC) return 'front';
  if (abs >= Math.PI - ZONE_ARC) return 'back';
  return 'side';
}

export function zoneDamage(zone: HitZone, multiplier = 1): number {
  return Math.round(ZONE_DAMAGE[zone] * multiplier);
}

export function wrapAngle(angle: number): number {
  let a = angle;
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

// ------------------------------------------------------------------ match rules

export type MatchMode = 'ffa' | 'team';

export type WinCondition = 'kills' | 'time' | 'both';

export interface MatchConfig {
  mode: MatchMode;
  /** Player cap; 2..10 across the board. */
  capacity: number;
  /** What ends the match: kill target, clock, or whichever comes first. */
  winCondition: WinCondition;
  /** Kills needed to win. 0 = unlimited (the clock decides). */
  killTarget: number;
  /** Seconds before the match ends. 0 = untimed. */
  timeLimit: number;
  /** Teammates take damage from each other. */
  friendlyFire: boolean;
  /** Your own ricochets can hurt you. */
  selfDamage: boolean;
}

export const DEFAULT_MATCH: MatchConfig = {
  mode: 'ffa',
  winCondition: 'both',
  capacity: 6,
  killTarget: 15,
  timeLimit: 480,
  friendlyFire: false,
  selfDamage: true,
};

export const CAPACITY_CHOICES = [2, 3, 4, 5, 6, 8, 10];
/** 0 = 不限：the match simply never ends on kills. */
export const KILL_TARGET_CHOICES = [0, 5, 10, 15, 20, 30];
export const TIME_LIMIT_CHOICES = [0, 180, 300, 480, 600];

export interface ScoreLine {
  id: string;
  team: number;
  kills: number;
  deaths: number;
  hp: number;
  connected: boolean;
}

export type MatchResult =
  | { kind: 'running' }
  | { kind: 'win'; winners: string[]; reason: 'kills' }
  | { kind: 'win'; winners: string[]; reason: 'time' }
  | { kind: 'draw'; reason: 'time' | 'all-out' };

/**
 * Decides the match. Team mode compares summed team kills, FFA compares the
 * single best score. A time limit that expires with equal scores is a draw.
 */
export function evaluateMatch(lines: ScoreLine[], config: MatchConfig, elapsed: number): MatchResult {
  if (!lines.length) return { kind: 'running' };

  // Which enders are armed. 'kills' ignores the clock, 'time' ignores kills.
  const useKills = config.winCondition !== 'time';
  const useTime = config.winCondition !== 'kills';
  const killTarget = useKills ? config.killTarget : 0;
  const timeLimit = useTime ? config.timeLimit : 0;

  if (config.mode === 'team') {
    const byTeam = new Map<number, number>();
    for (const line of lines) byTeam.set(line.team, (byTeam.get(line.team) ?? 0) + line.kills);
    const teams = [...byTeam.entries()].sort((a, b) => b[1] - a[1]);
    if (killTarget > 0 && teams[0] && teams[0][1] >= killTarget) {
      const winners = lines.filter((l) => l.team === teams[0][0]).map((l) => l.id);
      return { kind: 'win', winners, reason: 'kills' };
    }
    if (timeLimit > 0 && elapsed >= timeLimit) {
      if (teams.length >= 2 && teams[0][1] === teams[1][1]) return { kind: 'draw', reason: 'time' };
      return { kind: 'win', winners: lines.filter((l) => l.team === teams[0][0]).map((l) => l.id), reason: 'time' };
    }
    return { kind: 'running' };
  }

  const best = Math.max(...lines.map((l) => l.kills));
  if (killTarget > 0 && best >= killTarget) {
    return { kind: 'win', winners: lines.filter((l) => l.kills === best).map((l) => l.id), reason: 'kills' };
  }
  if (timeLimit > 0 && elapsed >= timeLimit) {
    const leaders = lines.filter((l) => l.kills === best);
    if (leaders.length > 1) return { kind: 'draw', reason: 'time' };
    return { kind: 'win', winners: leaders.map((l) => l.id), reason: 'time' };
  }
  return { kind: 'running' };
}

// ------------------------------------------------------------------ teams

/** Alternates players across `teamCount` teams so sides stay even. */
export function assignTeams(ids: string[], teamCount = 2): Record<string, number> {
  const out: Record<string, number> = {};
  ids.forEach((id, index) => {
    out[id] = index % teamCount;
  });
  return out;
}

export function teamCounts(teams: Record<string, number>): number[] {
  const counts: number[] = [];
  for (const team of Object.values(teams)) counts[team] = (counts[team] ?? 0) + 1;
  return counts;
}

// ------------------------------------------------------------------ damage gate

export interface DamageTarget {
  id: string;
  team: number;
  alive: boolean;
}

/**
 * Whether a shot is allowed to hurt someone. Two independent toggles, because
 * "can I hurt my team-mate" and "can my own ricochet hurt me" are different
 * questions and people want them separately.
 */
export function canDamage(
  attacker: DamageTarget | null,
  victim: DamageTarget,
  config: Pick<MatchConfig, 'friendlyFire' | 'selfDamage'>
): boolean {
  if (!victim.alive) return false;
  if (!attacker) return true;
  if (attacker.id === victim.id) return config.selfDamage;
  if (attacker.team === victim.team) return config.friendlyFire;
  return true;
}

// ------------------------------------------------------------------ respawn

export interface SpawnPoint {
  x: number;
  y: number;
  angle: number;
}
export interface RespawnCandidate extends SpawnPoint {
  id: number;
}

const dist2 = (ax: number, ay: number, bx: number, by: number): number => (ax - bx) ** 2 + (ay - by) ** 2;

/**
 * Picks where a dead player comes back.
 *
 * - team mode: right next to a living team-mate (they asked for this), unless
 *   nobody on the team is alive – then fall back to the open-map rule;
 * - ffa: the points farthest from every living player, so respawning never
 *   drops you in somebody's gunsights.
 */
export function chooseRespawn(options: {
  spawns: RespawnCandidate[];
  players: { x: number; y: number; team: number; alive: boolean }[];
  team?: number;
  mode: MatchMode;
  random?: () => number;
}): RespawnCandidate | null {
  const { spawns, players, team, mode } = options;
  if (!spawns.length) return null;
  const random = options.random ?? Math.random;
  const living = players.filter((p) => p.alive);

  if (mode === 'team' && team !== undefined) {
    const mates = living.filter((p) => p.team === team);
    if (mates.length) {
      // A ring of points around the mate, as close as the map allows.
      const mate = mates[Math.floor(random() * mates.length)];
      let best: { spawn: RespawnCandidate; d: number } | null = null;
      for (const spawn of spawns) {
        const d = dist2(spawn.x, spawn.y, mate.x, mate.y);
        if (!best || d < best.d) best = { spawn, d };
      }
      if (best) return best.spawn;
    }
    // Whole team is dead – same rule as FFA.
  }

  const scored = spawns.map((spawn) => {
    let nearest = Infinity;
    for (const p of living) nearest = Math.min(nearest, dist2(spawn.x, spawn.y, p.x, p.y));
    return { spawn, nearest };
  });
  const sorted = scored.sort((a, b) => b.nearest - a.nearest);
  // Best few, so repeated deaths don't all land on the same corner.
  const pool = sorted.slice(0, Math.max(1, Math.min(3, sorted.length)));
  return pool[Math.floor(random() * pool.length)].spawn;
}
