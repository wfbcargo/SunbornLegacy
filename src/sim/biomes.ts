/**
 * Biomes, the materials they yield, and the transition rules between them.
 *
 * THREE INVARIANTS govern this file. `invariants.ts` checks all three on demand.
 *
 * 1. NO ABSORBING STATES. Every biome has a way out. A ruleset made only of
 *    ratchets (forest -> desert -> glass) converges on a featureless ball; the
 *    fast-forward does not cause that, it only reveals it sooner.
 *
 * 2. SPARSE EDGES, TOTAL REACHABILITY. The direct graph is deliberately thin and
 *    physically sensible — glass does not become rainforest — but the reachability
 *    closure is complete: the transition graph is ONE strongly connected component.
 *    Glass shatters to sand, sand waters to soil, soil grows grassland, grassland
 *    becomes forest, wet forest becomes rainforest.
 *
 * 3. NO SILENT DUPLICATE EDGES. Fan-outs derived from predicates must not hand a
 *    biome a second copy of a rule it already carries by hand. That is not a graph
 *    defect, it is a RATE defect: marsh with a `coast drowns` rule AND a membership
 *    in the generic `sea takes it` fan-out erodes ~26% faster per day than the rate
 *    SIMULATION.md validated, and the coastline stops being a two-way membrane.
 *
 * The Sun God SHAPES. Glass is an intermediate, not a graveyard: it has three exits
 * (quake shatter, slow dissolution, weathering). Lava is a real biome with a real
 * dwell time, not a visual effect, and it is the door to fertile soil.
 *
 * The rare and difficult paths are gated on CYCLE FLAGS rather than on climate, so a
 * world's cycle set decides which parts of the graph are open and how fast. A world
 * with no tectonics grows no mountains; a world with no volcanism has no cheap route
 * to fertile soil. That is the GM's difficulty dial, expressed as graph connectivity.
 */

import { CycleFlag } from './cycles.ts';
import { hashString } from './rng.ts';

export const Biome = {
  Ocean: 0,
  Shallows: 1,
  FrozenSea: 2,
  Marsh: 3,
  Swamp: 4,
  Grassland: 5,
  Savanna: 6,
  Forest: 7,
  Rainforest: 8,
  Bloom: 9,
  Tundra: 10,
  Glacier: 11,
  Desert: 12,
  Badlands: 13,
  Mountain: 14,
  Rock: 15,
  Basalt: 16,
  Lava: 17,
  Ash: 18,
  Glass: 19,
  Soil: 20,
  Barren: 21,
} as const;
export type Biome = (typeof Biome)[keyof typeof Biome];

export const BIOME_COUNT = 22;

export interface BiomeDef {
  readonly id: Biome;
  readonly key: string;
  readonly name: string;
  readonly glyph: string;
  /** 256-colour ANSI code, for the map render. */
  readonly colour: number;
  /** Fluid for flow / coastline purposes. NOTE: lava is water AND molten. */
  readonly water: boolean;
  /** Molten fluid. Must be excluded from waterNeighbours in the hydrology. */
  readonly molten: boolean;
  /**
   * Saturated moisture this biome injects into the hydrology. Open sea is 100; ice
   * caps evaporation so frozen sea is a WEAK source at 55; everything else is a sink
   * and takes its moisture by diffusion. Lava is 0 — a lava field must not irrigate
   * the desert around it.
   */
  readonly moistureSource: number;
  /** Carries living cover: burns to ash, freezes to tundra, seeds regrowth. */
  readonly vegetated: boolean;
  /** Consolidated stone: resists the sea, erodes rather than drowns. */
  readonly stone: boolean;
  /**
   * Heat this tile adds to ITSELF. Elevation and latent heat, not albedo — these do
   * not depend on what the neighbours became, so they cannot self-amplify.
   * Deliberately 0 for glacier and frozen sea: separating a biome's formation
   * threshold from its reversal threshold by the biome's own heat term is how you
   * build a latch, and a latch is an absorbing state wearing a climate costume.
   */
  readonly selfHeat: number;
  /** What a region of this biome can export. The economy's supply side. */
  readonly materials: readonly string[];
}

export const BIOMES: readonly BiomeDef[] = [
  { id: Biome.Ocean,      key: 'ocean',      name: 'Deep Ocean',   glyph: '~', colour: 19,  water: true,  molten: false, moistureSource: 100, vegetated: false, stone: false, selfHeat: 0,   materials: ['brine', 'kelp', 'deepfish'] },
  { id: Biome.Shallows,   key: 'shallows',   name: 'Shallows',     glyph: '-', colour: 45,  water: true,  molten: false, moistureSource: 100, vegetated: false, stone: false, selfHeat: 0,   materials: ['coral', 'pearl', 'seasalt'] },
  { id: Biome.FrozenSea,  key: 'frozensea',  name: 'Frozen Sea',   glyph: '_', colour: 117, water: true,  molten: false, moistureSource: 55,  vegetated: false, stone: false, selfHeat: 0,   materials: ['packice', 'krilloil', 'coldlight'] },
  { id: Biome.Marsh,      key: 'marsh',      name: 'Cool Marsh',   glyph: '%', colour: 65,  water: false, molten: false, moistureSource: 0,   vegetated: true,  stone: false, selfHeat: 0,   materials: ['reed', 'peat', 'clay'] },
  { id: Biome.Swamp,      key: 'swamp',      name: 'Warm Swamp',   glyph: '&', colour: 58,  water: false, molten: false, moistureSource: 0,   vegetated: true,  stone: false, selfHeat: 0,   materials: ['mangrove', 'bogiron', 'lampcap'] },
  { id: Biome.Grassland,  key: 'grassland',  name: 'Grassland',    glyph: '"', colour: 149, water: false, molten: false, moistureSource: 0,   vegetated: true,  stone: false, selfHeat: 0,   materials: ['grain', 'fiber', 'herb'] },
  { id: Biome.Savanna,    key: 'savanna',    name: 'Savanna',      glyph: ';', colour: 179, water: false, molten: false, moistureSource: 0,   vegetated: true,  stone: false, selfHeat: 0,   materials: ['thatch', 'ochre', 'sunhide'] },
  { id: Biome.Forest,     key: 'forest',     name: 'Forest',       glyph: '#', colour: 28,  water: false, molten: false, moistureSource: 0,   vegetated: true,  stone: false, selfHeat: 0,   materials: ['timber', 'resin', 'game'] },
  { id: Biome.Rainforest, key: 'rainforest', name: 'Rainforest',   glyph: '@', colour: 22,  water: false, molten: false, moistureSource: 0,   vegetated: true,  stone: false, selfHeat: 0,   materials: ['ironwood', 'vinesilk', 'dewfruit'] },
  { id: Biome.Bloom,      key: 'bloom',      name: 'Bloom',        glyph: '*', colour: 213, water: false, molten: false, moistureSource: 0,   vegetated: true,  stone: false, selfHeat: 0,   materials: ['sunpetal', 'nectar', 'essence', 'aureole'] },
  { id: Biome.Tundra,     key: 'tundra',     name: 'Tundra',       glyph: ':', colour: 152, water: false, molten: false, moistureSource: 0,   vegetated: true,  stone: false, selfHeat: 0,   materials: ['frostmoss', 'rime', 'pelt'] },
  { id: Biome.Glacier,    key: 'glacier',    name: 'Glacier',      glyph: 'A', colour: 231, water: false, molten: false, moistureSource: 0,   vegetated: false, stone: false, selfHeat: 0,   materials: ['blueice', 'meltwater', 'ivory'] },
  { id: Biome.Desert,     key: 'desert',     name: 'Desert',       glyph: '.', colour: 222, water: false, molten: false, moistureSource: 0,   vegetated: false, stone: false, selfHeat: 0,   materials: ['sand', 'saltpeter', 'sunstone'] },
  { id: Biome.Badlands,   key: 'badlands',   name: 'Badlands',     glyph: 'v', colour: 166, water: false, molten: false, moistureSource: 0,   vegetated: false, stone: true,  selfHeat: 0,   materials: ['shale', 'gypsum', 'fossilbone'] },
  { id: Biome.Mountain,   key: 'mountain',   name: 'Mountain',     glyph: '^', colour: 250, water: false, molten: false, moistureSource: 0,   vegetated: false, stone: true,  selfHeat: -18, materials: ['granite', 'silver', 'skyquartz'] },
  { id: Biome.Rock,       key: 'rock',       name: 'Rock',         glyph: 'n', colour: 245, water: false, molten: false, moistureSource: 0,   vegetated: false, stone: true,  selfHeat: 0,   materials: ['iron', 'stone', 'copper'] },
  { id: Biome.Basalt,     key: 'basalt',     name: 'Basalt',       glyph: '0', colour: 235, water: false, molten: false, moistureSource: 0,   vegetated: false, stone: true,  selfHeat: 0,   materials: ['blackstone', 'olivine', 'magnetite'] },
  { id: Biome.Lava,       key: 'lava',       name: 'Lava',         glyph: '!', colour: 196, water: true,  molten: true,  moistureSource: 0,   vegetated: false, stone: false, selfHeat: 25,  materials: ['obsidian', 'sulfur', 'firesalt'] },
  { id: Biome.Ash,        key: 'ash',        name: 'Ash',          glyph: 'x', colour: 240, water: false, molten: false, moistureSource: 0,   vegetated: false, stone: false, selfHeat: 0,   materials: ['potash', 'char', 'cinder'] },
  { id: Biome.Glass,      key: 'glass',      name: 'Glass',        glyph: '=', colour: 195, water: false, molten: false, moistureSource: 0,   vegetated: false, stone: true,  selfHeat: 0,   materials: ['silica', 'glasslite', 'prism'] },
  { id: Biome.Soil,       key: 'soil',       name: 'Fertile Soil', glyph: '+', colour: 94,  water: false, molten: false, moistureSource: 0,   vegetated: false, stone: false, selfHeat: 0,   materials: ['loam', 'humus', 'quickvine'] },
  { id: Biome.Barren,     key: 'barren',     name: 'Barren',       glyph: ',', colour: 101, water: false, molten: false, moistureSource: 0,   vegetated: false, stone: false, selfHeat: 0,   materials: ['dust', 'gravel', 'scrap'] },
];

// ---------------------------------------------------------------------------
// Environmental thresholds. Heat is centred on 50 = temperate; the beam pushes
// far past 100. Moisture runs 0..100.
// ---------------------------------------------------------------------------

export const GLACIAL = 18;
export const FROZEN = 28;
export const COLD = 40;
export const WARM = 62;
export const SCORCHING = 78;
export const VITRIFY = 110;
export const MOLTEN = 120;

export const ARID = 25;
export const DRY = 40;
export const MOIST = 60;
export const WET = 78;
export const SOAKED = 88;

/**
 * Sea-ice hysteresis. ICE_FORM < ICE_THAW, and the gap is what stops a coastal tile
 * flickering between ice and water every other day.
 *
 * These two numbers were the difference between a breathing polar cap and 12.5% of
 * the world being permanently immutable terrain. Sea ice used to form at heat < 28
 * and break up only above 30, while cold-band sea sat at 6-21 all year — so nothing
 * that froze could ever thaw, `frozensea` grew monotonically at the expense of the
 * land, and the strong-connectivity pillar was violated for an eighth of the map.
 *
 * The cap now breathes because THREE things changed together, and all three are
 * needed: these thresholds, the removal of the ice self-heat / cold-albedo terms
 * (see BiomeDef.selfHeat and World.heatAt), and a seasonal amplitude at the cold band
 * large enough to actually cross ICE_THAW in summer (see cycles.ts Seasons).
 */
export const ICE_FORM = 22;
export const ICE_THAW = 28;

/** Everything a rule can inspect about a tile at evaluation time. */
export interface TileContext {
  readonly biome: Biome;
  readonly heat: number;
  readonly moisture: number;
  /**
   * Neighbouring TRUE water only — ocean, shallows, frozen sea. Lava is water:true
   * for flow purposes but must never be counted here, or a lava field irrigates and
   * cools the desert around it.
   */
  readonly waterNeighbours: number;
  readonly neighbourCounts: Int32Array;
  /**
   * OR of every CycleFlag raised on this tile today — see cycles.ts.
   *
   * This is how the disturbance engine reaches the ruleset. Rules should test flags,
   * never which cycle produced them: `flags & CycleFlag.Focus` means "the ground is
   * melting", whether that is the beam's core or a volcanic vent, so a GM can swap a
   * world's cycle set without rewriting a single transition.
   */
  readonly flags: number;
  /** Sugar for `(flags & CycleFlag.Beam) !== 0`. */
  readonly underBeam: boolean;
}

/**
 * A transition rule AS WRITTEN. Everything an author types; nothing derived.
 *
 * Kept separate from `Rule` so a rule's identity cannot be authored by hand. See
 * `ruleKey`: the whole point is that the key is a function of the rule's content, so
 * there is no way to write two rules that claim the same identity by accident, and no
 * way to change a rule's identity without changing what the rule says.
 */
export interface RuleDef {
  readonly from: Biome;
  readonly to: Biome;
  /** Median lifetime in visits. One visit = one solar revolution = one real day. */
  readonly medianDays: number;
  readonly label: string;
  /** 0 = rule does not apply. >0 = pressure; effective median = medianDays / pressure. */
  readonly when: (c: TileContext) => number;
  /**
   * True when this rule came out of a predicate-derived fan-out rather than being
   * written by hand. `invariants.ts` uses it to enforce invariant 3: a fan-out must
   * never hand a biome a second copy of an edge it already has by hand.
   */
  readonly derived?: boolean;
}

/** A rule with its derived identity attached. This is what the simulation runs on. */
export interface Rule extends RuleDef {
  /** Stable content-derived name — see `ruleKey`. Unique; checked in invariants.ts. */
  readonly key: string;
  /** `hashString(key)`. The roll stream this rule draws from. */
  readonly keyHash: number;
}

/**
 * A rule's stable identity: `<fromBiome>-><toBiome>:<label>`.
 *
 * ★ THIS IS THE FIX FOR THE POSITIONAL-KEYING BUG, and the reason it matters is worth
 * stating precisely, because the old code looked completely reasonable.
 *
 * Every transition roll is `rollAt(worldSeed, tileIndex, day, <rule>)`. That fourth
 * coordinate used to be the rule's INDEX in its per-biome bucket — which is a function
 * of the order rules happen to appear in the `RULES` array. So inserting a rule, or
 * moving one, or adding a biome to a fan-out, silently renumbered every rule after it
 * and handed them each a different stream of dice. Editing the erosion rules changed
 * what the forests did. Every world in every recorded measurement shifted for reasons
 * that had nothing to do with the edit, and nothing anywhere said so.
 *
 * Deriving the key from CONTENT makes a rule's dice a property of the rule. Reordering
 * `RULES` is now a no-op; inserting one perturbs only itself. That is what makes an A/B
 * comparison between two rulesets mean anything at all.
 *
 * `label` is part of the key because from/to alone is not unique — glass has three exits
 * and bloom has two edges to forest at different medians. That does make the label
 * load-bearing rather than decorative: RENAMING A RULE RE-KEYS IT and changes the world.
 * That is the right trade — a rename is a deliberate edit to the rule, where a reorder
 * is not — but it is a sharp edge, so `invariants.ts` checks the keys are unique and
 * `golden.ts` fails if any of this shifts without being intended.
 */
export function ruleKey(r: RuleDef): string {
  return `${BIOMES[r.from]!.key}->${BIOMES[r.to]!.key}:${r.label}`;
}

// ---------------------------------------------------------------------------
// Derived biome sets.
//
// These are DERIVED FROM PREDICATES, never hand-enumerated. A hand-written list is
// a trap factory: one land biome missing from the sea-exposure list is silently
// immune to the ocean, one missing from the freeze list is immune to winter, and
// each omission is a candidate trap node that quietly breaks the single-SCC
// invariant. Add a biome to BIOMES and it joins the right sets automatically.
//
// The cost of deriving them is invariant 3: a predicate cannot know that marsh
// already has a hand-written `coast drowns` rule, so the exclusions below are
// explicit AND `invariants.ts` fails the build if a new one is ever introduced.
// Deriving removed the trap-node hazard and introduced a rate hazard in the same
// move; both are now checked rather than remembered.
// ---------------------------------------------------------------------------

const idsWhere = (p: (d: BiomeDef) => boolean): Biome[] => BIOMES.filter(p).map((d) => d.id);

/**
 * True sea. Excludes lava despite water:true — this is the set world.ts must use when
 * it counts waterNeighbours, or a lava field irrigates and cools the desert around it.
 */
export const SEA: readonly Biome[] = idsWhere((d) => d.water && !d.molten);

/** Wetlands carry their own, gentler drowning rules; see invariant 3. */
const HAND_DROWNED: Biome[] = [Biome.Marsh, Biome.Swamp];

/**
 * Soft ground the sea can simply take. Lava is excluded (water:true) and quenches
 * instead; stone is excluded because it is undercut into rubble first, not drowned
 * whole; glacier is excluded because it has its own calving rule; marsh and swamp are
 * excluded because they already drown by hand at a rate the prototype validated.
 * Every exception still reaches the sea in two steps, so none of them is a trap node.
 */
const DROWNABLE: Biome[] = idsWhere(
  (d) => !d.water && !d.stone && d.id !== Biome.Glacier && !HAND_DROWNED.includes(d.id),
);

/** Consolidated stone. The sea undercuts it rather than swallowing it. */
const STONE: Biome[] = idsWhere((d) => d.stone);

/** Every land biome. Lava is excluded by water:true, which is what we want here. */
const ALL_LAND: Biome[] = idsWhere((d) => !d.water);

/**
 * Biomes that already melt by hand, at rates chosen for what they are made of: sand
 * goes first, glass next, basalt and bedrock last, and a mountain opens without
 * needing to melt at all. The generic "lava overruns it" fan-out must skip them, or
 * every one of those carefully ordered medians is silently halved by a second edge
 * running in parallel — which would make bedrock melt at almost the rate of sand.
 */
const HAND_MELTED: Biome[] = [
  Biome.Desert, Biome.Glass, Biome.Basalt, Biome.Rock, Biome.Mountain,
];

/** Land a lava flow simply runs over, because it has no melt rule of its own. */
const OVERRUNNABLE: Biome[] = ALL_LAND.filter((b) => !HAND_MELTED.includes(b));

/** Anything with living cover. Burns under the beam, freezes under frost. */
const VEGETATED: Biome[] = idsWhere((d) => d.vegetated);

/** Burns to ash. Living cover plus fertile soil's organic load. */
const BURNABLE: Biome[] = [...VEGETATED, Biome.Soil];

/** Takes a frost. Living cover and unconsolidated ground; tundra IS the product. */
const FREEZABLE: Biome[] = idsWhere(
  (d) =>
    !d.water &&
    !d.stone &&
    d.id !== Biome.Tundra &&
    d.id !== Biome.Glacier &&
    (d.vegetated || d.id === Biome.Soil || d.id === Biome.Barren),
);

/**
 * Unconsolidated ground that a quake can drop below sea level. Marsh and swamp are
 * excluded for the same reason they are excluded from DROWNABLE — they already have a
 * hand-written route into shallows, and a third one would triple the wetland's
 * erosion rate against a deposition rate that did not change.
 */
const SUBSIDABLE: Biome[] = idsWhere(
  (d) =>
    !d.water &&
    !d.stone &&
    d.id !== Biome.Glacier &&
    d.id !== Biome.Ash &&
    !HAND_DROWNED.includes(d.id),
);

/** Expand a one-to-many rule template into concrete rules. */
function fanOut(froms: Biome[], rule: Omit<RuleDef, 'from' | 'derived'>): RuleDef[] {
  return froms.map((from) => ({ ...rule, from, derived: true }));
}

const has = (c: TileContext, mask: number): boolean => (c.flags & mask) !== 0;

/**
 * Melting gate. Requires the FOCUS flag — the narrow core of the beam or a live vent —
 * and not merely a high temperature. Under the plain beam band an equatorial tile
 * already passes 120 from latitude plus the validated +70, so a bare `heat > MOLTEN`
 * test would melt the entire tropics into lava on every purge. Focus is raised on a
 * narrow beam core and inside a vent's lava radius, which is the correct footprint.
 * The heat test is still ANDed in so a cold high mountain under the core only bakes.
 */
const melting = (c: TileContext): boolean =>
  has(c, CycleFlag.Focus) && (has(c, CycleFlag.Eruption) || c.heat > MOLTEN);

/** Frost widens the cold band rather than needing a second freezing rule. */
const freezePoint = (c: TileContext): number => (has(c, CycleFlag.Freeze) ? FROZEN + 10 : FROZEN);

/** Seasonal drying. Seasons already move heat and moisture; this is emphasis, not a duplicate. */
const dryingBoost = (c: TileContext): number =>
  has(c, CycleFlag.Heatwave | CycleFlag.Drought) ? 2 : 1;

/** Seasonal wetting: monsoon fronts, the wet season, a plume's grit rain. */
const wettingBoost = (c: TileContext): number => (has(c, CycleFlag.Storm) ? 3 : 1);

/**
 * Living neighbours — the seed bank for recovery.
 *
 * Regrowth rules scale their pressure by this, so a scoured region grows back from
 * its edges inward rather than uniformly. Mechanically it stops a purge from being
 * an absorbing state; visually it is green creeping back across the scar.
 */
function livingNeighbours(c: TileContext): number {
  const n = c.neighbourCounts;
  return (
    n[Biome.Marsh]! + n[Biome.Swamp]! + n[Biome.Grassland]! + n[Biome.Savanna]! +
    n[Biome.Forest]! + n[Biome.Rainforest]! + n[Biome.Bloom]!
  );
}

/** Bedrock neighbours — what badlands gullies into and what orogeny pushes up. */
function stoneNeighbours(c: TileContext): number {
  const n = c.neighbourCounts;
  return n[Biome.Rock]! + n[Biome.Mountain]! + n[Biome.Basalt]!;
}

/** Cold neighbours — glacier needs a cold surround, not just a cold tile. */
function coldNeighbours(c: TileContext): number {
  const n = c.neighbourCounts;
  return n[Biome.Tundra]! + n[Biome.Glacier]! + n[Biome.FrozenSea]!;
}

/** Anything that bakes and sterilises a neighbouring tile. Bloom cannot abide it. */
function hostileNeighbours(c: TileContext): number {
  const n = c.neighbourCounts;
  return n[Biome.Desert]! + n[Biome.Glass]! + n[Biome.Lava]! + n[Biome.Ash]!;
}

/**
 * The bloom envelope. ONE predicate, used by all three bloom rules, so the arrival
 * condition and the fade condition can never drift apart — a mismatch there produces
 * a tile that flickers between bloom and forest every few days forever.
 *
 * This is the narrowest envelope in the set, and deliberately so. Measured at 3-6% of
 * the world on the first pass, which is an order of magnitude too common; the mature-
 * canopy requirement is what brought it back to the fraction of a percent the
 * prototype found. Do NOT widen it to make bloom show up more — its scarcity IS the
 * design, and it is the reason a world is worth crossing.
 */
function blooming(c: TileContext): boolean {
  if (c.moisture < 93 || c.heat < 56 || c.heat > 64) return false;
  if (hostileNeighbours(c) > 0) return false;
  const n = c.neighbourCounts;
  return n[Biome.Forest]! + n[Biome.Rainforest]! + n[Biome.Bloom]! >= 4;
}

/** Standing water OR wetland — what "ocean + forest" actually touches. */
function wetNeighbours(c: TileContext): number {
  return c.waterNeighbours + c.neighbourCounts[Biome.Swamp]! + c.neighbourCounts[Biome.Marsh]!;
}

/** Dry land neighbours. The deposition side of the coastline membrane. */
const landNeighbours = (c: TileContext): number => 6 - c.waterNeighbours;

/**
 * The ruleset as authored.
 *
 * Array ORDER still matters, but only in one narrow way: within a biome's bucket the
 * first rule to fire wins, so ordering is a precedence choice (see the note below).
 * It no longer decides which dice each rule rolls — that is `ruleKey` — so reordering
 * changes precedence and nothing else.
 */
const RULE_DEFS: readonly RuleDef[] = [
  // =========================================================================
  // WORLD CYCLES — the disturbance engine.
  //
  // Cycle-gated rules come FIRST in the array because they are the fast, dramatic
  // ones (medians of 1-3 days, so per-visit probabilities near 0.5) and the
  // first rule to fire wins. Behind slow background weathering they would be
  // routinely pre-empted; in front of it the ordering bias is negligible, because
  // when no cycle is active every one of them returns 0.
  // =========================================================================

  // -- THE BEAM: the Sun God shapes ------------------------------------------
  // He remakes; he does not annihilate. The beam boils water back from the edges,
  // but DEEP OCEAN SURVIVES A PURGE. If deep water can be destroyed, every purge
  // permanently removes the world's moisture source and the map ends as glass.
  {
    from: Biome.Ocean, to: Biome.Shallows, medianDays: 10, label: 'the sea boils back',
    when: (c) => (has(c, CycleFlag.Beam) && c.waterNeighbours <= 4 ? 1 : 0),
  },
  {
    from: Biome.Shallows, to: Biome.Barren, medianDays: 5, label: 'seabed bared',
    when: (c) => (has(c, CycleFlag.Beam) && c.waterNeighbours <= 2 ? 1 : 0),
  },
  {
    from: Biome.FrozenSea, to: Biome.Shallows, medianDays: 2, label: 'ice sheet melts out',
    when: (c) => (has(c, CycleFlag.Beam) ? 1 : 0),
  },
  {
    from: Biome.Glacier, to: Biome.Shallows, medianDays: 3, label: 'glacier melts away',
    when: (c) => (has(c, CycleFlag.Beam) && c.waterNeighbours >= 1 ? 1 : 0),
  },
  {
    from: Biome.Glacier, to: Biome.Rock, medianDays: 3, label: 'ice burns off the bedrock',
    when: (c) => (has(c, CycleFlag.Beam) && c.waterNeighbours < 1 ? 1 : 0),
  },
  ...fanOut(BURNABLE, {
    to: Biome.Ash, medianDays: 1, label: 'burned to ash',
    when: (c) => (has(c, CycleFlag.Beam) ? 1 : 0),
  }),
  {
    from: Biome.Desert, to: Biome.Glass, medianDays: 1, label: 'sand to glass',
    // Not at the focus: there, sand melts instead. sand -> LAVA -> glass is the
    // designer's chain, and it must not be short-circuited by the cheaper edge.
    when: (c) => (has(c, CycleFlag.Beam) && !melting(c) ? 1 : 0),
  },
  {
    from: Biome.Barren, to: Biome.Desert, medianDays: 2, label: 'scorched to sand',
    when: (c) => (has(c, CycleFlag.Beam) ? 1 : 0),
  },
  {
    from: Biome.Ash, to: Biome.Glass, medianDays: 2, label: 'ash fuses',
    when: (c) => (has(c, CycleFlag.Beam) ? 1 : 0),
  },
  {
    from: Biome.Rock, to: Biome.Glass, medianDays: 3, label: 'stone fuses',
    when: (c) => (has(c, CycleFlag.Beam) ? 1 : 0),
  },
  {
    from: Biome.Badlands, to: Biome.Desert, medianDays: 4, label: 'shale bakes to sand',
    when: (c) => (has(c, CycleFlag.Beam) ? 1 : 0),
  },

  // -- MELT: the FOCUS flag, never a bare temperature test --------------------
  // Focus is the beam's narrow core or a live vent. It must be the gate, because
  // under the plain beam band an equatorial tile already exceeds 120 from latitude
  // plus the validated +70 — a bare `heat > MOLTEN` test would turn the entire
  // tropics to lava on every purge. Heat is ANDed in so a cold peak only bakes.
  {
    from: Biome.Desert, to: Biome.Lava, medianDays: 3, label: 'sand melts',
    when: (c) => (melting(c) ? 1 : 0),
  },
  {
    from: Biome.Glass, to: Biome.Lava, medianDays: 4, label: 'glass remelts',
    when: (c) => (melting(c) ? 1 : 0),
  },
  {
    from: Biome.Basalt, to: Biome.Lava, medianDays: 5, label: 'basalt remelts',
    when: (c) => (melting(c) ? (has(c, CycleFlag.Eruption) ? 2 : 1) : 0),
  },
  {
    from: Biome.Rock, to: Biome.Lava, medianDays: 8, label: 'bedrock melts through',
    when: (c) => (melting(c) ? (has(c, CycleFlag.Eruption) ? 2 : 1) : 0),
  },
  {
    // A mountain is the one thing that opens without needing to be melted first —
    // it is where the conduit already is. Eruption, not Focus.
    from: Biome.Mountain, to: Biome.Lava, medianDays: 5, label: 'the mountain vents',
    when: (c) => (has(c, CycleFlag.Eruption) ? 1 : 0),
  },
  // A vent does not care what was growing on top of it. Without this the whole
  // volcanism cycle is hostage to where its vents happen to land: measured with only
  // the stone melt rules above, a `kiln` world produced 0.01% lava and 0.09% basalt,
  // because the vents mostly opened under forest and tundra and simply did nothing.
  //
  // This is one physical event written many times, exactly like "sea takes it" and
  // "burned to ash", and it is gated on the rarest flag pair in the game: Eruption
  // AND Focus, i.e. strictly inside a live vent's lava radius, never the ash plume.
  // It covers only the land that does NOT already melt by hand — see OVERRUNNABLE.
  ...fanOut(OVERRUNNABLE, {
    to: Biome.Lava, medianDays: 6, label: 'lava overruns it',
    when: (c) =>
      has(c, CycleFlag.Eruption) && has(c, CycleFlag.Focus)
        ? 1 + c.neighbourCounts[Biome.Lava]!
        : 0,
  }),

  // -- Lava cools. It cannot persist ------------------------------------------
  // Four exits, all fast. Lava is a real biome with a real dwell time, but a lava
  // field that lasted would be an absorbing state with a heat feedback attached.
  // The unconditional crust rule is the backstop: a tile parked under a permanent
  // vent still hardens over in about a month rather than burning forever.
  {
    from: Biome.Lava, to: Biome.Glass, medianDays: 2, label: 'quenched to glass',
    when: (c) => (c.waterNeighbours >= 1 ? c.waterNeighbours : 0),
  },
  {
    from: Biome.Lava, to: Biome.Soil, medianDays: 6, label: 'cools to fertile ground',
    when: (c) => (!melting(c) && c.moisture > 45 ? 1 : 0),
  },
  {
    from: Biome.Lava, to: Biome.Basalt, medianDays: 5, label: 'cools to basalt',
    when: (c) => (!melting(c) && c.moisture <= 45 ? 1 : 0),
  },
  {
    from: Biome.Lava, to: Biome.Basalt, medianDays: 30, label: 'crust hardens over',
    when: () => 1,
  },

  // -- ASHFALL: the volcanic plume --------------------------------------------
  // Volcanism is the cycle that most raises churn, because its product (soil) is a
  // FLOW rather than a stock: grassland consumes it within weeks.
  ...fanOut(BURNABLE, {
    to: Biome.Ash, medianDays: 7, label: 'ashfall buries it',
    when: (c) => (has(c, CycleFlag.Ashfall) ? 1 + 2 * c.neighbourCounts[Biome.Lava]! : 0),
  }),
  {
    from: Biome.Ash, to: Biome.Basalt, medianDays: 20, label: 'ashfall welds',
    when: (c) => (has(c, CycleFlag.Ashfall | CycleFlag.Eruption) ? 1 : 0),
  },

  // -- QUAKE: shattering and subsidence ---------------------------------------
  {
    from: Biome.Glass, to: Biome.Desert, medianDays: 3, label: 'glass shatters to sand',
    when: (c) => (has(c, CycleFlag.Quake) ? 1 : 0),
  },
  {
    from: Biome.Badlands, to: Biome.Rock, medianDays: 6, label: 'strata split open',
    when: (c) => (has(c, CycleFlag.Quake) ? 1 : 0),
  },
  {
    from: Biome.Barren, to: Biome.Rock, medianDays: 25, label: 'bedrock thrust up',
    when: (c) => (has(c, CycleFlag.Quake) ? 1 : 0),
  },
  {
    // Deliberately slow, and slower than it first looks like it should be. A mountain
    // lives ON a fault, so it is shaken far more often than anything else on the map;
    // at the m150 this rule started on, orogeny and its own destruction were running
    // at comparable rates and mountain never got past 0.7% of the world — which is
    // below the 3%-of-region export threshold, so granite/silver/skyquartz existed in
    // the taxonomy and in zero regions. A quake builds ranges much more often than it
    // levels them; the ordinary way down is erosion and stripping, below.
    from: Biome.Mountain, to: Biome.Rock, medianDays: 600, label: 'the peak comes down',
    when: (c) => (has(c, CycleFlag.Quake) ? 1 : 0),
  },
  // Rivers are an edge feature, not an area, so a quake does not "carve" one here —
  // it drops soft ground below the waterline and the sea comes in. This is also the
  // erosion counterweight that keeps the coastline a two-way membrane on tectonic
  // worlds, where uplift would otherwise be a net ratchet against the sea.
  // The >= 3 is measured, not chosen for symmetry. At >= 2 this rule fires on any soft
  // ground with two wet neighbours — which is most of a coastline, not the edge of it —
  // and on a tectonic world it quietly outran every deposition path put together: water
  // climbed 23% -> 39% over 80 game-years while a beam-only world of the same ruleset
  // converged at 25.8% and a still world sat exactly flat. Subsidence is meant to be the
  // erosion half of a two-way membrane; at >= 2 it was a second, larger ratchet.
  ...fanOut(SUBSIDABLE, {
    to: Biome.Shallows, medianDays: 20, label: 'ground subsides',
    when: (c) => (has(c, CycleFlag.Quake) && c.waterNeighbours >= 3 ? c.waterNeighbours - 2 : 0),
  }),

  // -- UPLIFT: orogeny --------------------------------------------------------
  // The prototype had no orogeny at all: rock sat at 4-5% and only ever weathered
  // down. Uplift is what finally gives the geologic family a SOURCE, not just sinks,
  // and it is the only way mountains are made. A world with no tectonics cycle has
  // no mountains — which is exactly the kind of thing a world's cycle set should
  // decide.
  {
    from: Biome.Rock, to: Biome.Mountain, medianDays: 5, label: 'uplift',
    when: (c) => (has(c, CycleFlag.Uplift) ? 1 + 0.5 * stoneNeighbours(c) : 0),
  },
  {
    from: Biome.Basalt, to: Biome.Mountain, medianDays: 8, label: 'uplift',
    when: (c) => (has(c, CycleFlag.Uplift) ? 1 + 0.5 * stoneNeighbours(c) : 0),
  },
  {
    from: Biome.Badlands, to: Biome.Mountain, medianDays: 12, label: 'uplift',
    when: (c) => (has(c, CycleFlag.Uplift) ? 1 + 0.5 * stoneNeighbours(c) : 0),
  },
  {
    // Barren is the rubble hub, and on a tectonic world the fault ridge is buried in
    // it. Without this door, uplift can only act on stone that is already there, and
    // a range that has finished eroding can never be rebuilt on the same ground.
    from: Biome.Barren, to: Biome.Mountain, medianDays: 14, label: 'uplift',
    when: (c) => (has(c, CycleFlag.Uplift) ? 1 + 0.5 * stoneNeighbours(c) : 0),
  },
  {
    // Ranges widen at their margins. This lets a seeded range thicken during any
    // quake in the shake zone, which is both the real mechanism and the thing that
    // turns a line of peaks into a mountain province.
    //
    // It cannot run away: it needs a quake AND a mountain already adjacent AND bare
    // rock to work on, so it only ever grows outward from existing orogeny and never
    // nucleates on its own.
    from: Biome.Rock, to: Biome.Mountain, medianDays: 15, label: 'the range widens',
    when: (c) =>
      has(c, CycleFlag.Quake) && c.neighbourCounts[Biome.Mountain]! >= 1
        ? c.neighbourCounts[Biome.Mountain]!
        : 0,
  },

  // =========================================================================
  // THE COASTLINE — a two-way membrane
  //
  // Deposition and erosion must balance. If deposition outruns erosion even
  // slightly, the ratchet runs landward and the world's oceans drain over a few
  // game-years — the same absorbing-state failure as heat death, just slower and
  // far less obvious. This ruleset shipped the MIRROR of that bug in review: water
  // ran 24% -> 55% over 60 game-years because `land -> shallows -> frozensea` had no
  // return edge at all. Both directions are now closed, and `sweep.ts` reports the
  // 60-game-year water trend precisely so neither can be reintroduced quietly.
  // =========================================================================
  {
    from: Biome.Marsh, to: Biome.Shallows, medianDays: 8, label: 'coast drowns',
    when: (c) => (c.waterNeighbours >= 3 ? c.waterNeighbours - 2 : 0),
  },
  {
    from: Biome.Swamp, to: Biome.Shallows, medianDays: 8, label: 'coast drowns',
    when: (c) => (c.waterNeighbours >= 4 ? c.waterNeighbours - 3 : 0),
  },
  {
    // Shallows deepen only when they are genuinely out at sea (5+ water neighbours),
    // not merely offshore. At the >= 4 this started on, the shelf was one tile wide
    // everywhere and held 0.4% of the world, which is under the 3%-of-region export
    // threshold in every region on the map — coral, pearl and seasalt existed in the
    // taxonomy and nowhere in the economy. Widening the shelf is safe for the
    // coastline balance in a way that touching deposition is not: this moves tiles
    // between two WATER biomes, so it cannot shift the land/sea ratio at all.
    // The slow tail at 3-4 water neighbours is not a rate choice, it is an
    // ESCAPABILITY choice. Deposition needs >= 4 land neighbours and cannot be relaxed
    // (see `silt builds`), so without this a shelf tile sitting on exactly 3 or 4 water
    // neighbours has no out-rule at all under any climate — permanently immutable
    // terrain on the one biome whose entire job is to be a two-way membrane. At 0.15
    // pressure it is a ~53-day median rather than an 8-day one: the shelf still stands,
    // it just is not immortal. 0.05 is a ~160-day median: enough that no shelf tile is
    // ever stuck, small enough that the shelf stays wide enough for coral, pearl and
    // seasalt to be a regional export somewhere. At 0.15 it was neither.
    from: Biome.Shallows, to: Biome.Ocean, medianDays: 8, label: 'island erodes',
    when: (c) => (c.waterNeighbours >= 5 ? c.waterNeighbours - 4 : c.waterNeighbours >= 3 ? 0.05 : 0),
  },
  ...fanOut(DROWNABLE, {
    to: Biome.Shallows, medianDays: 14, label: 'sea takes it',
    when: (c) => (c.waterNeighbours >= 4 ? c.waterNeighbours - 3 : 0),
  }),
  ...fanOut(STONE, {
    // Stone is not swallowed whole; the surf cuts a platform and leaves rubble,
    // and the rubble is what the sea then takes. Two steps, not one — which is
    // both better physics and a longer, more interesting path through the graph.
    to: Biome.Barren, medianDays: 26, label: 'the sea undercuts it',
    when: (c) => (c.waterNeighbours >= 4 ? c.waterNeighbours - 3 : 0),
  }),
  {
    // Deposition, cold side. Gated on heat so it is mutually exclusive with the
    // swamp rule below: the pair together deposit at exactly the single-rule rate
    // the prototype validated, split by climate rather than doubled.
    // ★ THE >= 4 IS NOT NEGOTIABLE. Deposition only fills a bay that is already almost
    // enclosed. Relaxing it to >= 3 — which looks like a one-neighbour tweak, and was
    // made to close an unrelated escapability hole — drained every ocean on every cycle
    // set to 0.0% within 30 game-years, including the no-disturbance control. That is
    // bug #3 from SIMULATION.md exactly, reproduced in one character. The long-horizon
    // sweep in sweep.ts exists to catch it, and did.
    from: Biome.Shallows, to: Biome.Marsh, medianDays: 12, label: 'silt builds',
    when: (c) => (landNeighbours(c) >= 4 && c.moisture > MOIST && c.heat < 58 ? 1 : 0),
  },
  {
    from: Biome.Shallows, to: Biome.Swamp, medianDays: 12, label: 'mangrove takes hold',
    when: (c) => (landNeighbours(c) >= 4 && c.moisture > MOIST && c.heat >= 58 ? 1 : 0),
  },
  {
    from: Biome.Ocean, to: Biome.Shallows, medianDays: 150, label: 'bay silts up',
    when: (c) => (landNeighbours(c) >= 3 ? landNeighbours(c) - 2 : 0),
  },
  {
    // Orogeny does not need an existing outcrop to push against — a fault under open
    // water raises the seafloor whether or not anything is already sticking out of it.
    // The old `stoneNeighbours >= 1` gate meant uplift essentially never reached the
    // sea, which left subsidence with no counterweight at all on a tectonic world.
    from: Biome.Ocean, to: Biome.Rock, medianDays: 900, label: 'tectonic uplift',
    when: (c) =>
      has(c, CycleFlag.Uplift) ? (stoneNeighbours(c) >= 1 ? 12 : 6) : stoneNeighbours(c) >= 1 ? 1 : 0,
  },
  {
    from: Biome.Shallows, to: Biome.Rock, medianDays: 400, label: 'tectonic uplift',
    when: (c) =>
      has(c, CycleFlag.Uplift) ? (stoneNeighbours(c) >= 2 ? 12 : 6) : stoneNeighbours(c) >= 2 ? 1 : 0,
  },

  // -- Sea ice ----------------------------------------------------------------
  // Sea ice is water:true so a frozen polar ocean does not read as land and let
  // deposition ratchet inward under it. That is correct AND it was, in review, the
  // most expensive line in the ruleset: with no return edge, `frozensea` grew from
  // 11.8% to 37.9% of the world over 60 game-years, eating tundra, glacier and rock.
  // The ice sheet therefore needs a GROUNDING edge (`the ice grounds ashore`), and
  // the thaw thresholds have to be reachable by the climate the cold band actually
  // produces. See ICE_FORM / ICE_THAW above.
  {
    from: Biome.Ocean, to: Biome.FrozenSea, medianDays: 10, label: 'the sea freezes',
    when: (c) => (c.heat < (has(c, CycleFlag.Freeze) ? ICE_FORM + 6 : ICE_FORM) ? 1 : 0),
  },
  {
    from: Biome.Shallows, to: Biome.FrozenSea, medianDays: 8, label: 'the sea freezes',
    when: (c) => (c.heat < (has(c, CycleFlag.Freeze) ? ICE_FORM + 6 : ICE_FORM) ? 1 : 0),
  },
  {
    from: Biome.FrozenSea, to: Biome.Shallows, medianDays: 8, label: 'the ice breaks up',
    when: (c) => (c.heat > ICE_THAW && c.waterNeighbours < 5 ? 1 : 0),
  },
  {
    from: Biome.FrozenSea, to: Biome.Ocean, medianDays: 8, label: 'the ice breaks up',
    when: (c) => (c.heat > ICE_THAW && c.waterNeighbours >= 5 ? 1 : 0),
  },
  {
    // The ice sheet's DEPOSITION edge, and the single fix that turned the 60-game-year
    // water trend from 24% -> 55% (linear, not converging) into a flat line. An ice
    // shelf pressed against a coast grounds, collects moraine and outwash, and becomes
    // land. Without it, every tile the sea took in the cold band was taken for good:
    // measured 616 land->sea transitions against 29 the other way, a 21:1 ratchet.
    //
    // Deliberately requires real land contact (>= 3 land neighbours) so it only fires
    // at the shelf's landward margin, never in the middle of a frozen ocean.
    from: Biome.FrozenSea, to: Biome.Tundra, medianDays: 40, label: 'the ice grounds ashore',
    when: (c) => (landNeighbours(c) >= 3 ? landNeighbours(c) - 2 : 0),
  },
  {
    // Grounded ice shelf: sea ice becomes LAND ice only deep inside a bay and only
    // in extreme cold. Deliberately narrow and slow — this is the one deposition
    // path under the ice that produces glacier rather than tundra.
    from: Biome.FrozenSea, to: Biome.Glacier, medianDays: 300, label: 'the shelf grounds',
    when: (c) => (c.heat < GLACIAL && landNeighbours(c) >= 4 ? 1 : 0),
  },

  // =========================================================================
  // WETLANDS
  // =========================================================================
  {
    from: Biome.Marsh, to: Biome.Swamp, medianDays: 10, label: 'the wetland warms',
    when: (c) => (c.heat > 60 ? 1 : 0),
  },
  {
    from: Biome.Swamp, to: Biome.Marsh, medianDays: 10, label: 'the wetland cools',
    when: (c) => (c.heat < 56 ? 1 : 0),
  },
  {
    from: Biome.Marsh, to: Biome.Grassland, medianDays: 9, label: 'wetland dries',
    when: (c) => (c.waterNeighbours <= 1 && c.moisture < WET ? dryingBoost(c) : 0),
  },
  {
    from: Biome.Swamp, to: Biome.Grassland, medianDays: 10, label: 'swamp dries out',
    when: (c) => (c.waterNeighbours <= 1 && c.moisture < MOIST ? 1 : 0),
  },
  {
    // The hot-wet half of "ocean + forest -> rainforest": a swamp that stops being
    // standing water but keeps the humidity closes over into canopy.
    from: Biome.Swamp, to: Biome.Rainforest, medianDays: 14, label: 'canopy closes over',
    when: (c) => (c.moisture > WET && c.heat > 56 && c.heat < 82 && c.waterNeighbours <= 2 ? 1 : 0),
  },

  // =========================================================================
  // THE VEGETATED FAMILY
  //
  // Grassland is the living hub: the widest envelope in the set, and the one cheap
  // door into life for soil, ash, desert, tundra, savanna and barren alike.
  // =========================================================================
  {
    from: Biome.Grassland, to: Biome.Forest, medianDays: 12, label: 'trees take root',
    when: (c) => (c.moisture > MOIST && c.heat > COLD && c.heat < WARM ? 1 : 0),
  },
  {
    // The second rung of the drying ladder. Grassland does NOT flip straight to
    // desert any more: a purge scar recovers through savanna, and the equatorial
    // belt gets a habitable band instead of a hard grass/sand edge.
    from: Biome.Grassland, to: Biome.Savanna, medianDays: 12, label: 'grass turns to scrub',
    when: (c) => (c.heat > WARM && c.moisture < 45 ? dryingBoost(c) : 0),
  },
  {
    from: Biome.Grassland, to: Biome.Barren, medianDays: 16, label: 'the sward fails',
    when: (c) => (c.moisture < ARID && c.heat <= WARM ? 1 : 0),
  },
  {
    // Wetlands need a path that does not depend on the thin shallows ribbon, or
    // marsh only ever exists on the coast and reed/peat/clay leave the economy.
    from: Biome.Grassland, to: Biome.Marsh, medianDays: 16, label: 'ground waterlogs',
    when: (c) =>
      c.moisture > WET && c.heat < WARM && (c.waterNeighbours >= 2 || c.moisture > 92)
        ? wettingBoost(c)
        : 0,
  },
  {
    from: Biome.Savanna, to: Biome.Grassland, medianDays: 12, label: 'the rains return',
    when: (c) => (c.moisture > 45 ? wettingBoost(c) + 0.5 * livingNeighbours(c) : 0),
  },
  {
    from: Biome.Savanna, to: Biome.Desert, medianDays: 14, label: 'the scrub burns off',
    when: (c) => (c.heat > WARM && c.moisture < ARID ? dryingBoost(c) : 0),
  },
  {
    from: Biome.Forest, to: Biome.Grassland, medianDays: 7, label: 'canopy thins',
    when: (c) => (c.heat > WARM && c.moisture < DRY ? dryingBoost(c) : 0),
  },
  {
    // "ocean + forest -> swamp", literally: forest standing in water, in heat.
    from: Biome.Forest, to: Biome.Swamp, medianDays: 12, label: 'the wood floods',
    when: (c) => (c.heat > 56 && c.moisture > WET && wetNeighbours(c) >= 2 ? 1 : 0),
  },
  {
    // "ocean + forest -> rainforest": the hot-wet extreme, and it needs open water
    // or a wetland adjacent, so it lands on tropical coasts, not whole continents.
    from: Biome.Forest, to: Biome.Rainforest, medianDays: 12, label: 'the canopy deepens',
    when: (c) => (c.heat > 56 && c.heat < 82 && c.moisture > WET && wetNeighbours(c) >= 1 ? 1 : 0),
  },
  {
    from: Biome.Rainforest, to: Biome.Forest, medianDays: 8, label: 'the canopy opens',
    when: (c) => (c.heat < 52 || c.heat > 86 || c.moisture < MOIST ? 1 : 0),
  },
  {
    from: Biome.Rainforest, to: Biome.Swamp, medianDays: 12, label: 'the floor floods',
    when: (c) => (c.waterNeighbours >= 2 && c.moisture > SOAKED ? 1 : 0),
  },

  // -- Bloom: the narrowest envelope in the set, by design ---------------------
  // The prototype settled it at 0.2-0.5% of the world with no special-casing, and
  // that scarcity is the point. Do NOT widen this niche to make it show up more.
  {
    from: Biome.Forest, to: Biome.Bloom, medianDays: 18, label: 'the bloom comes',
    when: (c) => (blooming(c) ? 1 : 0),
  },
  {
    from: Biome.Rainforest, to: Biome.Bloom, medianDays: 22, label: 'the bloom comes',
    when: (c) => (blooming(c) ? 1 : 0),
  },
  {
    from: Biome.Bloom, to: Biome.Forest, medianDays: 5, label: 'bloom fades',
    when: (c) => (blooming(c) ? 0 : 1),
  },
  {
    // Senescence. Bloom is a FLOW, like fertile soil — not a stock that a region
    // accumulates and sits on. Without this the envelope alone left it at 1.4-2.5%
    // of a wet world, five times what the prototype found and enough to stop it
    // feeling like something you cross a world for. A bloom is an event.
    from: Biome.Bloom, to: Biome.Forest, medianDays: 30, label: 'the bloom passes',
    when: () => 1,
  },
  {
    from: Biome.Bloom, to: Biome.Rainforest, medianDays: 8, label: 'the bloom is overgrown',
    when: (c) => (c.heat > 64 && c.moisture > SOAKED ? 1 : 0),
  },

  // =========================================================================
  // THE COLD BAND
  // =========================================================================
  ...fanOut(FREEZABLE, {
    to: Biome.Tundra, medianDays: 6, label: 'frost sets in',
    when: (c) => (c.heat < freezePoint(c) ? (has(c, CycleFlag.Freeze) ? 2 : 1) : 0),
  }),
  {
    from: Biome.Tundra, to: Biome.Grassland, medianDays: 8, label: 'thaw',
    when: (c) => (c.heat > COLD && c.moisture > ARID ? 1 : 0),
  },
  {
    from: Biome.Tundra, to: Biome.Rock, medianDays: 60, label: 'scoured bare',
    when: (c) => (c.heat < FROZEN && c.moisture < DRY ? (has(c, CycleFlag.Freeze) ? 3 : 1) : 0),
  },
  {
    from: Biome.Tundra, to: Biome.Glacier, medianDays: 30, label: 'the ice thickens',
    when: (c) =>
      c.heat < GLACIAL && c.moisture > 45 && coldNeighbours(c) >= 3
        ? (has(c, CycleFlag.Freeze) ? 3 : 1)
        : 0,
  },
  {
    // Glacier retreat thresholds sit ABOVE the formation threshold (GLACIAL = 18) by
    // a real margin, and glacier carries NO self-heat. That combination is deliberate.
    // Review found glacier permanently latched because it formed below 18 and then
    // read <= 10 through its own -8 self-offset, so the reversal condition could not
    // be met by any climate the world produced — 1.67% of a garden world was
    // immutable ice. Hysteresis belongs in the thresholds, never in the biome's own
    // heat term, because a self-offset moves the tile away from its exit rather than
    // merely delaying it.
    from: Biome.Glacier, to: Biome.Tundra, medianDays: 14, label: 'the ice retreats',
    when: (c) => (c.heat > GLACIAL + 4 && c.moisture >= 55 ? 1 : 0),
  },
  {
    // Glacial retreat is the non-volcanic way to manufacture fresh bedrock. It is
    // why the cold band feeds the stone economy instead of only consuming it.
    from: Biome.Glacier, to: Biome.Rock, medianDays: 20, label: 'retreat exposes bedrock',
    when: (c) => (c.heat > GLACIAL + 4 && c.moisture < 55 ? 1 : 0),
  },
  {
    // Calving needs melt. A glacier at -20 does not shed into the sea; one that is
    // warming does. Gating this on the retreat threshold rather than leaving it
    // unconditional in climate removed 72% of the cold band's land -> sea flux, which
    // was the other half of the water ratchet.
    from: Biome.Glacier, to: Biome.Shallows, medianDays: 25, label: 'the glacier calves',
    when: (c) => (c.waterNeighbours >= 3 && c.heat > GLACIAL ? 1 : 0),
  },

  // =========================================================================
  // ARID: sand accumulates, stone strips
  // =========================================================================
  {
    from: Biome.Desert, to: Biome.Savanna, medianDays: 14, label: 'scrub reclaims the sand',
    when: (c) =>
      c.moisture > 34 && c.heat > WARM ? wettingBoost(c) + livingNeighbours(c) : 0,
  },
  {
    from: Biome.Desert, to: Biome.Grassland, medianDays: 14, label: 'oasis spreads',
    when: (c) =>
      c.moisture > 34 && c.heat <= WARM ? wettingBoost(c) + livingNeighbours(c) : 0,
  },
  {
    from: Biome.Desert, to: Biome.Glass, medianDays: 45, label: 'sand vitrifies',
    when: (c) => (c.heat > SCORCHING && c.moisture < ARID ? (c.heat > VITRIFY ? 6 : 1) : 0),
  },
  {
    from: Biome.Desert, to: Biome.Barren, medianDays: 20, label: 'the cold desert rubbles',
    when: (c) => (c.heat < COLD ? (has(c, CycleFlag.Freeze) ? 3 : 1) : 0),
  },
  {
    // Badlands is the EROSION product of stone under drought, where desert is the
    // ACCUMULATION product of sand. That is the whole distinction, and it is what
    // finally gives rock and mountain a dry decay path that is not barren.
    from: Biome.Rock, to: Biome.Badlands, medianDays: 55, label: 'the stone gullies',
    when: (c) =>
      c.moisture < 30 && c.heat > 40 && c.heat < 95 && stoneNeighbours(c) >= 1
        ? (has(c, CycleFlag.Storm | CycleFlag.Drought) ? 4 : 1)
        : 0,
  },
  {
    from: Biome.Mountain, to: Biome.Badlands, medianDays: 90, label: 'the slopes strip',
    when: (c) =>
      c.moisture < 30 && stoneNeighbours(c) >= 1
        ? (has(c, CycleFlag.Storm | CycleFlag.Drought) ? 4 : 1)
        : 0,
  },
  {
    from: Biome.Basalt, to: Biome.Badlands, medianDays: 110, label: 'the flow gullies',
    when: (c) =>
      c.moisture < 30 && c.heat > 40
        ? (has(c, CycleFlag.Storm | CycleFlag.Drought) ? 4 : 1)
        : 0,
  },
  {
    from: Biome.Badlands, to: Biome.Desert, medianDays: 30, label: 'sheds sand',
    when: (c) => (c.moisture < ARID && c.heat > WARM ? 1 + 0.5 * c.neighbourCounts[Biome.Desert]! : 0),
  },
  {
    from: Biome.Badlands, to: Biome.Barren, medianDays: 25, label: 'the gullies fill',
    when: (c) => (c.moisture > ARID ? 1 : 0),
  },

  // =========================================================================
  // STONE
  // =========================================================================
  {
    from: Biome.Mountain, to: Biome.Rock, medianDays: 500, label: 'the mountain erodes',
    when: (c) => (c.moisture > ARID ? 1 : 0.4),
  },
  {
    from: Biome.Rock, to: Biome.Barren, medianDays: 70, label: 'rock weathers',
    when: (c) => (c.moisture > ARID ? 1 : 0),
  },
  {
    from: Biome.Basalt, to: Biome.Rock, medianDays: 120, label: 'basalt weathers',
    when: (c) => (c.moisture > ARID ? 1 : 0),
  },
  {
    // The slow half of the volcanic gift. Basalt is the stable end of the chain,
    // but wet basalt does eventually rot into farmland — which is why an old
    // volcanic province is the richest ground on a world.
    from: Biome.Basalt, to: Biome.Soil, medianDays: 200, label: 'basalt rots to loam',
    when: (c) => (c.moisture > 45 && c.heat > COLD && c.heat < SCORCHING ? 1 : 0),
  },

  // =========================================================================
  // TRANSIENTS: ash, glass, soil
  // =========================================================================
  {
    from: Biome.Ash, to: Biome.Soil, medianDays: 5, label: 'ash enriches the ground',
    when: (c) => (c.moisture > 38 ? 1 : 0),
  },
  {
    from: Biome.Ash, to: Biome.Barren, medianDays: 4, label: 'ash settles',
    when: () => 1,
  },
  {
    // Glass has THREE exits now, which is exactly what converts it from a graveyard
    // into an intermediate: shattered by a quake (above), dissolved by standing
    // water, or weathered down the slow way. The dry-side pressure of 0.4 is what
    // keeps a beam-scoured belt glassy for a good while without making it permanent.
    from: Biome.Glass, to: Biome.Desert, medianDays: 90, label: 'water dissolves the glass',
    when: (c) => (c.moisture > 45 ? wettingBoost(c) : 0),
  },
  {
    from: Biome.Glass, to: Biome.Barren, medianDays: 30, label: 'glass weathers',
    when: (c) => (c.moisture > ARID ? 1 : 0.4),
  },
  {
    // Soil is a FLOW, not a stock: weeks to grassland, not long after to forest.
    // That is precisely why volcanism raises churn rather than just adding a colour.
    from: Biome.Soil, to: Biome.Grassland, medianDays: 10, label: 'green takes hold',
    when: (c) =>
      c.moisture > 30 && c.heat > 35 && c.heat < SCORCHING ? 1 + 0.5 * livingNeighbours(c) : 0,
  },
  {
    from: Biome.Soil, to: Biome.Forest, medianDays: 18, label: 'the wood springs up',
    when: (c) => (c.moisture > MOIST && c.heat > COLD && c.heat < WARM ? 1 + livingNeighbours(c) : 0),
  },
  {
    from: Biome.Soil, to: Biome.Barren, medianDays: 12, label: 'the loam blows away',
    when: (c) => (c.moisture < 30 && c.heat <= SCORCHING ? dryingBoost(c) : 0),
  },
  {
    from: Biome.Soil, to: Biome.Desert, medianDays: 14, label: 'baked before anything rooted',
    when: (c) => (c.moisture < ARID && c.heat > SCORCHING ? 1 : 0),
  },

  // =========================================================================
  // BARREN — the rubble hub
  //
  // The single most important node in the graph for strong connectivity: nearly
  // everything degrades through it and life reclaims out of it. But it must never
  // be comfortable, or it dominates the map.
  // =========================================================================
  {
    from: Biome.Barren, to: Biome.Grassland, medianDays: 9, label: 'soil recovers',
    when: (c) =>
      c.moisture > 32 && c.heat > COLD && c.heat < SCORCHING ? 1 + livingNeighbours(c) : 0,
  },
  {
    from: Biome.Barren, to: Biome.Savanna, medianDays: 12, label: 'scrub takes the rubble',
    when: (c) =>
      c.moisture > 22 && c.moisture <= 45 && c.heat >= WARM && c.heat < 95
        ? 1 + livingNeighbours(c)
        : 0,
  },
  {
    from: Biome.Barren, to: Biome.Marsh, medianDays: 10, label: 'water pools',
    when: (c) =>
      c.waterNeighbours >= 3 && c.moisture > MOIST && c.heat < 58 ? wettingBoost(c) : 0,
  },
  {
    from: Biome.Barren, to: Biome.Swamp, medianDays: 12, label: 'water pools',
    when: (c) =>
      c.waterNeighbours >= 3 && c.moisture > MOIST && c.heat >= 58 ? wettingBoost(c) : 0,
  },
  {
    from: Biome.Barren, to: Biome.Desert, medianDays: 26, label: 'sand covers it',
    when: (c) =>
      c.heat > SCORCHING && c.moisture < ARID ? 1 + 0.5 * c.neighbourCounts[Biome.Desert]! : 0,
  },
];

/**
 * The ruleset the simulation runs, each rule carrying its derived identity.
 *
 * Attaching the key here rather than at the call site means there is exactly one place
 * a rule's dice can come from, and it is not reachable from the hot loop — `evaluateTile`
 * reads `rule.keyHash` off an object built once at module load. See `ruleKey`.
 */
export const RULES: readonly Rule[] = RULE_DEFS.map((r) => {
  const key = ruleKey(r);
  return { ...r, key, keyHash: hashString(key) };
});

/**
 * Derived-vs-hand-written edge overlaps that are DELIBERATE.
 *
 * `invariants.ts` fails on any fan-out that hands a biome a second copy of an edge it
 * already carries by hand, because that is a silent rate change — it is how marsh
 * ended up eroding ~26% per day faster than the coastline the prototype validated.
 * The three below are real, distinct physical processes that happen to land on the
 * same pair of nodes, and their combined rate is the intended one:
 *
 *   rock/glass/badlands -> barren  by SURF (`the sea undercuts it`, waterNeighbours>=4)
 *                          and     by WEATHER (rain and frost, climate-gated)
 *
 * A coastal outcrop is worked on by both at once and should wear away faster than an
 * inland one. Listing them here rather than suppressing the check keeps the property
 * that every overlap in this file has been looked at by a person at least once.
 */
export const ACKNOWLEDGED_EDGE_OVERLAPS: readonly string[] = [
  `${Biome.Rock}>${Biome.Barren}`,
  `${Biome.Glass}>${Biome.Barren}`,
  `${Biome.Badlands}>${Biome.Barren}`,
];

/** Rules bucketed by source biome, so evaluation only considers what can apply. */
export const RULES_BY_BIOME: readonly (readonly Rule[])[] = (() => {
  const buckets: Rule[][] = Array.from({ length: BIOME_COUNT }, () => []);
  for (const rule of RULES) buckets[rule.from]!.push(rule);
  return buckets;
})();
