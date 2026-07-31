/**
 * Multi-round engagement — Session 12 "several battles / ticks".
 *
 * Each round is a full 40-turn battle. Between rounds:
 *   - HP (and deaths) persist
 *   - armor resets to startArmor
 *   - positions reset to deployCell
 *   - cooldowns and status effects clear
 */

import { Arena, heightForForce } from './arena.ts';
import { runBattle } from './resolve.ts';
import type { TerrainField } from './terrain.ts';
import type {
  BattleOutcome,
  EngagementResult,
  EngagementRound,
  Fighter,
  FighterStats,
} from './types.ts';
import { Side } from './types.ts';

export const DEFAULT_MAX_ROUNDS = 12;

function cloneFighter(f: Fighter): Fighter {
  return {
    ...f,
    abilities: f.abilities.map((a) => ({ ...a })),
    abilityReadyIn: f.abilityReadyIn.slice(),
  };
}

function resetForNextRound(f: Fighter): void {
  if (f.health <= 0) return;
  f.cell = f.deployCell;
  f.armor = f.startArmor;
  f.rootedIn = 0;
  f.weakenBy = 0;
  f.weakenTurns = 0;
  f.moveReadyIn = 0;
  for (let i = 0; i < f.abilityReadyIn.length; i++) f.abilityReadyIn[i] = 0;
}

function aliveCount(fighters: readonly Fighter[], side: Side): number {
  return fighters.filter((f) => f.health > 0 && f.side === side).length;
}

function mergeStats(into: Map<number, FighterStats>, add: readonly FighterStats[]): void {
  for (const s of add) {
    const cur = into.get(s.id);
    if (!cur) {
      into.set(s.id, { ...s });
      continue;
    }
    cur.damageDealt += s.damageDealt;
    cur.healingDone += s.healingDone;
    cur.hitsLanded += s.hitsLanded;
    cur.hitsTaken += s.hitsTaken;
    cur.misses += s.misses;
    cur.dodges += s.dodges;
    cur.survived = s.survived;
    cur.finalHealth = s.finalHealth;
  }
}

export interface EngagementOptions {
  engagementId: string;
  title?: string;
  fighters: readonly Fighter[];
  arena?: Arena;
  terrain?: TerrainField | null;
  maxRounds?: number;
}

/**
 * Fight until one side is wiped or maxRounds is hit.
 * Round N's battleId is `${engagementId}#${N}` so rolls differ per round.
 */
export function runEngagement(opts: EngagementOptions): EngagementResult {
  const {
    engagementId,
    title = engagementId,
    maxRounds = DEFAULT_MAX_ROUNDS,
  } = opts;

  if (opts.fighters.length === 0) throw new Error('engagement needs fighters');

  const aCount = opts.fighters.filter((f) => f.side === Side.A).length;
  const bCount = opts.fighters.filter((f) => f.side === Side.B).length;
  const arena = opts.arena ?? new Arena(heightForForce(aCount, bCount));
  const terrain = opts.terrain ?? null;

  let fighters = opts.fighters.map(cloneFighter);
  const rounds: EngagementRound[] = [];
  const agg = new Map<number, FighterStats>();

  let outcome: BattleOutcome = 'draw';

  for (let round = 1; round <= maxRounds; round++) {
    if (aliveCount(fighters, Side.A) === 0 || aliveCount(fighters, Side.B) === 0) break;

    // Living fighters keep wounds; everyone living re-deploys.
    for (const f of fighters) resetForNextRound(f);

    const living = fighters.filter((f) => f.health > 0);
    const result = runBattle(`${engagementId}#${round}`, living, {
      title: `${title} — round ${round}`,
      arena,
      terrain,
    });

    // Merge survivors' HP back onto the full roster (dead stay dead).
    const byId = new Map(result.fighters.map((f) => [f.id, f]));
    fighters = fighters.map((f) => {
      const updated = byId.get(f.id);
      if (!updated) return f; // was already dead going in
      return cloneFighter(updated);
    });

    mergeStats(agg, result.stats);
    rounds.push({
      round,
      result,
      aliveA: aliveCount(fighters, Side.A),
      aliveB: aliveCount(fighters, Side.B),
    });

    const aAlive = aliveCount(fighters, Side.A);
    const bAlive = aliveCount(fighters, Side.B);
    if (aAlive === 0 && bAlive === 0) {
      outcome = 'draw';
      break;
    }
    if (aAlive === 0) {
      outcome = 'B';
      break;
    }
    if (bAlive === 0) {
      outcome = 'A';
      break;
    }
    if (round === maxRounds) outcome = 'draw';
  }

  for (const f of fighters) {
    const s = agg.get(f.id);
    if (s) {
      s.survived = f.health > 0;
      s.finalHealth = f.health;
    }
  }

  const summary = [
    `${title}: ${outcome === 'draw' ? 'draw' : `side ${outcome} wins`} after ${rounds.length} battle(s)`,
    `survivors — A: ${aliveCount(fighters, Side.A)}, B: ${aliveCount(fighters, Side.B)}`,
    `arena ${arena.width}×${arena.height}`,
  ];
  const top = [...agg.values()].sort((a, b) => b.damageDealt - a.damageDealt)[0];
  if (top && top.damageDealt > 0) {
    summary.push(`top damage: ${top.name} (${top.damageDealt})`);
  }

  return {
    engagementId,
    title,
    roundsPlayed: rounds.length,
    outcome,
    rounds,
    stats: [...agg.values()],
    fighters,
    summary,
    arena: { width: arena.width, height: arena.height },
    maxRounds,
  };
}

/** Session 12 automation primitive — exact preview for a fixed engagementId. */
export interface Assessment {
  outcome: BattleOutcome;
  ticksToResolve: number;
  expectedLosses: { A: number; B: number };
  remaining: { A: number; B: number };
  summary: string[];
  engagement: EngagementResult;
}

/**
 * assess_engagement(force, target) — re-sim the engagement and report outcome,
 * losses, and ticks. Deterministic for the given engagementId.
 */
export function assessEngagement(opts: EngagementOptions): Assessment {
  const initialA = opts.fighters.filter((f) => f.side === Side.A).length;
  const initialB = opts.fighters.filter((f) => f.side === Side.B).length;
  const engagement = runEngagement(opts);
  const remainingA = aliveCount(engagement.fighters, Side.A);
  const remainingB = aliveCount(engagement.fighters, Side.B);
  const expectedLosses = {
    A: initialA - remainingA,
    B: initialB - remainingB,
  };
  const summary = [
    `assess ${opts.engagementId}: ${engagement.outcome === 'draw' ? 'draw' : `side ${engagement.outcome} wins`}`,
    `ticks_to_resolve ${engagement.roundsPlayed}`,
    `expected_losses A ${expectedLosses.A} / B ${expectedLosses.B}`,
    `remaining A ${remainingA} / B ${remainingB}`,
  ];
  return {
    outcome: engagement.outcome,
    ticksToResolve: engagement.roundsPlayed,
    expectedLosses,
    remaining: { A: remainingA, B: remainingB },
    summary,
    engagement,
  };
}
