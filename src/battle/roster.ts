import { arenaIndex, DEPLOY_A_COLS, DEPLOY_B_COLS, heightForForce } from './arena.ts';
import type { Ability, Fighter } from './types.ts';
import { AbilityKind, Side } from './types.ts';

/** Factory helpers — keep ability tables readable. */
export function strike(id: string, name: string, range: number, cooldown: number, damage: number, accuracy?: number): Ability {
  return { id, name, kind: AbilityKind.strike, range, cooldown, damage, accuracy };
}

export function volley(id: string, name: string, range: number, cooldown: number, damage: number, aoe: number, accuracy?: number): Ability {
  return { id, name, kind: AbilityKind.volley, range, cooldown, damage, aoe, accuracy };
}

export function ward(id: string, name: string, range: number, cooldown: number, shield: number): Ability {
  return { id, name, kind: AbilityKind.ward, range, cooldown, shield };
}

export function weaken(id: string, name: string, range: number, cooldown: number, weakenBy: number, weakenTurns: number, accuracy?: number): Ability {
  return { id, name, kind: AbilityKind.weaken, range, cooldown, weakenBy, weakenTurns, accuracy };
}

export function root(id: string, name: string, range: number, cooldown: number, rootTurns: number, accuracy?: number): Ability {
  return { id, name, kind: AbilityKind.root, range, cooldown, rootTurns, accuracy };
}

export interface Template {
  name: string;
  glyph: string;
  role: string;
  maxHealth: number;
  armor: number;
  speed: number;
  moveCooldown: number;
  accuracy: number;
  dodge: number;
  abilities: Ability[];
}

/**
 * Named combatants for scenario authoring. Stats are tuned for 40-turn arenas —
 * measured by running the scenario set, not guessed in isolation.
 */
export const Templates = {
  /** Slow plate — soaks, then crushes. */
  ashplate: {
    name: 'Ashplate',
    glyph: 'Å',
    role: 'bastion',
    maxHealth: 70,
    armor: 22,
    speed: 4,
    moveCooldown: 5,
    accuracy: 0.85,
    dodge: 0.05,
    abilities: [
      strike('crush', 'Plate Crush', 1, 4, 14, 0.9),
      strike('bash', 'Shield Bash', 1, 3, 8, 0.95),
    ],
  },
  /** Mirror bastion for the other side. */
  slagguard: {
    name: 'Slagguard',
    glyph: 'Sg',
    role: 'bastion',
    maxHealth: 68,
    armor: 20,
    speed: 4,
    moveCooldown: 5,
    accuracy: 0.85,
    dodge: 0.05,
    abilities: [
      strike('crush', 'Slag Crush', 1, 4, 13, 0.9),
      strike('bash', 'Rim Bash', 1, 3, 8, 0.95),
    ],
  },
  /** Fast, thin, slippery. */
  reedstep: {
    name: 'Reedstep',
    glyph: 'Re',
    role: 'skirmisher',
    maxHealth: 28,
    armor: 2,
    speed: 14,
    moveCooldown: 2,
    accuracy: 0.8,
    dodge: 0.45,
    abilities: [
      strike('knives', 'Twin Knives', 1, 2, 7, 0.85),
      weaken('feint', 'Dust Feint', 1, 5, 4, 3, 0.9),
    ],
  },
  mirage: {
    name: 'Mirage',
    glyph: 'Mi',
    role: 'skirmisher',
    maxHealth: 24,
    armor: 0,
    speed: 15,
    moveCooldown: 2,
    accuracy: 0.78,
    dodge: 0.55,
    abilities: [
      strike('cut', 'Glass Cut', 1, 2, 6, 0.82),
      root('tangle', 'Ankle Tangle', 1, 6, 2, 0.75),
    ],
  },
  /** Long range, slow cadence. */
  sunstring: {
    name: 'Sunstring',
    glyph: 'Su',
    role: 'archer',
    maxHealth: 32,
    armor: 4,
    speed: 9,
    moveCooldown: 4,
    accuracy: 0.88,
    dodge: 0.12,
    abilities: [
      strike('snipe', 'Sunbolt', 7, 3, 11, 0.92),
      volley('rain', 'Ember Rain', 6, 7, 7, 1, 0.8),
    ],
  },
  bolsister: {
    name: 'Bolt-sister',
    glyph: 'Bo',
    role: 'crossbow',
    maxHealth: 34,
    armor: 5,
    speed: 8,
    moveCooldown: 4,
    accuracy: 0.9,
    dodge: 0.1,
    abilities: [
      strike('bolt', 'Quarrel', 6, 3, 10, 0.93),
      strike('pin', 'Pinning Bolt', 5, 5, 6, 0.88),
    ],
  },
  glasseye: {
    name: 'Glass-eye',
    glyph: 'Ge',
    role: 'sniper',
    maxHealth: 26,
    armor: 2,
    speed: 7,
    moveCooldown: 5,
    accuracy: 0.95,
    dodge: 0.08,
    abilities: [
      strike('lance', 'Glass Lance', 9, 5, 16, 0.97),
      strike('stitch', 'Stitch Shot', 8, 3, 8, 0.9),
    ],
  },
  /** Buffer — ward / disrupt, no HP restore on the cooldown list. */
  saltwise: {
    name: 'Saltwise',
    glyph: 'Sa',
    role: 'warder',
    maxHealth: 30,
    armor: 6,
    speed: 10,
    moveCooldown: 3,
    accuracy: 0.7,
    dodge: 0.15,
    abilities: [
      ward('ward', 'Salt Ward', 4, 5, 8),
      weaken('brine', 'Brine Bind', 4, 5, 3, 3, 0.8),
      strike('staff', 'Staff Tap', 1, 4, 4, 0.75),
    ],
  },
  choir: {
    name: 'Choir',
    glyph: 'Ch',
    role: 'warder',
    maxHealth: 28,
    armor: 4,
    speed: 9,
    moveCooldown: 3,
    accuracy: 0.65,
    dodge: 0.12,
    abilities: [
      ward('veil', 'Ash Veil', 5, 6, 10),
      weaken('dirge', 'Soft Dirge', 5, 5, 3, 3, 0.85),
      strike('note', 'Hard Note', 3, 4, 5, 0.75),
    ],
  },
  /** Debuff specialist. */
  cindertongue: {
    name: 'Cinder-tongue',
    glyph: 'Ci',
    role: 'hexer',
    maxHealth: 30,
    armor: 3,
    speed: 11,
    moveCooldown: 3,
    accuracy: 0.82,
    dodge: 0.18,
    abilities: [
      weaken('hex', 'Ash Hex', 5, 4, 5, 4, 0.9),
      root('snare', 'Cinder Snare', 4, 5, 3, 0.85),
      strike('brand', 'Brand', 3, 3, 5, 0.8),
    ],
  },
  /** Midline bruiser. */
  wagonram: {
    name: 'Wagon-ram',
    glyph: 'Wr',
    role: 'bruiser',
    maxHealth: 55,
    armor: 12,
    speed: 6,
    moveCooldown: 4,
    accuracy: 0.86,
    dodge: 0.08,
    abilities: [
      strike('ram', 'Shoulder Ram', 1, 3, 12, 0.9),
      strike('hook', 'Chain Hook', 2, 4, 8, 0.85),
    ],
  },
  dustpike: {
    name: 'Dustpike',
    glyph: 'Dp',
    role: 'bruiser',
    maxHealth: 48,
    armor: 10,
    speed: 7,
    moveCooldown: 3,
    accuracy: 0.84,
    dodge: 0.1,
    abilities: [
      strike('pike', 'Reach Pike', 2, 3, 10, 0.88),
      root('trip', 'Shaft Trip', 2, 5, 2, 0.8),
    ],
  },
} as const satisfies Record<string, Template>;

export type TemplateId = keyof typeof Templates;

let nextId = 1;

export function resetFighterIds(start = 1): void {
  nextId = start;
}

/** Spawn a fighter from a template into a deploy cell. */
export function spawn(
  templateId: TemplateId,
  side: Side,
  col: number,
  row: number,
  nameOverride?: string,
): Fighter {
  const t = Templates[templateId];
  const id = nextId++;
  const cell = arenaIndex(col, row);
  return {
    id,
    side,
    name: nameOverride ?? t.name,
    glyph: t.glyph,
    role: t.role,
    templateId,
    cell,
    deployCell: cell,
    health: t.maxHealth,
    maxHealth: t.maxHealth,
    armor: t.armor,
    startArmor: t.armor,
    speed: t.speed,
    moveCooldown: t.moveCooldown,
    accuracy: t.accuracy,
    dodge: t.dodge,
    abilities: t.abilities.map((a) => ({ ...a })),
    abilityReadyIn: t.abilities.map(() => 0),
    moveReadyIn: 0,
    rootedIn: 0,
    weakenBy: 0,
    weakenTurns: 0,
  };
}

export function isTemplateId(id: string): id is TemplateId {
  return Object.prototype.hasOwnProperty.call(Templates, id);
}

/** Catalogue for the battle lab editor. */
export function listTemplates(): Array<{ id: TemplateId } & Template> {
  return (Object.keys(Templates) as TemplateId[]).map((id) => ({
    id,
    ...Templates[id],
    abilities: Templates[id].abilities.map((a) => ({ ...a })),
  }));
}

export interface Placement {
  templateId: string;
  side: Side;
  col: number;
  row: number;
  name?: string;
}

/**
 * Build a fighter list from editor placements. Validates deploy zones and
 * uniqueness; throws a readable Error on bad input (server maps to 400).
 */
export function buildFromPlacements(
  placements: readonly Placement[],
  arenaHeight?: number,
): Fighter[] {
  if (placements.length === 0) {
    throw new Error('need at least one fighter');
  }
  const aCount = placements.filter((p) => p.side === Side.A).length;
  const bCount = placements.filter((p) => p.side === Side.B).length;
  if (aCount === 0 || bCount === 0) {
    throw new Error('both sides need at least one fighter');
  }

  const height = arenaHeight ?? heightForForce(aCount, bCount);
  const maxRow = Math.max(...placements.map((p) => p.row));
  if (maxRow >= height) {
    throw new Error(`placement row ${maxRow} needs arena height > ${maxRow} (have ${height})`);
  }

  resetFighterIds(1);
  const seen = new Set<number>();
  const fighters: Fighter[] = [];
  for (const p of placements) {
    if (!isTemplateId(p.templateId)) {
      throw new Error(`unknown template "${p.templateId}"`);
    }
    if (p.side !== Side.A && p.side !== Side.B) {
      throw new Error(`side must be 0 (A) or 1 (B)`);
    }
    if (p.col < 0 || p.col >= 10 || p.row < 0 || p.row >= height) {
      throw new Error(`cell ${p.col},${p.row} is outside the ${10}×${height} arena`);
    }
    if (p.side === Side.A && (p.col < 0 || p.col > 3)) {
      throw new Error(`side A deploys in cols 0–3 (got ${p.col})`);
    }
    if (p.side === Side.B && (p.col < 6 || p.col > 9)) {
      throw new Error(`side B deploys in cols 6–9 (got ${p.col})`);
    }
    const cell = arenaIndex(p.col, p.row);
    if (seen.has(cell)) {
      throw new Error(`two fighters on cell ${p.col},${p.row}`);
    }
    seen.add(cell);
    fighters.push(spawn(p.templateId, p.side, p.col, p.row, p.name));
  }
  return fighters;
}

/**
 * Pack `count` fighters into a side's 4-column deploy zone, front columns first.
 * Recipe repeats through `mix` (weighted army composition).
 */
export function packArmy(
  side: Side,
  count: number,
  mix: readonly TemplateId[],
  namePrefix: string,
): Fighter[] {
  if (count <= 0) return [];
  if (mix.length === 0) throw new Error('packArmy mix is empty');
  const cols = side === Side.A ? DEPLOY_A_COLS : DEPLOY_B_COLS;
  // Front-loaded: highest-index A col / lowest-index B col first.
  const order = side === Side.A ? [...cols].reverse() : [...cols];
  const out: Fighter[] = [];
  for (let i = 0; i < count; i++) {
    const row = (i / order.length) | 0;
    const col = order[i % order.length]!;
    const templateId = mix[i % mix.length]!;
    out.push(spawn(templateId, side, col, row, `${namePrefix}${i + 1}`));
  }
  return out;
}

/** Host / escort mix — tanks, reach, bows, warders. */
export const MIX_HOST: TemplateId[] = [
  'ashplate', 'ashplate', 'wagonram', 'wagonram', 'dustpike',
  'sunstring', 'bolsister', 'glasseye',
  'saltwise', 'choir',
  'reedstep',
];

/** Raid / breach mix — skirmishers, hexers, crossbows, bruisers. */
export const MIX_RAID: TemplateId[] = [
  'slagguard', 'wagonram', 'dustpike',
  'reedstep', 'reedstep', 'mirage',
  'cindertongue', 'cindertongue',
  'bolsister', 'sunstring',
  'choir',
];

