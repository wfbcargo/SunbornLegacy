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
  River: 22,
} as const;
export type Biome = (typeof Biome)[keyof typeof Biome];

export const BIOME_COUNT = 23;

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
  /**
   * Thermal mass, as the per-day relaxation rate toward this tile's OWN equilibrium:
   * `T += thermalAlpha * (H - T)`. LOW is heavy — deep water at 0.023 is a ~43-day time
   * constant, dry sand at 0.60 settles in two days.
   *
   * ★ THE WATER/LAND RATIO IS THE MEASURED ANCHOR, NOT THE INDIVIDUAL NUMBERS. 0.023
   * against a land mean near 0.4 is the ~20× that puts the sea's seasonal peak ~37 days
   * behind the land's at ~80% of its amplitude, and that lag is the anomaly the coastline
   * reads as a maritime climate. Retuning one land biome is cheap; collapsing the ratio
   * deletes the feature.
   *
   * ★ AND IT IS BOUNDED WITH `THERMAL_KAPPA`. The explicit scheme in `world.ts` needs
   * `thermalAlpha + THERMAL_KAPPA <= 1` for EVERY biome or it oscillates and then
   * diverges, and `world.ts` throws at module evaluation if any row breaks it. Raising a
   * value here is therefore a change to the diffusion budget, not a local edit.
   */
  readonly thermalAlpha: number;
  /** What a region of this biome can export. The economy's supply side. */
  readonly materials: readonly string[];
}

export const BIOMES: readonly BiomeDef[] = [
  { id: Biome.Ocean,      key: 'ocean',      name: 'Deep Ocean',   glyph: '~', colour: 19,  water: true,  molten: false, moistureSource: 100, vegetated: false, stone: false, selfHeat: 0, thermalAlpha: 0.023, materials: ['brine', 'kelp', 'deepfish'] },
  { id: Biome.Shallows,   key: 'shallows',   name: 'Shallows',     glyph: '-', colour: 45,  water: true,  molten: false, moistureSource: 100, vegetated: false, stone: false, selfHeat: 0, thermalAlpha: 0.023, materials: ['coral', 'pearl', 'seasalt'] },
  { id: Biome.FrozenSea,  key: 'frozensea',  name: 'Frozen Sea',   glyph: '_', colour: 117, water: true,  molten: false, moistureSource: 55,  vegetated: false, stone: false, selfHeat: 0, thermalAlpha: 0.023, materials: ['packice', 'krilloil', 'coldlight'] },
  { id: Biome.Marsh,      key: 'marsh',      name: 'Cool Marsh',   glyph: '%', colour: 65,  water: false, molten: false, moistureSource: 0,   vegetated: true,  stone: false, selfHeat: 0, thermalAlpha: 0.30,  materials: ['reed', 'peat', 'clay'] },
  { id: Biome.Swamp,      key: 'swamp',      name: 'Warm Swamp',   glyph: '&', colour: 58,  water: false, molten: false, moistureSource: 0,   vegetated: true,  stone: false, selfHeat: 0, thermalAlpha: 0.30,  materials: ['mangrove', 'bogiron', 'lampcap'] },
  { id: Biome.Grassland,  key: 'grassland',  name: 'Grassland',    glyph: '"', colour: 149, water: false, molten: false, moistureSource: 0,   vegetated: true,  stone: false, selfHeat: 0, thermalAlpha: 0.40,  materials: ['grain', 'fiber', 'herb'] },
  { id: Biome.Savanna,    key: 'savanna',    name: 'Savanna',      glyph: ';', colour: 179, water: false, molten: false, moistureSource: 0,   vegetated: true,  stone: false, selfHeat: 0, thermalAlpha: 0.45,  materials: ['thatch', 'ochre', 'sunhide'] },
  { id: Biome.Forest,     key: 'forest',     name: 'Forest',       glyph: '#', colour: 28,  water: false, molten: false, moistureSource: 0,   vegetated: true,  stone: false, selfHeat: 0, thermalAlpha: 0.35,  materials: ['timber', 'resin', 'game'] },
  { id: Biome.Rainforest, key: 'rainforest', name: 'Rainforest',   glyph: '@', colour: 22,  water: false, molten: false, moistureSource: 0,   vegetated: true,  stone: false, selfHeat: 0, thermalAlpha: 0.35,  materials: ['ironwood', 'vinesilk', 'dewfruit'] },
  { id: Biome.Bloom,      key: 'bloom',      name: 'Bloom',        glyph: '*', colour: 213, water: false, molten: false, moistureSource: 0,   vegetated: true,  stone: false, selfHeat: 0, thermalAlpha: 0.40,  materials: ['sunpetal', 'nectar', 'essence', 'aureole'] },
  { id: Biome.Tundra,     key: 'tundra',     name: 'Tundra',       glyph: ':', colour: 152, water: false, molten: false, moistureSource: 0,   vegetated: true,  stone: false, selfHeat: 0, thermalAlpha: 0.40,  materials: ['frostmoss', 'rime', 'pelt'] },
  { id: Biome.Glacier,    key: 'glacier',    name: 'Glacier',      glyph: 'A', colour: 231, water: false, molten: false, moistureSource: 0,   vegetated: false, stone: false, selfHeat: 0, thermalAlpha: 0.15,  materials: ['blueice', 'meltwater', 'ivory'] },
  { id: Biome.Desert,     key: 'desert',     name: 'Desert',       glyph: '.', colour: 222, water: false, molten: false, moistureSource: 0,   vegetated: false, stone: false, selfHeat: 0, thermalAlpha: 0.60,  materials: ['sand', 'saltpeter', 'sunstone'] },
  { id: Biome.Badlands,   key: 'badlands',   name: 'Badlands',     glyph: 'v', colour: 166, water: false, molten: false, moistureSource: 0,   vegetated: false, stone: true,  selfHeat: 0, thermalAlpha: 0.30,  materials: ['shale', 'gypsum', 'fossilbone'] },
  { id: Biome.Mountain,   key: 'mountain',   name: 'Mountain',     glyph: '^', colour: 250, water: false, molten: false, moistureSource: 0,   vegetated: false, stone: true,  selfHeat: -18, thermalAlpha: 0.25,  materials: ['granite', 'silver', 'skyquartz'] },
  { id: Biome.Rock,       key: 'rock',       name: 'Rock',         glyph: 'n', colour: 245, water: false, molten: false, moistureSource: 0,   vegetated: false, stone: true,  selfHeat: 0, thermalAlpha: 0.25,  materials: ['iron', 'stone', 'copper'] },
  { id: Biome.Basalt,     key: 'basalt',     name: 'Basalt',       glyph: '0', colour: 235, water: false, molten: false, moistureSource: 0,   vegetated: false, stone: true,  selfHeat: 0, thermalAlpha: 0.28,  materials: ['blackstone', 'olivine', 'magnetite'] },
  { id: Biome.Lava,       key: 'lava',       name: 'Lava',         glyph: '!', colour: 196, water: true,  molten: true,  moistureSource: 0,   vegetated: false, stone: false, selfHeat: 25, thermalAlpha: 0.50,  materials: ['obsidian', 'sulfur', 'firesalt'] },
  { id: Biome.Ash,        key: 'ash',        name: 'Ash',          glyph: 'x', colour: 240, water: false, molten: false, moistureSource: 0,   vegetated: false, stone: false, selfHeat: 0, thermalAlpha: 0.60,  materials: ['potash', 'char', 'cinder'] },
  { id: Biome.Glass,      key: 'glass',      name: 'Glass',        glyph: '=', colour: 195, water: false, molten: false, moistureSource: 0,   vegetated: false, stone: true,  selfHeat: 0, thermalAlpha: 0.35,  materials: ['silica', 'glasslite', 'prism'] },
  { id: Biome.Soil,       key: 'soil',       name: 'Fertile Soil', glyph: '+', colour: 94,  water: false, molten: false, moistureSource: 0,   vegetated: false, stone: false, selfHeat: 0, thermalAlpha: 0.55,  materials: ['loam', 'humus', 'quickvine'] },
  { id: Biome.Barren,     key: 'barren',     name: 'Barren',       glyph: ',', colour: 101, water: false, molten: false, moistureSource: 0,   vegetated: false, stone: false, selfHeat: 0, thermalAlpha: 0.60,  materials: ['dust', 'gravel', 'scrap'] },
  // ★ `water: false` IS A SAFETY PROPERTY, NOT A CLASSIFICATION PREFERENCE. See decision
  // `0019`. A river read as sea drowns itself — a chain tile has two river neighbours, so
  // at any bend it reads `waterNeighbours >= 3` and its own mouth rule fires — and every
  // tile it loses becomes Shallows, which is a permanent land→sea ratchet. Measured
  // counterfactual, 1500 days on `crucible`: river standing share 1.14% → 0.00% (the biome
  // is annihilated) AND the water trend went from flat to +1.5 pp in four game-years.
  // `moistureSource` must stay 0 with it: `invariants.ts` fails a source that is not water,
  // so a half-done version is loud rather than silent.
  { id: Biome.River,      key: 'river',      name: 'River',        glyph: '/', colour: 39,  water: false, molten: false, moistureSource: 0,   vegetated: false, stone: false, selfHeat: 0, thermalAlpha: 0.15,  materials: ['silt', 'watercress', 'rivergold'] },
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
   * Six-bit mask of WHICH neighbour directions hold a River — bit `d` for direction `d`
   * of `hex.ts`'s neighbour ring.
   *
   * ★ THE MASK, NOT THE COUNT, AND THAT IS THE WHOLE OF FINDING 2. `neighbourCounts[River]`
   * already gives the count and the count is not enough: two river neighbours mean
   * "a pocket beside a channel" when they sit 60° apart and "a one-tile hole IN a channel"
   * when they do not, and those two want opposite answers. `hex.ts:14-33` walks the ring in
   * cyclic order (E, NE, NW, W, SW, SE) at BOTH row parities, so direction `d` and
   * `(d+1)%6` are geometrically adjacent and the distinction is exactly a bit-adjacency
   * test on this mask. See `CHANNEL_OK`.
   */
  readonly riverRing: number;
  /**
   * River neighbours strictly HIGHER than this tile — the downhill gate.
   *
   * ★ THE ONLY THING THAT BOUNDS RIVER GROWTH. Undirected, "extend into a neighbour" is a
   * branching process with mean offspring > 1: every tip forks three ways and nothing
   * removes a direction. Measured A/B at identical rates, 900 days on `crucible`: with this
   * gate 1.88% of the world in 193 components; without it 24.91% AND STILL CLIMBING in
   * 3189. With decay disabled to isolate growth, 1.30% against 32.63% and a longest
   * component of 1959 tiles. Elevation makes the process directed on a field bounded below,
   * so every filament terminates at a local minimum or at the sea. Decision `0018`.
   */
  readonly upstreamRiverNeighbours: number;
  /**
   * Neighbours strictly LOWER than this tile — how many ways water could leave it.
   *
   * Static worldgen geography, like `upstreamRiverNeighbours` and for the same reason: it
   * is read by the two nucleation rules, and a nucleation gate must not depend on anything
   * a river can change. 0 means a local minimum, which is a tile a channel can flow INTO
   * and never out of — a spring there is a permanent one-tile puddle, not a river.
   */
  readonly downhillNeighbours: number;
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

/**
 * Wetlands carry their own, gentler drowning rules; see invariant 3.
 *
 * ★ ONE LINE, TWO EFFECTS, AND BOTH ARE REQUIRED. This list feeds `DROWNABLE` AND
 * `SUBSIDABLE`, and River lands in both by predicate: it is `!water && !stone` and neither
 * glacier nor ash. Each would have handed it a derived edge that its hand-written
 * `the river widens its mouth` already covers, which is invariant 3's rate hazard exactly.
 * Adding it here is the same edit marsh and swamp already carry, for the same reason.
 */
const HAND_DROWNED: Biome[] = [Biome.Marsh, Biome.Swamp, Biome.River];

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

/**
 * Takes a frost. Living cover and unconsolidated ground; tundra IS the product.
 *
 * ★ RIVER IS DELIBERATELY OUTSIDE THIS SET AND THAT IS A HAZARD, NOT A CONVENIENCE. The
 * final clause needs `vegetated || Soil || Barren` and a river is none of them, so — unlike
 * every other trap in this file — the predicate does NOT pick the new biome up, and a polar
 * river would have had no cold exit at all. It is closed by a hand-written `the river
 * freezes over` instead of by widening the predicate, because freezing a channel is a
 * different rate from frosting a meadow (m6 here against m90 there) and folding it in would
 * have silently made rivers the fastest-freezing thing on the map.
 */
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

/**
 * Ground a channel can cut into — the river extension fan-out.
 *
 * `SUBSIDABLE` PLUS THE TWO WETLANDS. "Unconsolidated ground that water can move through"
 * is one physical property: a quake drops it below the waterline and a river cuts a bed in
 * it. Aliasing that set inherits the Glacier, Ash and River exclusions for free, and
 * consolidated stone is excluded by `!d.stone` — which is the right physics as well as the
 * right bookkeeping, since a channel that could cut bedrock would run along ridgelines.
 *
 * ★ BUT MARSH AND SWAMP HAVE TO BE ADDED BACK, AND LEAVING THEM OUT SILENTLY KILLS THE
 * HEALING RULE. They are excluded from `SUBSIDABLE` because they already drown by hand —
 * a reason that has nothing to do with rivers. Meanwhile marsh and swamp are exactly what a
 * river DECAYS INTO: `the channel silts up`, `the flow soaks away` and `the river warms to
 * swamp` are three of its five exits. So with the plain alias, every tile a river had just
 * lost was permanently un-rechannelable, and `the channel extends` — which is also the
 * gap-healing rule — could never close the hole it was written to close.
 *
 * MEASURED with the plain alias at 1500 days, 160×96: mean river-neighbour count 1.28–1.47
 * and 33–53% of components a single tile, against 1.56–1.92 and a few percent when healing
 * works. The chains were fragmenting exactly as the `exactly-one-river-neighbour` predicate
 * did before the discriminator, and for the same reason — nothing could re-close a gap.
 */
const CHANNELABLE: Biome[] = [...SUBSIDABLE, Biome.Marsh, Biome.Swamp];

/**
 * ★ THE GAP/POCKET DISCRIMINATOR — the six-bit river ring, resolved once at module load.
 *
 * Indexed by `TileContext.riverRing`; 1 where the pattern admits a new channel tile.
 *
 * THE RULE: admit iff there are ONE OR TWO river neighbours and they are not cyclically
 * adjacent on the ring.
 *
 *   - ONE neighbour → a tip. Admitted. This is ordinary extension, and it is also what
 *     makes the river branch: branching is not a second rule, it is this one firing on two
 *     different neighbours of the same tip.
 *   - TWO ADJACENT (60°) → a pocket BESIDE a straight channel. Refused. A tile alongside a
 *     chain always touches two consecutive chain tiles, so this is what widening looks like,
 *     and refusing it is where linearity comes from.
 *   - TWO NON-ADJACENT (120°/180°) → a one-tile hole IN a channel. Admitted, and this is
 *     the half that is easy to leave out. `exactly one river neighbour` alone gives chains,
 *     but a hole left by one decay event has TWO neighbours, so the chain can never re-close
 *     and both halves keep severing. Measured at 1500 days with the naive predicate: 534
 *     "rivers", mean length 1.9 tiles, 25.2% isolated singletons — while the SAME growth
 *     machinery with decay disabled produced 14 rivers of mean 32.2 and longest 131. Growth
 *     was never the problem. A river under `exactly-one` does not decay, it DISSOLVES.
 *   - THREE OR MORE → refused, whatever the arrangement.
 *
 * ★ THE POPCOUNT CAP IS NOT REDUNDANT WITH THE ADJACENCY TEST, AND LEAVING IT OUT BUILDS A
 * DENSE PHASE. "No two neighbours adjacent" alone also admits the 0°/120°/240° arrangement,
 * and on a hex grid that is a SUBLATTICE: there is a honeycomb pattern at 1/3 density in
 * which every tile has exactly three mutually non-adjacent river neighbours, so the
 * predicate admits every one of its own cells and the phase is a stable fixed point. It is
 * not hypothetical — it is what the rule actually did. MEASURED on the largest `garden`
 * component at 1500 days with the cap removed: 106 tiles whose river-neighbour histogram was
 * 1:15, 2:50, **3:41**, mean 2.25, rendered as a braided honeycomb filling a region rather
 * than a channel crossing one. Widening was supposed to be what this table prevented.
 *
 * The cost is exact and small: a hole at a genuine three-way confluence no longer heals.
 * Two-way holes are the overwhelmingly common case and still do.
 *
 * ★ FOUR OR MORE WAS ALREADY REFUSED BY THE ADJACENCY TEST ALONE. The largest independent
 * set on a 6-cycle is 3, so any 4 bits necessarily contain an adjacent pair — which is why
 * the measured share of river tiles with 4+ river neighbours is 0.0% in every configuration.
 * That part is a property of the predicate, not a rate that happened to come out small.
 *
 * 64 bytes, one indexed load in the hot loop. Decision `0020`.
 */
const CHANNEL_OK: Uint8Array = (() => {
  const table = new Uint8Array(64);
  for (let mask = 0; mask < 64; mask++) {
    let count = 0;
    let adjacent = false;
    for (let d = 0; d < 6; d++) {
      if ((mask & (1 << d)) === 0) continue;
      count++;
      if ((mask & (1 << ((d + 1) % 6))) !== 0) adjacent = true;
    }
    table[mask] = count >= 1 && count <= 2 && !adjacent ? 1 : 0;
  }
  return table;
})();

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

/**
 * Drying pressure: the season, the wind over the tile, and the shade above it.
 *
 * Three independent factors multiplied, because they are three independent things and a
 * gale in a drought under clear sky really is drier than any of them alone. Seasons
 * already move heat and moisture directly; this is emphasis on top of that.
 *
 * ★ WIND'S ONLY CHANNEL INTO THE RULESET IS HERE, AND THAT IS DELIBERATE. A wind term on
 * heat would be a whole new climate channel — a large, spatially broad, neighbour-blind
 * heat offset — and this ruleset has been sterilised once by exactly that shape. Drying
 * is what wind does that a rule can read: it abrades cover and takes water off the
 * ground, and every rule this scales is land→land, so the wind cannot touch the water
 * budget even indirectly through a coastline rule.
 *
 * ★ CLOUD'S ONLY CHANNEL IS THE SAME ONE, INVERTED. Shade slows drying; it does not
 * cause anything. A suppressor cannot latch — cloud does not manufacture cloud, and the
 * storm that carries it classifies itself on geography, never on the moisture it left
 * behind.
 */
const dryingBoost = (c: TileContext): number => {
  const season = has(c, CycleFlag.Heatwave | CycleFlag.Drought) ? 2 : 1;
  const wind = has(c, CycleFlag.HeavyWind) ? 1.5 : has(c, CycleFlag.Wind) ? 1.25 : 1;
  const shade = has(c, CycleFlag.HeavyCloud) ? 0.5 : has(c, CycleFlag.Cloud) ? 0.75 : 1;
  return season * wind * shade;
};

/**
 * Wetting pressure: monsoon fronts, the wet season, a plume's grit rain — and now a
 * storm's rain.
 *
 * A downpour raises `Storm` as well as `HeavyRain`, so it lands on the 3 that the wet
 * season and the monsoon already use; plain rain is a smaller push at 2. Nothing had to
 * be re-gated for the first of those, which is the point of having heavy rain raise the
 * flag the ruleset already had a word for.
 */
const wettingBoost = (c: TileContext): number =>
  has(c, CycleFlag.Storm) ? 3 : has(c, CycleFlag.Rain) ? 2 : 1;

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

/**
 * Standing water OR wetland — what "ocean + forest" actually touches.
 *
 * ★ RIVER BELONGS HERE AND NOT IN `waterNeighbours`, AND THE TWO ARE NOT THE SAME QUESTION.
 * `waterNeighbours` is the COASTLINE — it drives drowning, deposition, evaporation and
 * subsidence, and a river in it is a land→sea ratchet with a river-shaped fuse (decision
 * `0019`). This is a WETNESS reading, used only by land→land rules, so a valley floor beside
 * a river being humid enough to close a canopy costs the water budget exactly nothing.
 */
function wetNeighbours(c: TileContext): number {
  return (
    c.waterNeighbours + c.neighbourCounts[Biome.Swamp]! + c.neighbourCounts[Biome.Marsh]! +
    c.neighbourCounts[Biome.River]!
  );
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
  // He remakes; he does not annihilate. The beam boils water back from the edges.
  //
  // ★ "DEEP OCEAN SURVIVES A PURGE" WAS THE RULE HERE AND IS NOW NARROWER — the two
  // rules below still cannot touch open water, and the CORE can (see `the core boils it
  // dry`). The superseded reasoning, kept because it names a real failure mode: *if deep
  // water can be destroyed, every purge permanently removes the world's moisture source
  // and the map ends as glass.* That holds for any rule that destroys water PERMANENTLY.
  // What makes the core's rule survivable is the return path, not a smaller number, and
  // it is measured rather than argued — decision `0027`.
  {
    from: Biome.Ocean, to: Biome.Shallows, medianDays: 10, label: 'the sea boils back',
    when: (c) => (has(c, CycleFlag.Beam) && c.waterNeighbours <= 4 ? 1 : 0),
  },
  {
    from: Biome.Shallows, to: Biome.Barren, medianDays: 5, label: 'seabed bared',
    when: (c) => (has(c, CycleFlag.Beam) && c.waterNeighbours <= 2 ? 1 : 0),
  },

  // -- THE CORE: open water boils, and the gate is `Focus`, never heat --------
  //
  // These two sit AFTER the pair above deliberately. First rule to fire wins, so where
  // an edge rule already applies it keeps applying at the rate it was validated at;
  // these only reach the water that had no beam-driven exit at all. Measured on the
  // current tree, 240×144 over 240 days: of the water the core lights, **93% has all six
  // neighbours water on `anvil` and 85% on `crucible`** — that is what had no exit.
  //
  // ★ WHY THE GATE IS `Focus` AND NOT A TEMPERATURE. Not for want of heat: the same run
  // reads a mean of **148.3** under the core with a hottest of **181.5**, against
  // SCORCHING 78 / VITRIFY 110 / MOLTEN 120. The water is already far past the point
  // where ROCK melts. Heat is not what is missing, and adding a heat gate would be
  // actively unsafe: `world.ts` gives every open-water neighbour −3.0 heat, so
  // converting one sea tile to land adds **+4.2** to each remaining adjacent sea tile.
  // A heat-gated evaporation rule MANUFACTURES ITS OWN NEXT TRIGGER, with measured gain
  // above one — halving `garden`'s sea produced ~3.5× more above-threshold exposure per
  // remaining sea tile, which is why spec `2915cb06-3` gated `the shallows bake dry` on
  // geometry instead. `Focus` closes that loop by construction: boiling water still
  // raises the neighbours' heat, but heat is not the trigger, so **no new trigger is
  // created**. It is the same trick `melting()` uses one section down, for the same
  // reason, and it is the whole safety argument. If a reviewer cannot see the flag in
  // the `when`, this comment is wrong.
  //
  // ★ `waterNeighbours >= 4` IS THE RECLAIMABILITY CONDITION, AND IT RUNS THE OPPOSITE
  // WAY TO EVERY GATE ABOVE. `the sea boils back` and `seabed bared` ask how ENCLOSED a
  // tile is (`<= 4`, `<= 2`); this asks that it still be mostly SURROUNDED BY WATER, which
  // is exactly what `sea takes it` needs to take it back (`>= 4`, median 14 at pressure 3
  // here). Open ocean is 6 and sails through, so the requested behaviour is untouched.
  // What it forbids is a patch thick enough to have an INTERIOR: tiles inside a boiled
  // blob fall below 4 and stop boiling, so the scar stays thin and every tile in it is
  // reachable by the sea from the day it was made.
  //
  // ★ ★ THE MEDIAN IS THE BUDGET. THE RETURN PATH IS NOT. This is the finding of spec
  // `a966588d` Part B and it contradicts what that spec was written expecting, so read it
  // before shortening this number. Measured over 60 game-years at 120×72, this edge's
  // contribution against the pre-Part-B trend:
  //
  //     median  3   crucible -0.29   anvil -0.18       <- drains the ocean to 9.7%
  //     median  8   crucible -0.13   anvil -0.08
  //     median 20   crucible -0.02   anvil -0.06       <- what runs
  //
  // A dedicated fast reclaim edge (`desert -> shallows`, median 2 at `wn >= 5`) was built
  // and measured, and it moved `crucible` at median 3 only from -0.31 to -0.28. The reason
  // is one line away: `sand to glass` fires at MEDIAN 1 under the same beam, so a boiled
  // tile is STONE within a day, and stone comes back through `the sea undercuts it` at
  // median 26 rather than 14 — with further exits into lava and basalt. **No product
  // choice avoids that chain while the beam is still overhead.** So a fraction of every
  // conversion leaks into permanent land whatever the geometry, which is exactly what
  // `SIMULATION.md` already said: every new water<->land edge is a pure ratchet whose
  // full magnitude accumulates linearly.
  //
  // ★ WHAT THIS COSTS AND WHAT IT BUYS. At median 20 the core converts ~3% of the water
  // it lights, so the ocean does NOT visibly boil — the requested image is not delivered,
  // deliberately, and the tradeoff table above is why. What it does buy is the thing
  // invariant 8 had been exempting since the beginning: deep-ocean interiors finally have
  // a live out-rule. `anvil`'s no-exit share falls **14.51% -> 8.61%** and `crucible`'s
  // **5.87% -> 4.43%**. Decision `0027`.
  //
  // Authored by hand on the two true-water biomes, not fanned out: frozen sea already
  // has `ice sheet melts out`, and lava is `water` for flow's purposes only.
  {
    from: Biome.Ocean, to: Biome.Desert, medianDays: 20, label: 'the core boils it dry',
    when: (c) => (has(c, CycleFlag.Focus) && c.waterNeighbours >= 4 ? 1 : 0),
  },
  {
    from: Biome.Shallows, to: Biome.Desert, medianDays: 20, label: 'the core boils it dry',
    when: (c) => (has(c, CycleFlag.Focus) && c.waterNeighbours >= 4 ? 1 : 0),
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
  {
    // ★ THE WATER SIDE OF THE SAME CONTACT, and the first water<->lava traffic in this
    // ruleset in either direction. `quenched to glass` above hardens the LAVA tile; a
    // flow entering the sea also fills it, and until now the sea was simply untouched
    // by lava. Basalt, not glass: glass is what the lava tile itself becomes, and a
    // flow entering water leaves pillow basalt.
    //
    // ★ DO NOT WRITE THIS AS THE MIRROR OF `quenched to glass`. That rule uses
    // `pressure = waterNeighbours` at median 2, and the pressure term is safe there only
    // because the lava tile is leaving anyway — it has four exits and a ~30-day
    // unconditional backstop. The water side has no backstop, so a pressure term on it
    // is a pure ratchet against a sea with no restoring force. The epic's prior analysis
    // measured the symmetric version (median 2, `pressure = lavaNeighbours`) at 0.29 pp
    // of world per game-year on `anvil` with a 6.99 pp sea drain over 30 game-years; see
    // `.wiki/specs/2915cb06-3_water-chemistry.md` for those figures and their provenance.
    //
    // MEASURED AS SHIPPED, 60 game-years at 120x72: anvil 0.0270 pp/y, crucible 0.0191,
    // kiln 0.0033, garden and still exactly 0 (no route to lava at all). Against the
    // epic's 0.05 pp/y per-edge ceiling. `anvil` is the binding preset even though
    // `crucible` has more lava/water contact, because anvil's gross land->sea flux is
    // 0.134 pp/y against crucible's 0.782 — there is almost nothing to absorb the loss.
    // Re-measure new shapes on this contact against `anvil`.
    //
    // It also competes with `quenched to glass` for the same contacts. Measured
    // suppression 4.3-21.0% of quench firings, with standing lava unmoved at three
    // decimal places on every preset — lava's other three exits and its backstop absorb
    // it. See decision `0013`.
    from: Biome.Shallows, to: Biome.Basalt, medianDays: 20, label: 'the flow builds new land',
    when: (c) => (c.neighbourCounts[Biome.Lava]! >= 1 ? 1 : 0),
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
  // A quake does not carve a river here — it drops soft ground below the waterline and the
  // sea comes in. (This comment used to say rivers were an edge feature and therefore out of
  // reach of a `RuleDef`. That position is RETIRED: `Biome.River` is an area, spec
  // `2915cb06-5` ratified it, and the ground a quake can drop is the same ground a channel
  // can cut — which is why `CHANNELABLE` is literally `SUBSIDABLE`.) This is also the
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

  // -- WEATHER: storms that travel, morph and die -----------------------------
  // The `weather` cycle raises six flags and most of their effect arrives through
  // `dryingBoost` and `wettingBoost`, which scale rules that already existed. The
  // three below are the transitions weather is the SOLE cause of, and every one of
  // them is land → land: a storm cannot move the coastline, so the whole cycle
  // spends nothing from the epic's water budget except through the moisture it adds
  // to the diffusion target.
  //
  // Each is gated on a flag only `weather` can raise, so `sim:check`'s reachable-core
  // analysis stays honest — a preset with no weather does not get these edges counted
  // as live. (Spec 3's `shallows→basalt` carries no cycle flag and made the static
  // count slightly optimistic on quiet presets; this is the fix applied in advance.)
  {
    // Sand moves on the wind, and it moves toward sand: a rubble field downwind of a
    // dune belt gets covered. `sand covers it` is the same edge by a different
    // process — bare heat and aridity — and the two are meant to add.
    from: Biome.Barren, to: Biome.Desert, medianDays: 18, label: 'the wind drives the sand',
    when: (c) =>
      has(c, CycleFlag.Wind) && c.moisture < DRY && c.neighbourCounts[Biome.Desert]! >= 1
        ? 1 + 0.5 * c.neighbourCounts[Biome.Desert]!
        : 0,
  },
  {
    // A gale over dry scrub takes the cover off and leaves the rubble. This is the one
    // new EDGE weather adds to the graph — savanna had no route to barren before — and
    // it is what gives the drying ladder a fast rung that does not need a heatwave.
    from: Biome.Savanna, to: Biome.Barren, medianDays: 22, label: 'the gale strips the scrub',
    when: (c) => (has(c, CycleFlag.HeavyWind) && c.moisture < DRY ? 1 : 0),
  },
  {
    // Desert pavement: a cloudburst on loose sand does not green it, it guts it —
    // the fines wash out and what is left is gravel. Note this is the OPPOSITE of
    // `oasis spreads`, which needs sustained moisture rather than one violent day,
    // and the two compete for the same tiles exactly as they should.
    from: Biome.Desert, to: Biome.Barren, medianDays: 25, label: 'the cloudburst guts the dune',
    when: (c) => (has(c, CycleFlag.HeavyRain) && c.moisture > MOIST ? 1 : 0),
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
  {
    // Superheated water evaporates — GATED ON GEOMETRY, with heat only choosing the
    // product. The gate is `seabed bared`'s, one line above in spirit: a cut-off pool
    // with at most two water neighbours, baking. It dries to sand rather than to the
    // rubble `seabed bared` leaves, because this one is slow drying under a hot sky
    // rather than a purge boiling a seabed off in a week.
    //
    // ★ HEAT MUST NOT BE THE PRIMARY GATE, and this is the one place in the ruleset
    // where that is a hard rule rather than a preference. `world.ts` gives every open-
    // water neighbour -3.0 heat, so converting one water tile to land adds +3.0 to
    // every remaining adjacent sea tile — +4.2 if the product is desert, which carries
    // the albedo term. For scale, the albedo bug that sterilised a world was +2.5 per
    // neighbour and the ice term that latched one was -0.8. A heat-gated evaporation
    // edge is therefore a positive feedback whose loop gain is greater than one. The
    // epic's prior analysis measured that gain — halving a world's sea gave ~3.5x MORE
    // above-threshold exposure per REMAINING sea tile — and priced the naive version on
    // crucible at 0.7986 pp/y (`heat > 120`, median 5), with an all-sea variant draining
    // the ocean to 0.01% in five game-years. Those figures and their provenance are in
    // `.wiki/specs/2915cb06-3_water-chemistry.md`; they are 10-3000x this epic's budget.
    //
    // Geometry is the brake because it is SELF-LIMITING: removing an isolated water
    // tile does not manufacture more isolated water tiles, whereas removing a hot one
    // heats its neighbours.
    //
    // ★ THE `<= 2` IS NOT NEGOTIABLE, AND IT IS THE ONLY THING HOLDING THIS RULE DOWN.
    // Measured shallows population, tile-days per day at 120x72 over 10 game-years:
    // `wn <= 2` is 0.086-0.488, `wn <= 3` is 32.5-43.0. ONE NEIGHBOUR OF RELAXATION IS
    // 200-400x THE TARGET, because `wn == 3` is the ordinary coastal ribbon rather than
    // a cut-off pool. Measured cost of `wn <= 3` at this same median and heat gate:
    // 0.127 pp/y on `anvil` (sea 25.0% -> 19.8% over 60 game-years) against a 0.05
    // per-edge ceiling; at `heat >= 62` it is 0.211 and `anvil` reaches 14.8%. Heat and
    // median are nearly free inside `wn <= 2` and ruinous outside it.
    //
    // Median 8 rather than 20: measured 0.0199 pp/y on `crucible` (the worst preset)
    // against the 0.05 ceiling, where m20 gave 0.0098 and m3 gave 0.0473 — m3 is 95% of
    // the ceiling, so 8 is the largest round median with real margin. It also matches
    // the idiom: `seabed bared` is the sibling rule at this same geometry gate, at 5.
    //
    // Shallows only. An `Ocean` tile with <= 2 water neighbours has >= 4 land
    // neighbours and is already being filled by `bay silts up`; giving deep water a
    // direct route to desert would add a second, faster ratchet on the same tiles.
    from: Biome.Shallows, to: Biome.Desert, medianDays: 8, label: 'the shallows bake dry',
    when: (c) => (c.waterNeighbours <= 2 && c.heat >= SCORCHING ? 1 : 0),
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
  // RIVERS
  //
  // A river is an AREA — a valley one tile wide at minimum, not a stream drawn on the
  // edge between two tiles. Spec `2915cb06-5` ratified that after the alternative was
  // costed: an edge layer needs a parallel `Uint8Array(n*3)`, a second ruleset type, a
  // second `evaluateTile`, a second satisfiability probe and a second SCC checker — and it
  // still could not answer "a heated river becomes a swamp", because a swamp is an area.
  // A `Mountain` tile is already a range; a `River` tile is a river valley.
  //
  // ★ THE RATE STRUCTURE IS THE OPPOSITE OF `silt builds`, AND THAT IS WHY IT IS SAFE.
  // Growth pressure here scales with the number of TIPS (a tile needs exactly the right
  // ring pattern to be admitted) while decay scales with the number of TILES. `silt builds`
  // scaled its growth with the AREA of the growing phase, which is why relaxing one `>= 4`
  // to `>= 3` there drained every ocean on the map. Expected filament length is
  // `L* = 3·p_g/p_d`, which is O(1) in world size: a bigger world gets more rivers, not
  // longer ones.
  //
  // ★ SET ABUNDANCE WITH SPRING DENSITY, NEVER WITH THE SPREAD MEDIAN. Standing share is
  // nucleation × lifetime × length, and BOTH lifetime and length go as `1/p_d` — so share
  // goes as `1/p_d²` and a slow-decay configuration needs >3000 days even to equilibrate.
  // The two m12000 nucleation rules below are the linear, safe dial. The m6 spread median is
  // the hyperbolic one. Long trunk rivers cost quadratically more standing share.
  // =========================================================================

  // -- Nucleation: two springs, so a world does not need ice to have rivers ----
  // ★ NEITHER SPRING READS MOISTURE, AND THAT IS THIS EPIC'S OWN STANDING CONSTRAINT
  // APPLIED TO ITSELF: never gate a feedback on a quantity the feedback can create. A river
  // pushes `+2` into its neighbours' moisture diffusion target (`world.ts`), so a spring
  // gated on `moisture > SOAKED` is a river manufacturing its own nucleation sites.
  //
  // MEASURED with that gate in place, 160×96, `garden`, 50-day trailing means — the river
  // and the marsh it springs from climb TOGETHER while the sea stays flat, which is the
  // signature of an internal loop rather than a coastline problem:
  //
  //     day        500    1000    1500    2000    2500    3000    3500    4000
  //     river     2.30%   3.06%   5.82%   4.23%   5.01%   6.36%   6.23%   9.47%
  //     marsh     7.66%   7.28%  14.33%   5.80%  10.96%  12.12%   7.80%  13.63%
  //     sea      23.23%  23.52%  24.23%  24.20%  23.60%  23.67%  23.49%  23.37%
  //
  // Both gates below are now HEAT and GEOGRAPHY only. A river changes neither: it carries
  // `selfHeat: 0` and appears in no term of `heatAt`, and it cannot manufacture bedrock —
  // its five exits are swamp, marsh, barren, tundra and shallows, none of them stone. The
  // residual `river → marsh → river` path survives, but with the amplifier gone its gain is
  // ~0.002 river tiles per river tile, against the ~1.0 that would be a ratchet.
  {
    // Glacial meltwater, on the same `GLACIAL + 4` gate as `the ice retreats` — a river
    // starts where the ice is LEAVING, not where it is deepest. `riverRing === 0` keeps
    // this a nucleation rule rather than a second, uncontrolled growth rule: a spring rises
    // where there is no channel yet, and everything after that is `the channel extends`.
    from: Biome.Glacier, to: Biome.River, medianDays: 12000, label: 'meltwater cuts a channel',
    when: (c) =>
      c.heat > GLACIAL + 4 && c.riverRing === 0 && c.downhillNeighbours >= 2 ? 1 : 0,
  },
  {
    // The non-glacial spring: a valley head between bedrock outcrops, which is where a
    // water table actually daylights. Without it a world with no cold band — and `garden`
    // is very nearly one — would have no rivers at all, and the whole biome would be a
    // property of the polar preset rather than of the world.
    //
    // `>= 2` rather than `>= 1` is what makes this a valley HEAD rather than any wetland
    // that happens to touch a rock, and it is the clause that carries the geographic
    // scarcity the moisture test used to supply.
    from: Biome.Marsh, to: Biome.River, medianDays: 12000, label: 'a spring rises',
    when: (c) =>
      stoneNeighbours(c) >= 2 && c.riverRing === 0 && c.downhillNeighbours >= 2 ? 1 : 0,
  },

  // -- Extension: the chain, and the ONLY unbounded-looking rule in the file ---
  // Two gates, and neither is optional. `CHANNEL_OK` decides the SHAPE (a chain, not a
  // blob, and a hole that can heal) and `upstreamRiverNeighbours` decides the DIRECTION.
  // Removing the second turns this into an undirected branching process with mean
  // offspring above one: measured 24.91% of the world and still climbing, against 1.88%
  // with the gate in. See `TileContext.upstreamRiverNeighbours`.
  ...fanOut(CHANNELABLE, {
    to: Biome.River, medianDays: 6, label: 'the channel extends',
    when: (c) => (CHANNEL_OK[c.riverRing]! === 1 && c.upstreamRiverNeighbours >= 1 ? 1 : 0),
  }),

  // -- Exits ------------------------------------------------------------------
  {
    // ★ THE RULE THE SPEC WAS WRITTEN FOR: "rivers that are heated turn into swamps."
    // A heatwave doubles it, which is the one place the calendar reaches this family.
    from: Biome.River, to: Biome.Swamp, medianDays: 90, label: 'the river warms to swamp',
    when: (c) => (c.heat > 60 ? (has(c, CycleFlag.Heatwave) ? 2 : 1) : 0),
  },
  {
    from: Biome.River, to: Biome.Barren, medianDays: 90, label: 'the river runs dry',
    when: (c) => (c.moisture < DRY ? dryingBoost(c) : 0),
  },
  {
    // The cold exit, hand-written because `FREEZABLE`'s predicate does not reach a river —
    // see that set. m90 rather than the fan-out's m6: a channel carries latent heat and
    // does not skin over the way a meadow frosts.
    from: Biome.River, to: Biome.Tundra, medianDays: 90, label: 'the river freezes over',
    when: (c) => (c.heat < freezePoint(c) ? (has(c, CycleFlag.Freeze) ? 2 : 1) : 0),
  },
  {
    // The mouth widens. ★ THIS IS THE ONLY LAND→SEA EDGE THE WHOLE BIOME ADDS, so it is the
    // only line here that spends from the epic's water budget, and it deliberately carries
    // NO pressure term. `coast drowns` and `ground subsides` both scale on
    // `waterNeighbours` and can afford to because they sit inside a two-way membrane with
    // deposition on the other side; a river has no deposition edge at all, so a pressure
    // term on it would be a pure ratchet.
    //
    // ★ THE `>= 4` IS MEASURED, NOT CHOSEN FOR SYMMETRY, AND IT IS WHAT BRINGS THIS EDGE
    // INSIDE BUDGET. At `>= 3` and this same median the edge cost 0.0523 pp/y on `garden`,
    // 0.0791 on `kiln` and 0.0642 on `crucible` over 60 game-years at 120×72 — over the
    // epic's 0.05 pp/y per-edge ceiling on all three. `wn == 3` is the ordinary coastal
    // ribbon rather than a river mouth, which is the same thing `the shallows bake dry`
    // found one neighbour lower down. Geometry is the brake here for the reason it is
    // everywhere else on this coastline: removing a nearly-enclosed river tile does not
    // manufacture more nearly-enclosed river tiles.
    from: Biome.River, to: Biome.Shallows, medianDays: 20, label: 'the river widens its mouth',
    when: (c) => (c.waterNeighbours >= 4 ? 1 : 0),
  },
  {
    // ★ THE TEMPERATE DECAY TERM, AND LEAVING IT OUT IS A DESIGN DEFECT RATHER THAN A
    // MISSING FEATURE. It is the exact complement of `the river warms to swamp` above, so
    // the two never both apply and their combined rate is m90 rather than a doubled one —
    // the same construction `silt builds` / `mangrove takes hold` uses on the coastline.
    //
    // Without it a temperate river's ONLY exit was the m300 backstop below, which sets
    // `L* = 3·p_g/p_d = 3 × (ln2/6) / (ln2/300) = 150` tiles. MEASURED with that structure
    // at 160×96, river share by day, `crucible`: 1.29% (d400), 2.68 (d1200), 3.51 (d2000),
    // 5.00 (d3200), 5.51 (d4000) — climbing at day 4000, i.e. not an equilibrium at all.
    // `garden` did the same, 0.79 → 3.33. At m90 the ratio is 12 and `L*` is ~35, which is
    // what makes the standing share settle instead of accumulate.
    from: Biome.River, to: Biome.Marsh, medianDays: 90, label: 'the channel silts up',
    when: (c) => (c.heat <= 60 ? 1 : 0),
  },
  {
    // The unconditional backstop, and the same device lava's `crust hardens over` uses. It
    // is what makes River structurally escapable rather than escapable-if-the-climate-
    // cooperates: `invariants.ts` check 6 asks whether a biome can be left with NO cycle
    // flags raised at all, and a channel whose only exits were climate-gated would be a
    // trap on exactly the worlds that grew the most of it. Last in the bucket so the
    // climate-specific exits above get first refusal.
    //
    // A second hand-written `river → marsh` beside the one above, deliberately: they are
    // two different processes at two rates, exactly as `bloom → forest` carries both
    // `bloom fades` (m5) and `the bloom passes` (m30). Distinct labels mean distinct keys
    // and therefore distinct roll streams — see `ruleKey`.
    from: Biome.River, to: Biome.Marsh, medianDays: 300, label: 'the flow soaks away',
    when: () => 1,
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
    //
    // A gale joins the wet season and the dry season on this gate rather than getting
    // a rule of its own: the three badlands rules are ONE physical process — bare rock
    // being worked on by something violent — and adding a fourth parallel edge would
    // halve their carefully ordered medians rather than widen their causes.
    from: Biome.Rock, to: Biome.Badlands, medianDays: 55, label: 'the stone gullies',
    when: (c) =>
      c.moisture < 30 && c.heat > 40 && c.heat < 95 && stoneNeighbours(c) >= 1
        ? (has(c, CycleFlag.Storm | CycleFlag.Drought | CycleFlag.HeavyWind) ? 4 : 1)
        : 0,
  },
  {
    from: Biome.Mountain, to: Biome.Badlands, medianDays: 90, label: 'the slopes strip',
    when: (c) =>
      c.moisture < 30 && stoneNeighbours(c) >= 1
        ? (has(c, CycleFlag.Storm | CycleFlag.Drought | CycleFlag.HeavyWind) ? 4 : 1)
        : 0,
  },
  {
    from: Biome.Basalt, to: Biome.Badlands, medianDays: 110, label: 'the flow gullies',
    when: (c) =>
      c.moisture < 30 && c.heat > 40
        ? (has(c, CycleFlag.Storm | CycleFlag.Drought | CycleFlag.HeavyWind) ? 4 : 1)
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

// ---------------------------------------------------------------------------
// THE FLUX LEDGER — an exact per-rule firing counter, off by default.
//
// `sweep.ts` measures the sea as a STOCK, at decade marks. That is blind to gross
// flux by construction: two edges moving 5 pp/game-year in opposite directions net
// to zero and the stock never moves. This epic adds water<->land edges whose whole
// job is to be small, so "the sea share barely changed" is not evidence that a new
// edge is safe — it is exactly what an unsafe edge looks like next to a compensating
// one. The ledger is what turns "net drift" into "which rule did it".
//
// ★ WHY A GETTER AND NOT A COUNTER IN `evaluateTile`. The hot loop must not grow a
// branch it does not need, and more importantly the instrument must not be able to
// change the arithmetic it is measuring. `world.ts` reads `rule.to` at exactly one
// place and only after the roll has already been won, so a getter on `to` IS the
// firing count, with no test, no extra state read, and no way to perturb the dice.
// Verified: both golden hashes are unchanged with the ledger enabled.
// ---------------------------------------------------------------------------

/** Firings per rule since the last reset, indexed by position in `RULES`. */
export const RULE_FIRINGS = new Int32Array(RULES.length);

let ledgerEnabled = false;

/**
 * Install the counting getters. Idempotent, and deliberately one-way: a diagnostic
 * that can be turned off halfway through a run is a diagnostic that reports a number
 * nobody can reproduce.
 */
export function enableFluxLedger(): void {
  if (ledgerEnabled) return;
  ledgerEnabled = true;
  RULES.forEach((rule, i) => {
    const to = rule.to;
    Object.defineProperty(rule, 'to', {
      get(): Biome {
        RULE_FIRINGS[i] = RULE_FIRINGS[i]! + 1;
        return to;
      },
      configurable: true,
      enumerable: true,
    });
  });
}

/** Zero the counters. Call it after worldgen so the setup does not land in the window. */
export function resetFluxLedger(): void {
  RULE_FIRINGS.fill(0);
}

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
  // marsh -> river  by a SPRING (`a spring rises`, m12000, needs two stone neighbours and
  //                  somewhere to drain)
  //                 and by a CHANNEL reaching it (`the channel extends`, m6, needs an
  //                  upstream river neighbour)
  //
  // ★ AND THESE TWO ARE MUTUALLY EXCLUSIVE BY CONSTRUCTION, so unlike the three above the
  // combined rate is not even a sum: `a spring rises` requires `riverRing === 0` and
  // `the channel extends` requires `CHANNEL_OK[riverRing]`, which is 0 at `riverRing === 0`.
  // No tile can ever satisfy both on the same day. It is listed here rather than suppressed
  // because the check's real job is to guarantee a person looked at every overlap once.
  `${Biome.Marsh}>${Biome.River}`,
];

/** Rules bucketed by source biome, so evaluation only considers what can apply. */
export const RULES_BY_BIOME: readonly (readonly Rule[])[] = (() => {
  const buckets: Rule[][] = Array.from({ length: BIOME_COUNT }, () => []);
  for (const rule of RULES) buckets[rule.from]!.push(rule);
  return buckets;
})();
