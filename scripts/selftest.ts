/**
 * Headless checks for the physics + ricochet maths.
 * Run with `npm run selftest`.
 */
import { planRicochetShot, trace, segmentCircleT } from '../src/engine/ai';
import { advanceBullet, type BulletBody, type CrateBox } from '../src/engine/bullet';
import { circleBox, reflect, sweepCircleBox, type Box } from '../src/engine/physics';
import { bulletThreatAt, nearestWallGap, pickHeading, steerTo } from '../src/engine/steer';
import { LEVELS, buildLayout, levelById, randomLevelIndex, validateLevels } from '../src/engine/level';
import { PICKUP_KINDS, rollPickupKind, PICKUP_RADIUS } from '../src/game/pickups';
import { SKILLS, skillById, isSkillId, RAGE_SHOTS } from '../src/game/skills';
import {
  ACTION_LABEL,
  defaultBindings,
  findConflicts,
  getBindings,
  keyLabel,
  resetBindings,
  saveBindings,
  SEAT_ACTIONS,
} from '../src/game/keybinds';

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function near(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) <= eps;
}

console.log('physics');

const wall: Box = { x: 400, y: 0, w: 20, h: 400 };

check('circle/box overlap is detected', circleBox(395, 200, 10, wall) !== null);
check('circle clear of box is ignored', circleBox(380, 200, 10, wall) === null);
check('circle centre inside box is pushed out of the nearest face', (() => {
  const hit = circleBox(412, 200, 10, wall);
  return hit !== null && hit.nx === 1 && near(hit.depth, 18);
})());

const sweep = sweepCircleBox(300, 200, 5, 400, 0, [wall]);
check('swept circle stops at the wall', sweep !== null && near(300 + (400 - (sweep?.remaining ?? 0)), 395, 1e-6), JSON.stringify(sweep));
check('swept circle reports the facing normal', sweep?.nx === -1 && sweep?.ny === 0);

const fast = sweepCircleBox(300, 200, 4, 2000, 0, [wall]);
check('fast bullet cannot tunnel through a thin wall', fast !== null && near(fast.remaining, 2000 - 96, 1e-6), JSON.stringify(fast));

const bounce = reflect(5, 0, -1, 0);
check('reflection flips the normal component', bounce.x === -5 && bounce.y === 0);

const corner = reflect(3, 4, 0, -1);
check('reflection keeps the tangent component', corner.x === 3 && corner.y === -4);

console.log('circle hits');
check(
  'segment/circle finds an early hit',
  near(segmentCircleT(0, 0, 100, 0, 50, 0, 10) ?? -1, 0.4)
);
check('segment/circle misses when offset', segmentCircleT(0, 0, 100, 0, 50, 40, 10) === null);

console.log('shells');

const room: Box[] = [
  { x: 0, y: 0, w: 400, h: 20 },
  { x: 0, y: 380, w: 400, h: 20 },
  { x: 0, y: 0, w: 20, h: 400 },
  { x: 380, y: 0, w: 20, h: 400 },
];

const shell: BulletBody = { x: 100, y: 200, vx: 760, vy: 0, bounces: 0 };

// A shell in the middle of an empty room must not report phantom contacts.
const quiet = advanceBullet({ ...shell }, 1 / 60, { walls: room, radius: 4.5, maxBounces: 4 });
check('no phantom contacts in open space', quiet.length === 0, JSON.stringify(quiet));
const quietTarget = advanceBullet({ ...shell }, 1 / 60, {
  walls: room,
  radius: 4.5,
  maxBounces: 4,
  targets: [{ id: 'enemy', x: 350, y: 350, radius: 19 }],
});
check('no phantom tank hits for a distant target', quietTarget.length === 0, JSON.stringify(quietTarget));

// One second of flight at 760px/s inside a 360px room must bounce and stay in.
let bounced = false;
let reflected = false;
let stayedInside = true;
for (let i = 0; i < 60; i++) {
  const evts = advanceBullet(shell, 1 / 60, { walls: room, radius: 4.5, maxBounces: 99 });
  if (evts.some((e) => e.kind === 'wall')) {
    bounced = true;
    if (shell.vx < 0) reflected = true;
  }
  if (shell.x < 20 || shell.x > 380 || shell.y < 20 || shell.y > 380) stayedInside = false;
}
check('shell bounces off walls while it flies', bounced);
check('bounce reflects the velocity', reflected, `vx=${shell.vx}`);
check('shell stays inside the arena', stayedInside, `x=${shell.x}`);

let escaped = false;
const longShell: BulletBody = { x: 200, y: 200, vx: 900, vy: 330, bounces: 0 };
for (let i = 0; i < 600 && !escaped; i++) {
  const evts = advanceBullet(longShell, 1 / 60, { walls: room, radius: 4.5, maxBounces: 99 });
  if (evts.some((e) => e.kind === 'expired')) break;
  escaped = longShell.x < 20 || longShell.x > 380 || longShell.y < 20 || longShell.y > 380;
}
check('10 seconds of ricochet never tunnels out', !escaped);

const bouncing: BulletBody = { x: 200, y: 200, vx: 700, vy: 0, bounces: 0 };
const limited = advanceBullet(bouncing, 2, { walls: room, radius: 4.5, maxBounces: 1 });
check('shell expires after its bounce budget', limited.some((e) => e.kind === 'expired'));

const crateBox: CrateBox = { box: { x: 250, y: 180, w: 40, h: 40 }, alive: true };
const crateShell: BulletBody = { x: 100, y: 200, vx: 700, vy: 0, bounces: 0 };
const crateEvents = advanceBullet(crateShell, 0.25, { walls: room, crates: [crateBox], radius: 4.5, maxBounces: 4 });
check('shell reports the crate it hits', crateEvents.some((e) => e.kind === 'crate' && e.index === 0));
check('crate absorbs the shell', !crateEvents.some((e) => e.kind === 'wall'));

const tankShell: BulletBody = { x: 100, y: 200, vx: 700, vy: 0, bounces: 0 };
const tankEvents = advanceBullet(tankShell, 0.4, {
  walls: room,
  radius: 4.5,
  maxBounces: 4,
  targets: [{ id: 'enemy', x: 300, y: 200, radius: 19 }],
});
const tankEvent = tankEvents.find((e) => e.kind === 'tank');
check('shell reports the tank it hits', !!tankEvent);
check('tank hit lands on the hull edge', !!tankEvent && near(tankEvent.x, 300 - 19 - 4.5, 0.6), JSON.stringify(tankEvent));

const behind: BulletBody = { x: 100, y: 200, vx: -700, vy: 0, bounces: 0 };
const behindEvents = advanceBullet(behind, 0.1, {
  walls: room,
  radius: 4.5,
  maxBounces: 4,
  targets: [{ id: 'enemy', x: 300, y: 200, radius: 19 }],
});
check('shell flying away never hits the target behind it', !behindEvents.some((e) => e.kind === 'tank'));

console.log('aiming');

const arena: Box[] = [
  { x: 0, y: 0, w: 800, h: 20 },
  { x: 0, y: 580, w: 800, h: 20 },
  { x: 0, y: 0, w: 20, h: 600 },
  { x: 780, y: 0, w: 20, h: 600 },
];

const open = planRicochetShot(200, 300, 600, 300, arena, { targetRadius: 24 });
check('straight shot found in an open arena', open !== null && open.bounces === 0, JSON.stringify(open));

const blocked = [...arena, { x: 360, y: 120, w: 80, h: 360 }];
const bank = planRicochetShot(200, 300, 600, 300, blocked, { targetRadius: 24, maxBounces: 2 });
check('bank shot found around a blocking wall', bank !== null && bank.bounces >= 1, JSON.stringify(bank));
if (bank) {
  const t = trace(200, 300, bank.dir, 600, 300, blocked, { maxBounces: 2, targetRadius: 24 });
  check('bank shot actually passes through the target', t.miss <= 24, `miss=${t.miss.toFixed(2)}`);
  check('bank shot takes at least one bounce', t.bounces >= 1, `bounces=${t.bounces}`);
}

const sealed = [
  ...arena,
  { x: 380, y: 220, w: 40, h: 160 },
  { x: 460, y: 220, w: 40, h: 160 },
  { x: 380, y: 200, w: 120, h: 24 },
  { x: 380, y: 376, w: 120, h: 24 },
];
const impossible = planRicochetShot(200, 300, 440, 300, sealed, { targetRadius: 22, maxBounces: 3 });
check('sealed target has no firing solution', impossible === null, JSON.stringify(impossible));

console.log('dodging');

// A shell flying straight at us from the left.
const incoming = [{ x: 100, y: 200, vx: 600, vy: 0, bounces: 0, maxBounces: 4, radius: 4.5 }];
const openField: Box[] = room;
const inLineOfFire = bulletThreatAt(300, 200, 22, incoming, openField);
check('a shell aimed at us registers as danger', inLineOfFire.danger > 0.3, `danger=${inLineOfFire.danger.toFixed(2)}`);
check('it reports a plausible time of arrival', inLineOfFire.eta > 0 && inLineOfFire.eta < 1.2, `eta=${inLineOfFire.eta.toFixed(2)}`);

const offToTheSide = bulletThreatAt(300, 340, 22, incoming, openField);
check('a shell passing far away is not dangerous', offToTheSide.danger === 0, `danger=${offToTheSide.danger}`);

const nothing = bulletThreatAt(300, 200, 22, [], openField);
check('no shells means no danger', nothing.danger === 0 && nothing.eta === Infinity);

// A shell that will bounce off the right wall and come back towards us.
const bankShell = [{ x: 300, y: 110, vx: 500, vy: 0, bounces: 0, maxBounces: 4, radius: 4.5 }];
const predicted = bulletThreatAt(200, 110, 22, bankShell, [
  { x: 0, y: 0, w: 400, h: 20 },
  { x: 380, y: 0, w: 20, h: 400 },
  { x: 0, y: 380, w: 400, h: 20 },
  { x: 0, y: 0, w: 20, h: 400 },
]);
check('banked shell paths are predicted, not just straight lines', predicted.danger > 0.2, `danger=${predicted.danger.toFixed(2)}`);

const escape = pickHeading({
  x: 300,
  y: 200,
  radius: 22,
  bodyAngle: 0,
  walls: openField,
  bullets: incoming,
  threatWeight: 1.5,
  stepDistance: 70,
  samples: 16,
});
check('the dodge picks a heading away from the shell', !Number.isNaN(escape.angle), JSON.stringify(escape));
check(
  'the chosen spot is safer than standing still',
  escape.threat < inLineOfFire.danger,
  `chosen=${escape.threat.toFixed(2)} still=${inLineOfFire.danger.toFixed(2)}`
);
check('the dodge is inside the arena', escape.x > 20 && escape.x < 380 && escape.y > 20 && escape.y < 380);

const boxedIn = pickHeading({
  x: 40,
  y: 40,
  radius: 22,
  bodyAngle: 0,
  walls: room,
  bullets: [],
  threatWeight: 1,
  stepDistance: 70,
  samples: 16,
});
check('a cornered tank still gets a legal move', Number.isNaN(boxedIn.angle) || (boxedIn.x > 20 && boxedIn.y > 20), JSON.stringify(boxedIn));

const forward = steerTo(0, 0);
check('steering straight ahead drives forward', forward.drive === 1 && forward.turn === 0);
const backwards = steerTo(Math.PI, 0);
check('a target behind us is reached by reversing', backwards.drive === -1, JSON.stringify(backwards));
const right = steerTo(Math.PI / 2, 0);
check('a target to the right turns right', right.turn > 0, JSON.stringify(right));

check('wall gap is measured from the surface', Math.abs(nearestWallGap(100, 100, room) - 80) < 1, `${nearestWallGap(100, 100, room)}`);
check('wall gap is capped so it stays a local heuristic', nearestWallGap(200, 200, room) === 140, `${nearestWallGap(200, 200, room)}`);

console.log('levels');
for (const [i, level] of LEVELS.entries()) {
  const layout = buildLayout(level, { x: 0, y: 0, w: 1200, h: 600 });
  const spawnsInsideWall = (x: number, y: number): boolean =>
    layout.walls.some((w) => circleBox(x, y, 24, w) !== null);
  check(`level ${i + 1} player spawn is clear`, !spawnsInsideWall(layout.player.x, layout.player.y));
  check(`level ${i + 1} enemy spawn is clear`, !spawnsInsideWall(layout.enemy.x, layout.enemy.y));
  check(`level ${i + 1} spawns are far apart`, Math.hypot(
    layout.player.x - layout.enemy.x,
    layout.player.y - layout.enemy.y
  ) > 200);
  const inside = (w: Box): boolean =>
    w.x >= 0 && w.y >= 0 && w.x + w.w <= 1200 && w.y + w.h <= 600;
  check(`level ${i + 1} walls stay inside the arena`, layout.walls.every(inside));

  // Informational: the enemy roams, so not every spawn has a bank shot.
  const plan = planRicochetShot(layout.enemy.x, layout.enemy.y, layout.player.x, layout.player.y, layout.walls, {
    targetRadius: 26,
    maxBounces: 3,
    maxLength: 2400,
    samples: 64,
  });
  console.log(
    `  ..   level ${i + 1} opening bank shot: ` +
      (plan ? `${plan.bounces} bounce(s), ${Math.round(plan.length)}px` : 'none — falls back to a direct shot')
  );
}


// ---------------------------------------------------------------- map roster

const issues = validateLevels();
check('every authored map passes validation', issues.length === 0, JSON.stringify(issues.slice(0, 3)));
check('the roster has a decent spread of maps', LEVELS.length >= 8, `${LEVELS.length} maps`);
check('map ids are unique', new Set(LEVELS.map((l) => l.id)).size === LEVELS.length);
check('every map offers pickups', LEVELS.every((l) => l.pickups.length >= 3));
check('every map names itself and describes the layout', LEVELS.every((l) => !!l.name && !!l.blurb));
check(
  '1v1 maps are 180° rotationally fair',
  LEVELS.every((l) =>
    l.walls.every((w) => {
      const mx = 1 - w.x - w.w;
      const my = 1 - w.y - w.h;
      return l.walls.some((o) => Math.abs(o.x - mx) < 1e-6 && Math.abs(o.y - my) < 1e-6);
    })
  )
);
check('levelById falls back instead of throwing', levelById('nope').id === LEVELS[0].id);
check('random map avoids repeating the current one', randomLevelIndex(2, () => 0.26) !== 2, `${randomLevelIndex(2, () => 0.26)}`);
check(
  'random map stays in range for many draws',
  Array.from({ length: 200 }, () => randomLevelIndex(-1)).every((i) => i >= 0 && i < LEVELS.length)
);

// ---------------------------------------------------------------- pickups

check('there are three pickup kinds', PICKUP_KINDS.length === 3);
check(
  'pickup rolls only ever return real kinds',
  Array.from({ length: 400 }, (_, i) => rollPickupKind(() => (i % 100) / 100)).every((k) => PICKUP_KINDS.includes(k))
);
check('health is the most common drop', rollPickupKind(() => 0.1) === 'health');
check('shield is the rarest drop', rollPickupKind(() => 0.95) === 'shield');
check('pickups are big enough to touch', PICKUP_RADIUS >= 14);

// ---------------------------------------------------------------- skills

check('four summoner skills are offered', SKILLS.length === 4, `${SKILLS.length}`);
check('skill ids survive a round trip', SKILLS.every((s) => skillById(s.id).id === s.id));
check('unknown skills fall back safely', skillById('nope' as never).id === SKILLS[0].id);
check('isSkillId rejects junk', !isSkillId('nope') && isSkillId('blink'));
check('every skill has a positive cooldown', SKILLS.every((s) => s.cooldown > 0));
check('rage grants a stack of empowered shells', RAGE_SHOTS >= 3);
check(
  'rage is the only damage skill and it is time-limited',
  SKILLS.filter((s) => s.id === 'rage').every((s) => s.duration > 0)
);

// ---------------------------------------------------------------- keybinds

resetBindings();
const defaults = defaultBindings();
check('default keys cover every seat action', SEAT_ACTIONS.every((a) => defaults.solo[a] > 0));
check('every action has a label', SEAT_ACTIONS.every((a) => !!ACTION_LABEL[a]));
check('the two local seats do not share fire keys', defaults.versus.p1.fire !== defaults.versus.p2.fire);
check('default bindings have no conflicts', findConflicts(defaults).length === 0, JSON.stringify(findConflicts(defaults)));
check('key labels are readable', keyLabel(87) === 'W' && keyLabel(32) === '空格' && keyLabel(38) === '↑');

saveBindings({ ...defaults, solo: { ...defaults.solo, fire: 74 } });
check('a rebind survives a save/load round trip', getBindings().solo.fire === 74);
check('rebinding did not disturb other actions', getBindings().solo.up === defaults.solo.up);
saveBindings({ ...defaults, solo: { ...defaults.solo, up: 999 } } as never);
check('out-of-range key codes are rejected', getBindings().solo.up === defaults.solo.up);
resetBindings();
check('reset restores the defaults', getBindings().solo.fire === defaults.solo.fire);

// ---------------------------------------------------------------- v1.3 rules
{
  const R = await import('../src/game/rules');
  // Damage by body part: front 7, side 9, back 12.
  check('front hit does 7', R.ZONE_DAMAGE.front === 7);
  check('side hit does 9', R.ZONE_DAMAGE.side === 9);
  check('rear hit does 12', R.ZONE_DAMAGE.back === 12);
  // Hull facing right (0). A shell travelling right hits the nose from the
  // front; one travelling left hits the tail.
  check('a shell coming at the nose is a front hit', R.hitZone(0, Math.PI) === 'front', R.hitZone(0, Math.PI));
  check('a shell coming at the tail is a back hit', R.hitZone(0, 0) === 'back', R.hitZone(0, 0));
  check('a shell from the side is a side hit', R.hitZone(0, Math.PI / 2) === 'side', R.hitZone(0, Math.PI / 2));
  check('the zone follows the hull as it turns', R.hitZone(Math.PI, Math.PI) === 'back', R.hitZone(Math.PI, Math.PI));
  // 9 damage a hit: 12 flank hits kill, 11 nearly do – a duel is a real fight
  // rather than the old three-tap.
  check('a flank kill takes a dozen hits', Math.ceil(R.MAX_HP / R.zoneDamage('side')) === 12);
  check('a rear kill is quicker', Math.ceil(R.MAX_HP / R.zoneDamage('back')) === 9);
  check('a frontal kill is the slowest', Math.ceil(R.MAX_HP / R.zoneDamage('front')) === 15);
  check('rear shots kill faster than frontal ones', R.zoneDamage('back') > R.zoneDamage('side') && R.zoneDamage('side') > R.zoneDamage('front'));

  // Damage switches are independent.
  const me = { id: 'p1', team: 0, alive: true };
  const mate = { id: 'p2', team: 0, alive: true };
  const foe = { id: 'p3', team: 1, alive: true };
  check('self damage on when enabled', R.canDamage(me, me, { friendlyFire: false, selfDamage: true }));
  check('self damage off when disabled', !R.canDamage(me, me, { friendlyFire: true, selfDamage: false }));
  check('friendly fire off by default', !R.canDamage(me, mate, { friendlyFire: false, selfDamage: true }));
  check('friendly fire on when enabled', R.canDamage(me, mate, { friendlyFire: true, selfDamage: false }));
  check('enemies always take damage', R.canDamage(me, foe, { friendlyFire: false, selfDamage: false }));
  check('the dead do not take damage', !R.canDamage(me, { ...mate, alive: false }, { friendlyFire: true, selfDamage: true }));

  // Match outcomes.
  const cfg = { mode: 'ffa' as const, capacity: 6, killTarget: 10, timeLimit: 300, friendlyFire: false, selfDamage: true };
  const line = (id: string, kills: number, team = 0) => ({ id, team, kills, deaths: 0, hp: 100, connected: true });
  check('no winner below the kill target', R.evaluateMatch([line('p1', 3), line('p2', 4)], cfg, 10).kind === 'running');
  const killWin = R.evaluateMatch([line('p1', 10), line('p2', 4)], cfg, 10);
  check('reaching the kill target wins', killWin.kind === 'win' && killWin.winners[0] === 'p1');
  const timeWin = R.evaluateMatch([line('p1', 4), line('p2', 3)], cfg, 300);
  check('time up with a leader is a win', timeWin.kind === 'win' && timeWin.reason === 'time');
  const tie = R.evaluateMatch([line('p1', 4), line('p2', 4)], cfg, 300);
  check('time up on equal kills is a draw', tie.kind === 'draw');
  const teamCfg = { ...cfg, mode: 'team' as const, killTarget: 10 };
  const teamWin = R.evaluateMatch([line('p1', 6, 0), line('p2', 4, 0), line('p3', 3, 1), line('p4', 3, 1)], teamCfg, 30);
  check('team kills are summed', teamWin.kind === 'win' && teamWin.winners.includes('p1') && teamWin.winners.includes('p2'));
  const teamTie = R.evaluateMatch([line('p1', 5, 0), line('p3', 5, 1)], teamCfg, 300);
  check('equal team scores draw on time', teamTie.kind === 'draw');

  // Teams alternate.
  const teams = R.assignTeams(['a', 'b', 'c', 'd']);
  check('teams alternate', teams.a === 0 && teams.b === 1 && teams.c === 0 && teams.d === 1);

  // Respawns: FFA keeps you away from the living, teams put you by a mate.
  const spawns = [
    { x: 0, y: 0, angle: 0, id: 0 },
    { x: 100, y: 0, angle: 0, id: 1 },
    { x: 500, y: 500, angle: 0, id: 2 },
  ];
  const ffa = R.chooseRespawn({
    spawns,
    players: [{ x: 0, y: 0, team: 0, alive: true }],
    mode: 'ffa',
    random: () => 0,
  });
  check('FFA respawns far from the only living player', ffa?.id !== 0, JSON.stringify(ffa));
  const team = R.chooseRespawn({
    spawns,
    players: [{ x: 90, y: 0, team: 0, alive: true }],
    team: 0,
    mode: 'team',
    random: () => 0,
  });
  check('team respawn picks the point next to a living mate', team?.id === 1, JSON.stringify(team));
  const aloneTeam = R.chooseRespawn({
    spawns,
    players: [{ x: 0, y: 0, team: 1, alive: true }],
    team: 0,
    mode: 'team',
    random: () => 0,
  });
  check('a wiped team falls back to the far-away rule', aloneTeam?.id !== 0, JSON.stringify(aloneTeam));
  check('no spawns means no respawn point', R.chooseRespawn({ spawns: [], players: [], mode: 'ffa' }) === null);

  // Caps and defaults the menu offers.
  check('capacity goes up to 10', R.CAPACITY_CHOICES.includes(2) && R.CAPACITY_CHOICES.includes(10));
  check('friendly fire and self damage default separately', R.DEFAULT_MATCH.friendlyFire === false && R.DEFAULT_MATCH.selfDamage === true);
}

console.log(`\n${passed} checks passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(` - ${f}`);
  throw new Error('selftest failed');
}
