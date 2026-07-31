import { hashString, rollAt } from '../sim/rng.ts';
import { Arena, ARENA_HEIGHT_DEFAULT, heightForForce } from './arena.ts';
import {
  AbilityKind,
  type Ability,
  type BattleEvent,
  type BattleFrame,
  type BattleOutcome,
  type BattleResult,
  type Fighter,
  type FighterStats,
  Side,
  snapshotFighter,
  TURNS_PER_COMBAT,
} from './types.ts';

const PURPOSE_HIT = hashString('combat:hit');
const PURPOSE_DODGE = hashString('combat:dodge');

const neighbourBuf = new Int32Array(6);
const kiteLookBuf = new Int32Array(6);

/** Active arena for the in-flight resolve — set by runBattle. */
let arena = new Arena(ARENA_HEIGHT_DEFAULT);

function cloneFighter(f: Fighter): Fighter {
  return {
    ...f,
    abilities: f.abilities.map((a) => ({ ...a })),
    abilityReadyIn: f.abilityReadyIn.slice(),
  };
}

function living(fighters: readonly Fighter[]): Fighter[] {
  return fighters.filter((f) => f.health > 0);
}

function livingOn(fighters: readonly Fighter[], side: Side): Fighter[] {
  return fighters.filter((f) => f.health > 0 && f.side === side);
}

function occupiedCells(fighters: readonly Fighter[]): Set<number> {
  const set = new Set<number>();
  for (const f of fighters) {
    if (f.health > 0) set.add(f.cell);
  }
  return set;
}

function enemySide(side: Side): Side {
  return side === Side.A ? Side.B : Side.A;
}

/** Nearest living enemy; ties → lowest HP → lowest id. */
export function pickEnemy(self: Fighter, fighters: readonly Fighter[]): Fighter | null {
  const enemies = livingOn(fighters, enemySide(self.side));
  if (enemies.length === 0) return null;
  let best: Fighter | null = null;
  let bestDist = Infinity;
  for (const e of enemies) {
    const d = arena.distance(self.cell, e.cell);
    if (
      best === null ||
      d < bestDist ||
      (d === bestDist && e.health < best.health) ||
      (d === bestDist && e.health === best.health && e.id < best.id)
    ) {
      best = e;
      bestDist = d;
    }
  }
  return best;
}

/** Ally with lowest armor (prefer someone who can use a ward); ties → lowest id. */
function pickWardAlly(self: Fighter, fighters: readonly Fighter[]): Fighter | null {
  const allies = livingOn(fighters, self.side);
  if (allies.length === 0) return null;
  let best: Fighter | null = null;
  for (const a of allies) {
    if (
      best === null ||
      a.armor < best.armor ||
      (a.armor === best.armor && a.id < best.id)
    ) {
      best = a;
    }
  }
  return best;
}

/**
 * Preferred stand-off distance: longest enemy-targeting ability range.
 * Melee stays at 1; archers hold the line at their max shot range.
 */
export function preferredEngageRange(self: Fighter): number {
  let best = 0;
  for (const a of self.abilities) {
    if (a.kind === AbilityKind.ward) continue;
    if (a.range > best) best = a.range;
  }
  return best > 0 ? best : 1;
}

/** Shortest ready enemy-targeting ability range, or null if none are ready. */
function readyEnemyMinRange(self: Fighter): number | null {
  let min: number | null = null;
  for (let i = 0; i < self.abilities.length; i++) {
    if (self.abilityReadyIn[i]! > 0) continue;
    const a = self.abilities[i]!;
    if (a.kind === AbilityKind.ward) continue;
    if (min === null || a.range < min) min = a.range;
  }
  return min;
}

/**
 * One hex toward preferred range. Closes when too far; kites when too close
 * (never steps closer). Equal-distance kite steps are allowed when they open a
 * farther hex next turn — needed at the back wall where no single step gains range.
 */
function stepForRange(
  self: Fighter,
  target: Fighter,
  occupied: Set<number>,
  ideal: number,
): number | null {
  const here = arena.distance(self.cell, target.cell);
  if (here === ideal) return null;

  arena.neighboursOf(self.cell, neighbourBuf);

  if (here > ideal) {
    let bestCell: number | null = null;
    let bestErr = here - ideal;
    for (let i = 0; i < 6; i++) {
      const n = neighbourBuf[i]!;
      if (n < 0 || occupied.has(n)) continue;
      const d = arena.distance(n, target.cell);
      if (d >= here) continue;
      const err = Math.abs(d - ideal);
      if (err < bestErr || (err === bestErr && (bestCell === null || n < bestCell))) {
        bestErr = err;
        bestCell = n;
      }
    }
    return bestCell;
  }

  // Kite: never closer. Prefer real distance gains; else equal-dist steps that
  // unlock a strictly farther hex next turn (back-wall corridors).
  let bestCell: number | null = null;
  let bestDist = here;
  let bestUnlock = false;
  let bestBack = backLineScore(self.side, self.cell);
  for (let i = 0; i < 6; i++) {
    const n = neighbourBuf[i]!;
    if (n < 0 || occupied.has(n)) continue;
    const d = arena.distance(n, target.cell);
    if (d < here) continue;
    const capped = Math.min(d, ideal);
    const unlocksFarther = d > here || opensFarther(n, target.cell, here, occupied, self.cell);
    if (d === here && !unlocksFarther) continue;
    const back = backLineScore(self.side, n);
    const better =
      bestCell === null ||
      capped > bestDist ||
      (capped === bestDist && unlocksFarther && !bestUnlock) ||
      (capped === bestDist && unlocksFarther === bestUnlock && back > bestBack) ||
      (capped === bestDist && unlocksFarther === bestUnlock && back === bestBack && n < bestCell!);
    if (better) {
      bestCell = n;
      bestDist = capped;
      bestUnlock = unlocksFarther;
      bestBack = back;
    }
  }
  return bestCell;
}

/** How deep into the fighter's own deploy back-line this cell sits. */
function backLineScore(side: Side, cell: number): number {
  const col = arena.col(cell);
  return side === Side.A ? -col : col;
}

/** True if `cell` has a free neighbour farther from the target than `here`. */
function opensFarther(
  cell: number,
  targetCell: number,
  here: number,
  occupied: Set<number>,
  from: number,
): boolean {
  arena.neighboursOf(cell, kiteLookBuf);
  for (let i = 0; i < 6; i++) {
    const n = kiteLookBuf[i]!;
    if (n < 0) continue;
    if (occupied.has(n) && n !== from) continue;
    if (arena.distance(n, targetCell) > here) return true;
  }
  return false;
}

function pushMove(
  turn: number,
  actor: Fighter,
  from: number,
  to: number,
  events: BattleEvent[],
): void {
  actor.cell = to;
  actor.moveReadyIn = actor.moveCooldown;
  events.push({
    turn,
    kind: 'move',
    actorId: actor.id,
    actorName: actor.name,
    fromCell: from,
    toCell: to,
    text:
      `${actor.name} moves ${arena.col(from)},${arena.row(from)}` +
      ` → ${arena.col(to)},${arena.row(to)}`,
  });
}

function tryEngageMove(
  turn: number,
  actor: Fighter,
  fighters: readonly Fighter[],
  events: BattleEvent[],
): boolean {
  if (actor.moveReadyIn > 0 || actor.rootedIn > 0) return false;
  const chase = pickEnemy(actor, fighters);
  if (chase === null) return false;
  const occupied = occupiedCells(fighters);
  occupied.delete(actor.cell);
  const ideal = preferredEngageRange(actor);
  const next = stepForRange(actor, chase, occupied, ideal);
  if (next === null) return false;
  pushMove(turn, actor, actor.cell, next, events);
  return true;
}

function outgoingDamage(attacker: Fighter, base: number): number {
  // Signed net: buff polarity unused today; weaken is the damage debuff slot.
  const delta = netPolarMods(0, 0, attacker.weakenBy, attacker.weakenTurns);
  return Math.max(0, base + delta);
}

/**
 * Within one polarity (buff-only or debuff-only), keep the most impactful
 * timed magnitude (decision 0038). Higher magnitude wins; equal magnitude
 * keeps the longer (or equal) duration so a refresh can stick.
 *
 * Buff and debuff polarities are separate channels — see `netPolarMods`.
 */
export function applyTimedMagnitude(
  currentMag: number,
  currentTurns: number,
  nextMag: number,
  nextTurns: number,
): { mag: number; turns: number; applied: boolean } {
  if (currentTurns <= 0) {
    return { mag: nextMag, turns: nextTurns, applied: true };
  }
  if (nextMag > currentMag || (nextMag === currentMag && nextTurns >= currentTurns)) {
    return { mag: nextMag, turns: nextTurns, applied: true };
  }
  return { mag: currentMag, turns: currentTurns, applied: false };
}

/**
 * Net the strongest live buff with the strongest live debuff on one stat.
 * Magnitudes are unsigned; debuff subtracts. Example: buff 0.10 / debuff 0.20 ⇒ -0.10.
 */
export function netPolarMods(
  buffMag: number,
  buffTurns: number,
  debuffMag: number,
  debuffTurns: number,
): number {
  const buff = buffTurns > 0 ? buffMag : 0;
  const debuff = debuffTurns > 0 ? debuffMag : 0;
  return buff - debuff;
}

function applyDamage(target: Fighter, amount: number): void {
  let left = amount;
  if (target.armor > 0) {
    const absorbed = Math.min(target.armor, left);
    target.armor -= absorbed;
    left -= absorbed;
  }
  if (left > 0) {
    target.health -= left;
    if (target.health < 0) target.health = 0;
  }
}

function tickStatuses(f: Fighter): void {
  if (f.moveReadyIn > 0) f.moveReadyIn--;
  for (let i = 0; i < f.abilityReadyIn.length; i++) {
    const v = f.abilityReadyIn[i]!;
    if (v > 0) f.abilityReadyIn[i] = v - 1;
  }
  if (f.rootedIn > 0) f.rootedIn--;
  if (f.weakenTurns > 0) {
    f.weakenTurns--;
    if (f.weakenTurns === 0) f.weakenBy = 0;
  }
}

function outcomeOf(fighters: readonly Fighter[]): BattleOutcome | null {
  const aAlive = livingOn(fighters, Side.A).length > 0;
  const bAlive = livingOn(fighters, Side.B).length > 0;
  if (!aAlive && !bAlive) return 'draw';
  if (!aAlive) return 'B';
  if (!bAlive) return 'A';
  return null;
}

function abilityAccuracy(actor: Fighter, ability: Ability): number {
  return ability.accuracy ?? actor.accuracy;
}

function tryHit(
  battleKey: number,
  turn: number,
  actor: Fighter,
  target: Fighter,
  ability: Ability,
  events: BattleEvent[],
  stats: Map<number, FighterStats>,
): boolean {
  const acc = abilityAccuracy(actor, ability);
  const hitRoll = rollAt(battleKey, turn, actor.id, PURPOSE_HIT, target.id, hashString(ability.id));
  if (hitRoll >= acc) {
    events.push({
      turn,
      kind: 'miss',
      actorId: actor.id,
      actorName: actor.name,
      targetId: target.id,
      targetName: target.name,
      abilityId: ability.id,
      abilityName: ability.name,
      text: `${actor.name}'s ${ability.name} misses ${target.name}`,
    });
    stats.get(actor.id)!.misses++;
    return false;
  }
  const dodgeRoll = rollAt(battleKey, turn, actor.id, PURPOSE_DODGE, target.id, hashString(ability.id));
  if (dodgeRoll < target.dodge) {
    events.push({
      turn,
      kind: 'dodge',
      actorId: actor.id,
      actorName: actor.name,
      targetId: target.id,
      targetName: target.name,
      abilityId: ability.id,
      abilityName: ability.name,
      text: `${target.name} dodges ${actor.name}'s ${ability.name}`,
    });
    stats.get(target.id)!.dodges++;
    stats.get(actor.id)!.misses++;
    return false;
  }
  return true;
}

function noteDeath(turn: number, target: Fighter, events: BattleEvent[]): void {
  if (target.health <= 0) {
    events.push({
      turn,
      kind: 'death',
      actorId: target.id,
      actorName: target.name,
      targetId: target.id,
      targetName: target.name,
      text: `${target.name} falls`,
    });
  }
}

function emptyStats(f: Fighter): FighterStats {
  return {
    id: f.id,
    name: f.name,
    side: f.side,
    damageDealt: 0,
    healingDone: 0,
    hitsLanded: 0,
    hitsTaken: 0,
    misses: 0,
    dodges: 0,
    survived: true,
    finalHealth: f.health,
  };
}

function primaryForAbility(
  actor: Fighter,
  ability: Ability,
  fighters: readonly Fighter[],
): Fighter | null {
  switch (ability.kind) {
    case AbilityKind.strike:
    case AbilityKind.volley:
    case AbilityKind.weaken:
    case AbilityKind.root:
      return pickEnemy(actor, fighters);
    case AbilityKind.ward: {
      const ally = pickWardAlly(actor, fighters);
      // Ward when somebody is thin on armor (including freshly stripped tanks).
      if (ally === null) return null;
      if (ally.armor > 4) return null;
      return ally;
    }
    default:
      return null;
  }
}

function dealStrikeDamage(
  turn: number,
  actor: Fighter,
  target: Fighter,
  ability: Ability,
  raw: number,
  events: BattleEvent[],
  stats: Map<number, FighterStats>,
  kind: 'strike' | 'volley',
): void {
  const amount = outgoingDamage(actor, raw);
  const beforeHp = target.health;
  const beforeArmor = target.armor;
  applyDamage(target, amount);
  const dealt = Math.max(0, beforeHp - target.health) + Math.max(0, beforeArmor - target.armor);
  stats.get(actor.id)!.damageDealt += dealt;
  stats.get(actor.id)!.hitsLanded++;
  stats.get(target.id)!.hitsTaken++;
  events.push({
    turn,
    kind,
    actorId: actor.id,
    actorName: actor.name,
    targetId: target.id,
    targetName: target.name,
    abilityId: ability.id,
    abilityName: ability.name,
    amount,
    text:
      `${actor.name} ${kind === 'volley' ? 'catches' : 'hits'} ${target.name} with ${ability.name}` +
      ` for ${amount} (armor ${beforeArmor}→${target.armor}, hp ${beforeHp}→${target.health})`,
  });
  noteDeath(turn, target, events);
}

function fireAbility(
  battleKey: number,
  turn: number,
  actor: Fighter,
  ability: Ability,
  abilityIndex: number,
  primary: Fighter,
  fighters: Fighter[],
  events: BattleEvent[],
  stats: Map<number, FighterStats>,
): void {
  const dist = arena.distance(actor.cell, primary.cell);
  if (dist > ability.range) return; // caller guarantees this, but belt-and-braces

  switch (ability.kind) {
    case AbilityKind.strike: {
      if (!tryHit(battleKey, turn, actor, primary, ability, events, stats)) break;
      dealStrikeDamage(turn, actor, primary, ability, ability.damage ?? 0, events, stats, 'strike');
      break;
    }
    case AbilityKind.volley: {
      if (!tryHit(battleKey, turn, actor, primary, ability, events, stats)) break;
      const radius = ability.aoe ?? 0;
      const dmg = ability.damage ?? 0;
      dealStrikeDamage(turn, actor, primary, ability, dmg, events, stats, 'volley');
      if (radius > 0) {
        for (const e of livingOn(fighters, enemySide(actor.side))) {
          if (e.id === primary.id) continue;
          if (arena.distance(primary.cell, e.cell) > radius) continue;
          // Splash always connects once the primary hit — keeps AoE honest and cheap.
          dealStrikeDamage(turn, actor, e, ability, Math.max(1, (dmg / 2) | 0), events, stats, 'volley');
        }
      }
      break;
    }
    case AbilityKind.ward: {
      const shield = ability.shield ?? 0;
      const before = primary.armor;
      primary.armor += shield;
      events.push({
        turn,
        kind: 'ward',
        actorId: actor.id,
        actorName: actor.name,
        targetId: primary.id,
        targetName: primary.name,
        abilityId: ability.id,
        abilityName: ability.name,
        amount: shield,
        text: `${actor.name} wards ${primary.name} +${shield} armor (${before}→${primary.armor})`,
      });
      break;
    }
    case AbilityKind.weaken: {
      if (!tryHit(battleKey, turn, actor, primary, ability, events, stats)) break;
      const nextBy = ability.weakenBy ?? 0;
      const nextTurns = ability.weakenTurns ?? 1;
      const result = applyTimedMagnitude(
        primary.weakenTurns > 0 ? primary.weakenBy : 0,
        primary.weakenTurns,
        nextBy,
        nextTurns,
      );
      primary.weakenBy = result.mag;
      primary.weakenTurns = result.turns;
      stats.get(actor.id)!.hitsLanded++;
      events.push({
        turn,
        kind: 'weaken',
        actorId: actor.id,
        actorName: actor.name,
        targetId: primary.id,
        targetName: primary.name,
        abilityId: ability.id,
        abilityName: ability.name,
        amount: result.applied ? nextBy : 0,
        text: result.applied
          ? `${actor.name} weakens ${primary.name} (−${primary.weakenBy} dmg for ${primary.weakenTurns}t)`
          : `${actor.name}'s ${ability.name} fails to stick on ${primary.name} (already −${primary.weakenBy} for ${primary.weakenTurns}t)`,
      });
      break;
    }
    case AbilityKind.root: {
      if (!tryHit(battleKey, turn, actor, primary, ability, events, stats)) break;
      // Root is binary (can't move); most impactful = longest remaining duration.
      const nextRoot = ability.rootTurns ?? 1;
      const before = primary.rootedIn;
      primary.rootedIn = Math.max(primary.rootedIn, nextRoot);
      stats.get(actor.id)!.hitsLanded++;
      events.push({
        turn,
        kind: 'root',
        actorId: actor.id,
        actorName: actor.name,
        targetId: primary.id,
        targetName: primary.name,
        abilityId: ability.id,
        abilityName: ability.name,
        amount: primary.rootedIn,
        text: primary.rootedIn > before
          ? `${actor.name} roots ${primary.name} for ${primary.rootedIn}t`
          : `${actor.name}'s ${ability.name} finds ${primary.name} already rooted (${primary.rootedIn}t)`,
      });
      break;
    }
  }

  actor.abilityReadyIn[abilityIndex] = ability.cooldown;
}

function buildSummary(result: Omit<BattleResult, 'summary'>): string[] {
  const lines: string[] = [];
  const label = result.outcome === 'draw' ? 'draw' : `side ${result.outcome} wins`;
  lines.push(`${result.title}: ${label} in ${result.turnsPlayed} turns`);
  const aAlive = result.fighters.filter((f) => f.side === Side.A && f.health > 0).length;
  const bAlive = result.fighters.filter((f) => f.side === Side.B && f.health > 0).length;
  lines.push(`survivors — A: ${aAlive}, B: ${bAlive}`);

  const ranked = [...result.stats].sort((x, y) => y.damageDealt - x.damageDealt);
  if (ranked[0] && ranked[0].damageDealt > 0) {
    lines.push(`top damage: ${ranked[0].name} (${ranked[0].damageDealt})`);
  }
  const healer = [...result.stats].sort((x, y) => y.healingDone - x.healingDone)[0];
  if (healer && healer.healingDone > 0) {
    lines.push(`top healing: ${healer.name} (${healer.healingDone})`);
  }
  const dodger = [...result.stats].sort((x, y) => y.dodges - x.dodges)[0];
  if (dodger && dodger.dodges > 0) {
    lines.push(`most dodges: ${dodger.name} (${dodger.dodges})`);
  }
  return lines;
}

/**
 * Resolve one combat. Returns turn frames for replay (deployment = frame 0).
 * Same battleId + same fighters + same arena ⇒ bit-identical outcome.
 */
export function runBattle(
  battleId: string,
  initial: readonly Fighter[],
  title = battleId,
  arenaOrHeight?: Arena | number,
): BattleResult {
  if (initial.length === 0) throw new Error('runBattle requires at least one fighter');

  const aCount = initial.filter((f) => f.side === Side.A).length;
  const bCount = initial.filter((f) => f.side === Side.B).length;
  if (arenaOrHeight instanceof Arena) {
    arena = arenaOrHeight;
  } else if (typeof arenaOrHeight === 'number') {
    arena = new Arena(arenaOrHeight);
  } else {
    arena = new Arena(heightForForce(aCount, bCount));
  }

  const seen = new Set<number>();
  const cells = new Set<number>();
  for (const f of initial) {
    if (seen.has(f.id)) throw new Error(`duplicate fighter id ${f.id}`);
    seen.add(f.id);
    arena.assertDeploy(f.side, f.cell);
    if (cells.has(f.cell)) throw new Error(`two fighters deployed on cell ${f.cell}`);
    cells.add(f.cell);
    if (f.abilityReadyIn.length !== f.abilities.length) {
      throw new Error(`${f.name}: abilityReadyIn length must match abilities`);
    }
  }

  const battleKey = hashString(battleId);
  const fighters = initial.map(cloneFighter);
  const stats = new Map<number, FighterStats>();
  for (const f of fighters) stats.set(f.id, emptyStats(f));

  const allEvents: BattleEvent[] = [];
  const frames: BattleFrame[] = [
    { turn: 0, fighters: fighters.map(snapshotFighter), events: [] },
  ];

  const slim = fighters.length >= 40;

  let turnsPlayed = 0;
  for (let turn = 0; turn < TURNS_PER_COMBAT; turn++) {
    const early = outcomeOf(fighters);
    if (early !== null) break;

    const turnEvents: BattleEvent[] = [];
    const order = living(fighters).sort((a, b) => b.speed - a.speed || a.id - b.id);

    for (const actor of order) {
      if (actor.health <= 0) continue;

      let acted = false;
      const chase = pickEnemy(actor, fighters);
      const dist = chase ? arena.distance(actor.cell, chase.cell) : 0;
      const readyMin = readyEnemyMinRange(actor);

      // Too close for every ready shot → kite before firing (ranged hold distance).
      // Melee min-range is 1, so this never steals a real adjacent swing.
      if (
        chase !== null &&
        readyMin !== null &&
        dist < readyMin &&
        tryEngageMove(turn, actor, fighters, turnEvents)
      ) {
        acted = true;
      }

      if (!acted) {
        for (let ai = 0; ai < actor.abilities.length; ai++) {
          if (actor.abilityReadyIn[ai]! > 0) continue;
          const ability = actor.abilities[ai]!;
          const primary = primaryForAbility(actor, ability, fighters);
          if (primary === null) continue;
          if (arena.distance(actor.cell, primary.cell) > ability.range) continue;

          fireAbility(battleKey, turn, actor, ability, ai, primary, fighters, turnEvents, stats);
          acted = true;
          break;
        }
      }

      // Nothing to cast: close the gap or finish kiting toward preferred range.
      if (!acted && tryEngageMove(turn, actor, fighters, turnEvents)) {
        acted = true;
      }

      if (!acted && !slim) {
        turnEvents.push({
          turn,
          kind: 'wait',
          actorId: actor.id,
          actorName: actor.name,
          text: `${actor.name} waits`,
        });
      }
    }

    for (const f of fighters) {
      if (f.health > 0) tickStatuses(f);
    }

    const kept = slim ? turnEvents.filter((e) => e.kind !== 'wait') : turnEvents;
    allEvents.push(...kept);
    turnsPlayed = turn + 1;
    frames.push({
      turn: turnsPlayed,
      fighters: fighters.map(snapshotFighter),
      events: kept,
    });

    if (outcomeOf(fighters) !== null) break;
  }

  for (const f of fighters) {
    const s = stats.get(f.id)!;
    s.survived = f.health > 0;
    s.finalHealth = f.health;
  }

  const outcome = outcomeOf(fighters) ?? 'draw';
  const partial = {
    battleId,
    title,
    turnsPlayed,
    outcome,
    fighters,
    frames,
    events: allEvents,
    stats: [...stats.values()],
    arena: { width: arena.width, height: arena.height },
  };
  return { ...partial, summary: buildSummary(partial) };
}
