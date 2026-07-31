export const TURNS_PER_COMBAT = 40;

export const Side = { A: 0, B: 1 } as const;
export type Side = (typeof Side)[keyof typeof Side];

/**
 * Ability kinds. Stats live on the ability (Session 12: role from gear/actions,
 * not a character class). Targeting is fixed per kind so priority lists stay
 * deterministic.
 */
export const AbilityKind = {
  /** Single-target damage vs enemy. */
  strike: 'strike',
  /** Enemy-only AoE damage centred on primary target. */
  volley: 'volley',
  /** Add temporary armor to an ally (absorbs like starting armor). */
  ward: 'ward',
  /** Reduce an enemy's outgoing damage for N turns. */
  weaken: 'weaken',
  /** Prevent an enemy from moving for N turns. */
  root: 'root',
} as const;
export type AbilityKind = (typeof AbilityKind)[keyof typeof AbilityKind];

/**
 * Action / gear stats — Session 12: combat role comes from equipment, not class.
 * `range`, `cooldown`, and kind fields (damage, accuracy, …) live here.
 */
export interface Ability {
  id: string;
  name: string;
  kind: AbilityKind;
  /** Hex range to the primary target. */
  range: number;
  /** Turns after use before this ability is ready again. */
  cooldown: number;
  /** Strike / volley. */
  damage?: number;
  /**
   * Hit chance in [0,1]. Templates set this on every rollable ability;
   * if omitted at resolve time, fighter.accuracy is the fallback (d8f1c3a0).
   */
  accuracy?: number;
  /** Volley blast radius around the primary target (enemies only). */
  aoe?: number;
  /** Ward armor granted. */
  shield?: number;
  /** Weaken: flat damage penalty while active. */
  weakenBy?: number;
  weakenTurns?: number;
  /** Root duration in turns. */
  rootTurns?: number;
}

export interface Fighter {
  id: number;
  side: Side;
  name: string;
  /** Short label for the board (1–2 chars). */
  glyph: string;
  /** Flavour role — display only. */
  role: string;
  /** Roster template this fighter was spawned from (editor / custom battles). */
  templateId: string;
  cell: number;
  /** Home deploy cell — restored between engagement rounds. */
  deployCell: number;
  health: number;
  maxHealth: number;
  armor: number;
  /** Armor restored at the start of each engagement round. */
  startArmor: number;
  speed: number;
  moveCooldown: number;
  /** Base hit chance for abilities that omit their own. */
  accuracy: number;
  /** Chance to negate a hit that otherwise connected. */
  dodge: number;
  /** Ordered priority list — first ready ability with a valid target fires. */
  abilities: Ability[];
  abilityReadyIn: number[];
  moveReadyIn: number;
  /**
   * Status — one best buff and one best debuff per stat (decision 0038).
   * Same-polarity effects do not stack; opposing polarities net together.
   * Weaken today occupies the outgoing-damage debuff slot only.
   */
  /** Turns remaining unable to move. */
  rootedIn: number;
  /** Flat reduction to damage this fighter deals while weakenTurns > 0. */
  weakenBy: number;
  weakenTurns: number;
}

export type BattleOutcome = 'A' | 'B' | 'draw';

export type BattleEventKind =
  | 'move'
  | 'strike'
  | 'volley'
  | 'ward'
  | 'weaken'
  | 'root'
  | 'miss'
  | 'dodge'
  | 'wait'
  | 'death';

export interface BattleEvent {
  turn: number;
  kind: BattleEventKind;
  actorId: number;
  actorName: string;
  targetId?: number;
  targetName?: string;
  abilityId?: string;
  abilityName?: string;
  amount?: number;
  fromCell?: number;
  toCell?: number;
  text: string;
}

export interface FighterSnapshot {
  id: number;
  side: Side;
  name: string;
  glyph: string;
  role: string;
  cell: number;
  health: number;
  maxHealth: number;
  armor: number;
  rootedIn: number;
  weakenBy: number;
  weakenTurns: number;
  /** Turns until each ability is ready again (parallel to kit order). */
  abilityReadyIn: number[];
  /** Turns until this fighter can move again. */
  moveReadyIn: number;
  alive: boolean;
}

/** State after deployment (turn 0) or after a full turn resolves. */
export interface BattleFrame {
  turn: number;
  fighters: FighterSnapshot[];
  events: BattleEvent[];
}

export interface FighterStats {
  id: number;
  name: string;
  side: Side;
  damageDealt: number;
  healingDone: number;
  hitsLanded: number;
  hitsTaken: number;
  misses: number;
  dodges: number;
  survived: boolean;
  finalHealth: number;
}

export interface BattleResult {
  battleId: string;
  title: string;
  turnsPlayed: number;
  outcome: BattleOutcome;
  fighters: readonly Fighter[];
  frames: BattleFrame[];
  events: BattleEvent[];
  stats: FighterStats[];
  summary: string[];
  arena: { width: number; height: number };
}

/**
 * Multi-round engagement (Session 12): damage persists across rounds; armor and
 * positions reset to deployment each round. One "battle" = 40 turns.
 */
export interface EngagementRound {
  round: number;
  result: BattleResult;
  aliveA: number;
  aliveB: number;
}

export interface EngagementResult {
  engagementId: string;
  title: string;
  roundsPlayed: number;
  outcome: BattleOutcome;
  rounds: EngagementRound[];
  /** Aggregate stats across all rounds. */
  stats: FighterStats[];
  fighters: readonly Fighter[];
  summary: string[];
  arena: { width: number; height: number };
  maxRounds: number;
}

export interface Scenario {
  id: string;
  title: string;
  blurb: string;
  /** What this fight is meant to probe. */
  probes: string;
  fighters: Fighter[];
  /** Arena height; omitted → derived from force size. */
  arenaHeight?: number;
  /** Engagement rounds before a forced draw. Default 12. */
  maxRounds?: number;
  /** Optional world biome key for arena terrain (a1e9b472). */
  biomeKey?: string;
}

export function assertDeployCell(
  side: Side,
  cell: number,
  height = 6,
  width = 10,
): void {
  const col = cell % width;
  const row = (cell / width) | 0;
  if (row < 0 || row >= height || col < 0 || col >= width) {
    throw new Error(`cell ${cell} is outside the ${width}×${height} arena`);
  }
  if (side === Side.A && (col < 0 || col > 3)) {
    throw new Error(`side A must deploy in cols 0–3 (got col ${col})`);
  }
  if (side === Side.B && (col < 6 || col > 9)) {
    throw new Error(`side B must deploy in cols 6–9 (got col ${col})`);
  }
}

export function snapshotFighter(f: Fighter): FighterSnapshot {
  return {
    id: f.id,
    side: f.side,
    name: f.name,
    glyph: f.glyph,
    role: f.role,
    cell: f.cell,
    health: f.health,
    maxHealth: f.maxHealth,
    armor: f.armor,
    rootedIn: f.rootedIn,
    weakenBy: f.weakenBy,
    weakenTurns: f.weakenTurns,
    abilityReadyIn: f.abilityReadyIn.slice(),
    moveReadyIn: f.moveReadyIn,
    alive: f.health > 0,
  };
}
