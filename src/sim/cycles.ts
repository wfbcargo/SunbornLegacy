/**
 * WORLD CYCLES — the disturbance engine.
 *
 * The cleansing beam is one cycle among many. A world holds an ARRAY of cycles and
 * any combination must work: beam + seasons + tectonics + volcanism + three monsoons,
 * or none at all. A world's cycle set IS its identity and its difficulty, and it is
 * exactly what a Game Master configures.
 *
 * Why this is load-bearing rather than flavour: `SIMULATION.md` measured a world with
 * NO disturbance converging on a frozen equilibrium (churn 0.29%, living-land min-max
 * range collapsing to a single value). Every beamed world had higher entropy and 3-5x
 * the churn. Disturbance is what stops the terrain CA reaching an absorbing state, so
 * more and richer cycles = more life, not more damage.
 *
 * ---------------------------------------------------------------------------
 * THE CONTRACT
 * ---------------------------------------------------------------------------
 * A cycle does exactly two things, and it does them additively so that cycles compose
 * without ever knowing about each other:
 *
 *   (a) it contributes HEAT and MOISTURE deltas to a tile at evaluation time, and
 *   (b) it raises FLAGS on tiles it is acutely affecting today.
 *
 * Composition is `+=` for the scalars and `|=` for the flags. There is no ordering
 * dependency, no cycle-vs-cycle special case, and no cycle can veto another. A quake
 * during a purge is simply `Beam | Quake`, and a transition rule in biomes.ts may key
 * off that combination if the designer wants the interaction — but nothing here has
 * to change for that to work.
 *
 * IMPORTANT — heat is the ONLY channel into the hydrology. Cycles never touch the
 * moisture retention constant (0.9998) or the shape of the diffusion. Heat already
 * acts as a multiplicative decay on retention inside World, so a seasonal heat swing
 * automatically produces a seasonal moisture swing, physically and for free. Cycles
 * that want to add water (monsoon) add it to the diffusion TARGET, which is the same
 * additive channel marsh neighbours already use. Bugs #1 and #2 from SIMULATION.md
 * stay fixed because nothing here can reach the constants that caused them.
 *
 * ---------------------------------------------------------------------------
 * DETERMINISM
 * ---------------------------------------------------------------------------
 * Every cycle is a PURE FUNCTION of (worldSeed, cycleKey, day). There is no
 * accumulated state anywhere — no "days since last eruption" counter, no drift, no
 * carry. That is not tidiness, it is the requirement that makes lazy fast-forwarding
 * of unobserved regions possible: a region resolved on first contact after 400 days
 * of nobody looking must agree exactly with a server that simulated it day by day.
 *
 * The two-phase split enforces it:
 *   dayState(day) -> S | null   pure, cheap, once per cycle per day. null = dormant.
 *   affect(S, out, col, row)    pure, hot path, once per cycle per tile per day.
 *
 * `dayState` may allocate and may do real work (choosing today's epicentres); it runs
 * a handful of times a day. `affect` runs width*height*activeCycles times a day and
 * must stay branch-cheap. Dormant cycles return null from dayState and are dropped
 * from the per-tile loop entirely, so a beam between purges costs literally nothing.
 *
 * ---------------------------------------------------------------------------
 * INTROSPECTION
 * ---------------------------------------------------------------------------
 * "How many days until the next purge reaches this column?" must be answerable in
 * real-world units — and the same question must generalise: when do the rains arrive,
 * when does winter bite, how often does this fault move. Because dayState is pure,
 * ANY cycle can be forecast by evaluating it forward in time without touching the
 * live simulation. The base class does exactly that (`forecast`), and cycles with a
 * closed form (the beam) override it for an exact, unbounded answer.
 */

import { hexDistanceWithin, hexX } from './hex.ts';
import { hash32, rollAt } from './rng.ts';

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

/**
 * Acute effects a cycle can raise on a tile for one day.
 *
 * These are the vocabulary that transition rules in biomes.ts read. Keep them about
 * WHAT IS HAPPENING TO THE TILE, never about which cycle did it — that is what lets
 * a GM swap a volcanic world for a beam world without rewriting the ruleset. A vent
 * and a beam focus both raise `Focus`; a rule only cares that the ground is melting.
 */
export const CycleFlag = {
  /** Under the sweeping beam. Burns, boils, vitrifies. */
  Beam: 1 << 0,
  /**
   * Melting point. The narrow core of the beam, or a live volcanic vent.
   * This is the gate for sand -> LAVA. Rules should require this flag rather than
   * testing `heat > 120` alone: under the plain beam band an equatorial tile already
   * exceeds 120 from latitude + the validated +70, so a bare heat test would melt the
   * whole tropics into lava every purge.
   */
  Focus: 1 << 1,
  /** Ground shaking. Shatters glass to sand, fractures rock, collapses structures. */
  Quake: 1 << 2,
  /** On a fault ridge during a large quake. Orogeny: rock/basalt/badlands -> mountain. */
  Uplift: 1 << 3,
  /** A vent is erupting here. Lava emerges. */
  Eruption: 1 << 4,
  /** Volcanic fallout. Buries the surface in ash. */
  Ashfall: 1 << 5,
  /** Monsoon or storm front. Standing water, flooding, dissolution of glass. */
  Storm: 1 << 6,
  /** Seasonal peak heat. */
  Heatwave: 1 << 7,
  /** Seasonal deep cold. */
  Freeze: 1 << 8,
  /** Seasonal dry spell. */
  Drought: 1 << 9,

  // -- Weather systems: the six the `weather` cycle carries ------------------
  //
  // These are six TYPES of one travelling thing, not six independent phenomena, and
  // they come in light/heavy pairs. A heavy type always raises its light partner as
  // well, so a rule that means "any rain" tests `Rain` and one that means "a downpour"
  // tests `HeavyRain`; nothing has to enumerate a pair.

  /** Rain falling here. Raised by a rain storm and, with it, by a heavy one. */
  Rain: 1 << 10,
  /**
   * A downpour. Also raises `Storm`, deliberately: `Storm` is the ruleset's existing
   * word for "standing water, flooding, dissolution of glass", the monsoon and the wet
   * season already raise it, and a cloudburst is the same event at a smaller scale. Not
   * doing this would have meant re-gating every Storm rule to say `Storm | HeavyRain`.
   */
  HeavyRain: 1 << 11,
  /** Wind over this tile. Dries and abrades; it does NOT carry heat — see `Weather`. */
  Wind: 1 << 12,
  /** A gale. Strips soft cover and drives sand. */
  HeavyWind: 1 << 13,
  /** Cloud cover. Shade: it slows drying rather than causing anything. */
  Cloud: 1 << 14,
  /** Heavy overcast. */
  HeavyCloud: 1 << 15,
} as const;
export type CycleFlag = (typeof CycleFlag)[keyof typeof CycleFlag];

export const CYCLE_FLAG_NAMES: readonly (readonly [number, string])[] = [
  [CycleFlag.Beam, 'beam'],
  [CycleFlag.Focus, 'focus'],
  [CycleFlag.Quake, 'quake'],
  [CycleFlag.Uplift, 'uplift'],
  [CycleFlag.Eruption, 'eruption'],
  [CycleFlag.Ashfall, 'ashfall'],
  [CycleFlag.Storm, 'storm'],
  [CycleFlag.Heatwave, 'heatwave'],
  [CycleFlag.Freeze, 'freeze'],
  [CycleFlag.Drought, 'drought'],
  [CycleFlag.Rain, 'rain'],
  [CycleFlag.HeavyRain, 'heavyrain'],
  [CycleFlag.Wind, 'wind'],
  [CycleFlag.HeavyWind, 'heavywind'],
  [CycleFlag.Cloud, 'cloud'],
  [CycleFlag.HeavyCloud, 'heavycloud'],
];

export function flagNames(flags: number): string[] {
  const out: string[] = [];
  for (const [bit, name] of CYCLE_FLAG_NAMES) if (flags & bit) out.push(name);
  return out;
}

// ---------------------------------------------------------------------------
// The accumulator
// ---------------------------------------------------------------------------

/**
 * One tile's accumulated cycle contribution for one day.
 *
 * World owns a single reusable instance and resets it per tile — no allocation on the
 * hot path. Cycles only ever `+=` and `|=` into it; nothing reads another cycle's
 * contribution, which is what keeps composition order-independent.
 */
export class CycleEffect {
  /**
   * ACUTE heat, added to the tile's heat before the hydrology and the rules see it.
   *
   * ★ This channel must never be low-passed. `Focus` dwell under the blob beam is as
   * short as one day and carries +115 against a melt gate of 120, so putting it behind
   * a thermal filter does not soften the melt chemistry, it deletes it. Beam, volcanism
   * and tectonics write here.
   */
  heat = 0;
  /**
   * Slow, seasonal, AMBIENT heat — the channel that passes THROUGH a tile's thermal
   * filter. Distinct from `heat` for the reason above: a season is a months-long
   * forcing that a coastline may legitimately lag behind, where a purge is a one-day
   * event that a lag would erase.
   *
   * `World.buildContext` relaxes the tile's stored temperature towards
   * `heatAt(...) + ambientHeat` and then adds `heat` on top, so the two channels are no
   * longer interchangeable: putting a beam here softens it into nothing, and putting a
   * season on `heat` silently switches maritime climate off. `Seasons` is the only
   * shipped writer.
   */
  ambientHeat = 0;
  /** Added to the moisture diffusion TARGET, exactly like marsh neighbours are. */
  moisture = 0;
  /** OR of every flag raised on this tile today. */
  flags = 0;

  reset(): this {
    this.heat = 0;
    this.ambientHeat = 0;
    this.moisture = 0;
    this.flags = 0;
    return this;
  }
}

// ---------------------------------------------------------------------------
// The world view
// ---------------------------------------------------------------------------

/**
 * A read-only window on the grid, for cycles that resolve their day against terrain.
 *
 * Deliberately NOT `World`: no mutation, no stepping, no I/O (R-007). A cycle handed
 * one of these can ask what the ground is and how wet it is, and nothing else — it
 * cannot step the world, cannot write a tile, and cannot reach the hydrology constants.
 * Coordinates wrap on both axes, exactly like `HexTorus.index`.
 *
 * ★ IT IS THE GRID AS OF THE START OF THE DAY BEING RESOLVED. `dayState` runs once per
 * day, before the sweep touches a single tile, so every cycle sees the same snapshot
 * and cycle order stays irrelevant. A cycle that read the grid from `affect` would see
 * a half-stepped world and its answer would depend on where the gaze happened to be.
 *
 * ★ WHAT IT COSTS. `cycles.ts:41-45` defends `dayState` purity with lazy fast-forward
 * of unobserved regions, and a world-reading cycle gives that up: its day N depends on
 * the world, which depends on day N-1. `ARCHITECTURE.md` decision 10.1 already abandoned
 * that property for terrain — terrain is stepped every step at coarse resolution, not
 * reconstructed on contact — so the price was paid before this interface existed. What
 * survives is the weaker and still sufficient guarantee: same seed + same options ⇒
 * bit-identical world (R-004). A cycle that reads the world declares `readsWorld` so
 * its forecasts can be labelled honestly.
 */
export interface WorldView {
  readonly width: number;
  readonly height: number;
  /** Biome id at a wrapping coordinate. */
  biomeAt(col: number, row: number): number;
  /** Moisture at a wrapping coordinate, on the same 0-100 scale the rules use. */
  moistureAt(col: number, row: number): number;
  /**
   * OR of `TerrainClass` bits at a wrapping coordinate — the GEOGRAPHY of a tile,
   * decided by `BiomeDef` predicates rather than by a list of biome ids.
   *
   * ★ WHY THIS IS NOT `biomeAt` PLUS A LOOKUP TABLE IN THE CYCLE. A cycle that reads
   * `biomeAt` and compares against ids needs the biome taxonomy, and `cycles.ts` cannot
   * import `biomes.ts` — `biomes.ts` already imports `CycleFlag`, so the dependency
   * would become a cycle whose safety depends on which entry point happens to evaluate
   * first. The alternative, a hand-written list of "which ids are sea" inside a cycle,
   * is exactly the trap `biomes.ts` refuses to build for its own biome sets: the day a
   * biome is added, the storm classifier silently stops seeing it. `World` derives this
   * from `BiomeDef.water && !molten` etc., so a new biome joins the classification the
   * moment it joins `BIOMES`. See decision `0015`.
   */
  terrainAt(col: number, row: number): number;
}

/**
 * The geography a world-reading cycle is allowed to see — three DERIVED predicates, not
 * a taxonomy of biomes.
 *
 * ★ `Sea` IS THE STORM CLASSIFIER AND IT IS `water && !molten`, WHICH IS NOT A STYLE
 * CHOICE. Measured as shipped, 1500 days at 160×96, rain share per 300-day window:
 * 40.7 · 25.8 · 24.1 · 34.3 · 32.6%, oscillating with no trend and a normalised type
 * entropy of 0.969 — all six storm types stay in use. The epic's prior analysis
 * measured the alternative on the same instrument: gated on `moisture > 60` the same
 * storm LATCHES — 80.1 → 99.3 → 93.4 → 100.0 → 94.8% — because it rains, the ground
 * gets wet, so it rains forever, and the sea-gated storm could not shift its own
 * classifier's input at all (final water share 23.8% against 23.9% across a 3×
 * magnitude range).
 *
 * Never widen this to marsh, swamp or moisture, and note that spec 5's river biome is
 * deliberately `water: false` for the same reason — a storm that makes rain that makes
 * rivers that make the storm rain is the same latch with an extra hop.
 */
export const TerrainClass = {
  /** `BiomeDef.water && !molten` — ocean, shallows, frozen sea. Never lava. */
  Sea: 1 << 0,
  /** `BiomeDef.molten` — lava. */
  Molten: 1 << 1,
  /** `BiomeDef.stone` — consolidated ground: mountain, rock, basalt, badlands, glass. */
  Stone: 1 << 2,
} as const;
export type TerrainClass = (typeof TerrainClass)[keyof typeof TerrainClass];

/**
 * The view handed to a cycle resolved with no world attached.
 *
 * `forecast()` is an API call that may run before a world exists, or against a cycle
 * held on its own. `width === 0` is the signal, and it is a signal rather than a crash
 * because a forecast for a world-reading cycle is a PROJECTION anyway: the honest answer
 * when there is no terrain to project from is `null`, which the cycle returns for
 * itself. A cycle with `readsWorld` MUST check `view.width === 0`; one without never
 * touches the view at all, which is why the five shipped kinds ignore the parameter.
 */
export const DETACHED_VIEW: WorldView = {
  width: 0,
  height: 0,
  biomeAt: () => 0,
  moistureAt: () => 0,
  terrainAt: () => 0,
};

// ---------------------------------------------------------------------------
// Introspection types
// ---------------------------------------------------------------------------

export interface CycleForecast {
  readonly key: string;
  readonly kind: string;
  /** Real days from `fromDay` until this cycle next acutely touches the tile. */
  readonly daysUntil: number;
  /** How many consecutive days it stays acute once it arrives. */
  readonly durationDays: number;
  /** Flags it will raise on arrival. */
  readonly flags: number;
  /** Human-readable flag list, for the API. */
  readonly effects: readonly string[];
  /** Peak heat delta during the event — how hard it hits. */
  readonly peakHeat: number;
  /** Peak moisture delta during the event. */
  readonly peakMoisture: number;
  /**
   * Whether the arrival time is something the world could plausibly let a player
   * KNOW. The schedule is always computable (everything is pure), but a quake is not
   * announced. Periodic cycles are `true`; Poisson-scheduled ones are `false`, and
   * the API layer decides whether to expose the exact day or only the rate.
   */
  readonly announced: boolean;
  /** Mean days between occurrences at this tile. The honest answer for quakes. */
  readonly expectedIntervalDays: number;
  readonly label: string;
  /**
   * How much weight the arrival day can bear.
   *
   * `exact` — the cycle is a pure function of (seed, key, day), so running its schedule
   * forward IS the simulation and the day is a fact about the future.
   * `projected` — the cycle reads the world (`readsWorld`), so the forecast assumed the
   * terrain stops changing, and it will not. The number is a best current estimate.
   *
   * This is not the same axis as `announced`, which is about whether a world would TELL
   * a player. A quake is exact and unannounced; a storm front is projected and visible.
   */
  readonly basis: 'exact' | 'projected';
}

export interface CycleDescription {
  readonly key: string;
  readonly kind: string;
  readonly label: string;
  /**
   * What this cycle does to a world, mechanically, and what it costs or unlocks.
   * `label` is the poetic name a player would use; this is the sentence a GM needs.
   * Comes from CYCLE_CATALOGUE so an instance and the catalogue cannot disagree.
   */
  readonly summary: string;
  /** The cycle's dominant repeat time in days, for GM-facing summaries. */
  readonly periodDays: number;
  /** Flags this cycle is capable of raising. */
  readonly flags: readonly string[];
  readonly params: Readonly<Record<string, number | boolean | string>>;
}

// ---------------------------------------------------------------------------
// Base class
// ---------------------------------------------------------------------------

/** How far ahead the generic forecaster will look before giving up. */
export const DEFAULT_FORECAST_HORIZON = 1080;

export abstract class WorldCycle<S = unknown> {
  readonly kind: string;
  /** Unique within a world. Seeds this cycle's RNG stream, so two monsoons differ. */
  readonly key: string;

  protected width = 1;
  protected height = 2;
  protected worldSeed = 0;
  /** hash(worldSeed, key) — the root of every roll this cycle makes. */
  protected stream = 0;

  private readonly scratch = new CycleEffect();

  constructor(kind: string, key: string) {
    this.kind = kind;
    this.key = key;
  }

  /** Called once by World. Precomputes anything that depends on grid or seed. */
  bind(width: number, height: number, worldSeed: number): this {
    this.width = width;
    this.height = height;
    this.worldSeed = worldSeed;
    this.stream = hash32(worldSeed, hashKey(this.key), hashKey(this.kind));
    this.onBind();
    return this;
  }

  /** Hook for per-grid precomputation (row tables, fault lines, vent sites). */
  protected onBind(): void {}

  /**
   * This kind's catalogue entry — its label, its prose summary, and the flags it can
   * raise. `describe()` reads label/summary/flags from here rather than inlining them,
   * so an instance and the configuration UI cannot disagree about what a cycle is.
   */
  protected get catalogue(): CycleCatalogueEntry {
    return cycleCatalogueEntry(this.kind);
  }

  /**
   * True for a cycle whose day depends on the terrain, not only on the calendar.
   *
   * Two things key off it and nothing else may: `forecast` labels its answers
   * `projected` rather than `exact`, and the catalogue advertises it so a GM composing
   * a cycle set can see which of their choices are schedules and which are weather.
   * Default false — a cycle is calendar-pure until it says otherwise.
   */
  get readsWorld(): boolean {
    return false;
  }

  /**
   * The cycle's derived state for one day. MUST be a pure function of
   * (worldSeed, key, day, view) — no reading of `this` mutable state, no accumulation.
   * Return null when the cycle is dormant today; World then skips it entirely.
   *
   * `view` is the grid as of the START of `day`, and a cycle that touches it must say so
   * via `readsWorld`. A cycle that ignores it — every kind shipped today — may simply
   * declare `dayState(day: number)`: a one-parameter override satisfies a two-parameter
   * signature in TypeScript, so the five existing kinds needed no change at all.
   */
  abstract dayState(day: number, view: WorldView): S | null;

  /** Hot path: accumulate this cycle's contribution for one tile. Must not allocate. */
  abstract affect(state: S, out: CycleEffect, col: number, row: number): void;

  abstract describe(): CycleDescription;

  /** Mean days between acute occurrences at a tile. Overridden by the schedulers. */
  expectedIntervalDays(_col: number, _row: number): number {
    return this.describe().periodDays;
  }

  /** Periodic cycles announce themselves; Poisson ones do not. */
  protected get announced(): boolean {
    return true;
  }

  protected forecastLabel(_flags: number): string {
    return this.describe().label;
  }

  /**
   * Days until this cycle next acutely affects a tile.
   *
   * Generic and correct for EVERY cycle, present and future, because dayState is pure:
   * run the schedule forward without touching the world. Off the hot path (this is an
   * API call), so a day-by-day scan is fine — a few hundred cheap iterations.
   *
   * Scanning the real `affect` rather than re-deriving a closed form is deliberate: a
   * closed form is a second implementation of the cycle's geometry that can drift from
   * the first, and the beam's did — twice, in opposite directions, once on the torus
   * seam and once on day quantisation. Subclasses should override only to WIDEN the
   * horizon to something their period guarantees an answer within.
   */
  forecast(
    col: number,
    row: number,
    fromDay: number,
    horizonDays: number = DEFAULT_FORECAST_HORIZON,
    view: WorldView = DETACHED_VIEW,
  ): CycleForecast | null {
    const start = Math.floor(fromDay);
    for (let d = start; d < start + horizonDays; d++) {
      const flags = this.probe(d, col, row, view);
      if (flags === 0) continue;

      // Found the arrival. Walk forward to measure how long it lasts and how hard it
      // peaks, so the API can say "6 days of ashfall" rather than just "ashfall".
      let duration = 0;
      let peakHeat = 0;
      let peakMoisture = 0;
      let union = 0;
      for (let e = d; e < start + horizonDays; e++) {
        const f = this.probe(e, col, row, view);
        if (f === 0) break;
        duration++;
        union |= f;
        if (Math.abs(this.scratch.heat) > Math.abs(peakHeat)) peakHeat = this.scratch.heat;
        if (Math.abs(this.scratch.moisture) > Math.abs(peakMoisture)) {
          peakMoisture = this.scratch.moisture;
        }
      }
      // Never negative: `fromDay` may be mid-day, and "it is already happening" is 0.
      const daysUntil = Math.max(0, d - fromDay);
      return this.makeForecast(col, row, daysUntil, duration, union, peakHeat, peakMoisture);
    }
    return null;
  }

  /** Evaluate one day at one tile in isolation. Leaves the result in `this.scratch`. */
  protected probe(
    day: number,
    col: number,
    row: number,
    view: WorldView = DETACHED_VIEW,
  ): number {
    const state = this.dayState(day, view);
    this.scratch.reset();
    if (state === null) return 0;
    this.affect(state, this.scratch, col, row);
    return this.scratch.flags;
  }

  protected makeForecast(
    col: number,
    row: number,
    daysUntil: number,
    durationDays: number,
    flags: number,
    peakHeat: number,
    peakMoisture: number,
  ): CycleForecast {
    return {
      key: this.key,
      kind: this.kind,
      daysUntil,
      durationDays,
      flags,
      effects: flagNames(flags),
      peakHeat,
      peakMoisture,
      announced: this.announced,
      expectedIntervalDays: this.expectedIntervalDays(col, row),
      label: this.forecastLabel(flags),
      basis: this.readsWorld ? 'projected' : 'exact',
    };
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Signed shortest offset on a wrapping axis. The torus has no edges to special-case. */
function wrapDelta(delta: number, n: number): number {
  const m = ((delta % n) + n) % n;
  return m > n / 2 ? m - n : m;
}

/**
 * ABSOLUTE shortest offset between two positions ALREADY NORMALISED to [0, n).
 *
 * `wrapDelta`'s two modulo operations exist because it accepts any delta; when both
 * operands are known to be on-axis the difference is in (-n, n) and one compare does the
 * job. Identical to `wrapDelta` composed with `Math.abs` for every such input — the two
 * disagree only at exactly ±n/2, where the sign differs and the magnitude does not.
 */
function axisOffset(a: number, b: number, n: number): number {
  let d = a - b;
  const half = n / 2;
  if (d > half) d -= n;
  else if (d < -half) d += n;
  return d < 0 ? -d : d;
}

function hashKey(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/**
 * Epoch length for Poisson-ish scheduling, in days.
 *
 * Quakes and eruptions are not periodic — they need a memoryless-feeling schedule
 * that is nonetheless a pure function of the day. The trick: chop time into fixed
 * epochs and roll, per epoch per source, whether an event happens, when inside the
 * epoch it starts, and how long it runs. That is O(sources) per day with no state.
 *
 * Any event must fit inside one epoch, and consumers must check the CURRENT and the
 * PREVIOUS epoch so an event starting near an epoch boundary is not truncated.
 */
const EPOCH_DAYS = 64;

/** Roll in [0,1) for (cycle stream, epoch, source, salt). Pure. */
function epochRoll(stream: number, epoch: number, source: number, salt: number): number {
  return rollAt(stream, epoch, source, salt);
}

/**
 * How many epochs back a scheduler must look so an event of `durationDays` that began
 * before today is still seen today.
 *
 * `durationDays` is a GM-facing number and was previously required — by comment only —
 * to be <= EPOCH_DAYS, because the schedulers looked back exactly one epoch. Anything
 * longer was silently truncated: `durationDays: 100` produced 2491 erupting days out
 * of an expected 3200, so 22% of the eruption a GM asked for simply never happened and
 * nothing said so. Looking back the right number of epochs is strictly better than
 * asserting the limit, because it makes the parameter mean what it says at any value.
 */
function epochLookback(durationDays: number): number {
  return Math.max(1, Math.ceil(Math.max(0, durationDays) / EPOCH_DAYS));
}

// ---------------------------------------------------------------------------
// The travelling disc — ONE implementation of the sinusoid
// ---------------------------------------------------------------------------

/**
 * A sinusoidal track across the torus: x runs the full width once per traverse, y is a
 * sine about `homeRow`.
 *
 * ★ THERE IS EXACTLY ONE OF THESE AND THAT IS THE POINT. The beam travels this curve and
 * so does every storm; decision `0008` records that two implementations of one curve is
 * how this repo got two separate beam seam bugs, so the second consumer extracted the
 * first one's geometry rather than writing its own. The extraction was verified by the
 * golden hashes: `still 10468117cccd7501` and `crucible e34f6edacd80b9d0` are unchanged
 * across it, so the curve the beam draws today is the same curve to the last bit.
 *
 * `amplitudeHalfHeights` is a FRACTION of `height / 2` rather than a row count, because
 * an absolute amplitude is correct at exactly one world size. `oscillations` should be a
 * whole number for anything whose track must meet itself at the torus seam.
 */
export interface SinusoidTrack {
  readonly width: number;
  readonly height: number;
  /** Column the track starts from at p = 0. The beam starts at 0; a storm anywhere. */
  readonly startCol: number;
  readonly direction: 1 | -1;
  readonly amplitudeHalfHeights: number;
  readonly oscillations: number;
  /** Phase of the sine, in turns [0,1). */
  readonly wavePhase: number;
  /** Row the sine oscillates about. */
  readonly homeRow: number;
}

/**
 * One day's worth of a travelling disc's path, sampled, with the bounding box that
 * rejects most of the world before the per-tile inner loop runs.
 *
 * ★ THE PATH IS SWEPT, NOT POINT-SAMPLED, and that is not a refinement — it is the
 * difference between a track and a row of disjoint beads. At 240 columns and a 45-day
 * traverse the centre advances 5.33 columns a day and, at 9 oscillations of full
 * amplitude, up to 90 ROWS a day; a disc smaller than its own daily step sampled once a
 * day leaves measured ZERO overlap between consecutive days.
 *
 * Endpoints are inclusive, so today's last sub-centre is tomorrow's first and the track
 * can never develop a one-substep gap at a day boundary.
 */
export interface SweptArc {
  /** Sub-centre x positions (column units, `hexX` space), normalised to [0, width). */
  readonly xs: Float64Array;
  /** Sub-centre rows, normalised to [0, height). */
  readonly ys: Float64Array;
  /** Centre of the day's x window, for the bounding-box reject. */
  readonly xMid: number;
  /** Half-span of that window plus the radius. Negative disables the reject. */
  readonly xReach: number;
  /** As above, on rows. */
  readonly yMid: number;
  readonly yReach: number;
  /**
   * Which half of the bounding box to test first — the one that rejects more.
   *
   * ★ NOT A MICRO-OPTIMISATION, AND IT IS NOT THE SAME ANSWER FOR EVERY TRACK. The
   * reject runs once per tile per travelling disc per day, so it is the single hottest
   * line either consumer has. A beam's day-arc is ~5 of 240 columns wide and up to 90 of
   * 144 rows tall, so the COLUMN test throws away 84% of the world and the row test
   * almost nothing. A storm's arc is the other shape — narrow in columns but travelling
   * a third of the world's rows at a much slower pace, and there are several of them at
   * once. Hardcoding one order makes the other consumer pay for the whole box.
   *
   * It is decided from the spans themselves, as a fraction of each axis, so a track that
   * changes shape re-decides it for free.
   */
  readonly yFirst: boolean;
}

/**
 * The degenerate track a cycle holds before `bind` gives it a grid. Never traversed —
 * every consumer rebuilds its track in `onBind` — but it keeps the field non-nullable
 * so no hot path has to test for a track that does not exist yet.
 */
const FLAT_TRACK: SinusoidTrack = {
  width: 1,
  height: 2,
  startCol: 0,
  direction: 1,
  amplitudeHalfHeights: 0,
  oscillations: 0,
  wavePhase: 0,
  homeRow: 0,
};

/** The track's x at progress `p` through one traverse. `p` is NOT wrapped by the caller. */
function trackX(t: SinusoidTrack, p: number): number {
  return mod(t.startCol + p * t.width * t.direction, t.width);
}

/** The track's row at progress `p`. */
function trackY(t: SinusoidTrack, p: number): number {
  const amplitude = t.amplitudeHalfHeights * (t.height / 2);
  const phase = 2 * Math.PI * (t.oscillations * p + t.wavePhase);
  return mod(t.homeRow + amplitude * Math.sin(phase), t.height);
}

/**
 * Sub-centres per day, chosen so consecutive ones are at most about one hex apart.
 *
 * Over one day the centre moves `width / spanDays` columns and up to
 * `π · amplitude · height · oscillations / spanDays` rows (the sine's peak slope), and
 * hex distance is bounded by their sum. The ROW speed is what sets the number, which is
 * the whole reason a point sample fails.
 *
 * Capped, because it is a per-tile inner loop and a GM can ask for a very fast, very
 * wavy track. Past the cap the path is sampled coarser than one hex and may scallop —
 * a visible artefact of an extreme setting rather than a silent one.
 */
function trackSubsteps(t: SinusoidTrack, spanDays: number, cap: number): number {
  if (spanDays <= 0) return 1;
  const colSpeed = t.width / spanDays;
  const rowSpeed =
    (Math.PI * Math.abs(t.amplitudeHalfHeights) * t.height * Math.abs(t.oscillations)) / spanDays;
  return Math.min(cap, Math.max(1, Math.ceil(colSpeed + rowSpeed)));
}

/** Sample the arc from `p0` to `p0 + dp` in `n` steps, endpoints inclusive. */
function sweepArc(
  t: SinusoidTrack,
  p0: number,
  dp: number,
  n: number,
  radius: number,
): SweptArc {
  const xs = new Float64Array(n + 1);
  const ys = new Float64Array(n + 1);

  // Bounds are tracked as SIGNED offsets from the first sub-centre, so a window that
  // straddles the torus seam is still one interval rather than two.
  const x0 = trackX(t, p0);
  const y0 = trackY(t, p0);
  let xLo = 0;
  let xHi = 0;
  let yLo = 0;
  let yHi = 0;

  for (let k = 0; k <= n; k++) {
    const p = p0 + (dp * k) / n;
    const x = trackX(t, p);
    const y = trackY(t, p);
    xs[k] = x;
    ys[k] = y;
    const dx = wrapDelta(x - x0, t.width);
    const dy = wrapDelta(y - y0, t.height);
    if (dx < xLo) xLo = dx;
    if (dx > xHi) xHi = dx;
    if (dy < yLo) yLo = dy;
    if (dy > yHi) yHi = dy;
  }

  // Reach = half the window plus the radius plus the half-column of odd-row shift. A
  // window that already spans more than the axis is no filter at all, and a negative
  // reach is the signal to skip the test rather than run one that can never fire.
  const xSpan = xHi - xLo;
  const ySpan = yHi - yLo;
  const xReach = xSpan + 2 * radius + 1 >= t.width ? -1 : xSpan / 2 + radius + 0.5;
  const yReach = ySpan + 2 * radius + 1 >= t.height ? -1 : ySpan / 2 + radius;
  return {
    xs,
    ys,
    xMid: mod(x0 + (xLo + xHi) / 2, t.width),
    xReach,
    yMid: mod(y0 + (yLo + yHi) / 2, t.height),
    yReach,
    // A disabled test (-1) filters nothing, so it always goes second.
    yFirst: xReach < 0 || (yReach >= 0 && yReach / t.height < xReach / t.width),
  };
}

/**
 * MINIMUM hex distance from a tile to today's arc, or `Infinity` past `radius`.
 *
 * Minimum, never a sum: accumulating an effect per substep multiplies a tile's dose
 * ~17-fold. Taking the minimum and applying the effect once preserves the property a
 * full-height band had by construction — exactly one exposed evaluation per tile per day.
 *
 * The bounding-box reject in front of it is worth about a factor of ten on a swept
 * track's overhead: the day's arc occupies ~5 of 240 columns at the shipped transit, so
 * ~84% of tiles are discarded on two subtracts before the ~96-iteration loop is entered.
 */
function arcDistance(
  arc: SweptArc,
  col: number,
  row: number,
  width: number,
  height: number,
  radius: number,
): number {
  // ★ NO `wrapDelta` HERE, AND THAT IS DELIBERATE. Both operands are already normalised
  // to their axis, so the difference is in (-n, n) and the shortest wrap is one compare
  // and one subtract rather than two `%` operations. It is the same arithmetic
  // `hexDistanceWithin` uses for the same reason, it agrees with `wrapDelta` on every
  // value once the sign is dropped, and this runs once per tile per disc per day.
  if (arc.yFirst) {
    if (arc.yReach >= 0 && axisOffset(row, arc.yMid, height) > arc.yReach) return Infinity;
    if (arc.xReach >= 0 && axisOffset(hexX(col, row), arc.xMid, width) > arc.xReach) return Infinity;
  } else {
    if (arc.xReach >= 0 && axisOffset(hexX(col, row), arc.xMid, width) > arc.xReach) return Infinity;
    if (arc.yReach >= 0 && axisOffset(row, arc.yMid, height) > arc.yReach) return Infinity;
  }

  const { xs, ys } = arc;
  let best = radius;
  let hit = false;
  for (let k = 0; k < xs.length; k++) {
    const d = hexDistanceWithin(col, row, xs[k]!, ys[k]!, width, height, best);
    if (d > best) continue;
    best = d;
    hit = true;
    if (best === 0) break;
  }
  return hit ? best : Infinity;
}

// ===========================================================================
// SolarBeam — the cleansing sweep
// ===========================================================================

/**
 * What the beam IS, geometrically. Not a style: the two shapes have different
 * severity models and only one of them matches the fiction.
 *
 * `band` — a full-height column band. Every row of a column is under it at once, so a
 *   purge covers 100% of the world's tiles and dwell time is set by transit alone. This
 *   is the shape every number in `SIMULATION.md` was measured with, and it is kept
 *   because those numbers are the validated `anvil` prototype.
 * `blob` — a hex disc of `radiusHexes` travelling a sinusoidal track, swept along the
 *   day's arc. A focus that moves rather than a wall that passes. Coverage is now a
 *   parameter rather than a constant 100%, and coverage — not heat budget — is what the
 *   world consumes: see the radius table in the spec.
 */
export type SolarBeamShape = 'band' | 'blob';

/**
 * Where a beam is RIGHT NOW. Orientation, not prediction.
 *
 * ★ THERE IS DELIBERATELY NO FORWARD TRACK HERE. An earlier draft of spec `0280c42b`
 * carried one, and the user corrected it: the beam's path is meant to be readable from
 * **the scar it leaves in the terrain** — the glass, ash, lava and desert it drags behind
 * it — not from a line drawn over the map. That makes followability a property of the
 * simulation rather than of the renderer, and it is why partial coverage is load-bearing
 * twice over: a beam that burns everything leaves no trail to follow. See decision `0025`.
 */
export interface BeamSighting {
  readonly key: string;
  readonly shape: SolarBeamShape;
  /**
   * Centre in `hexX` space. For a band this is the centre COLUMN and `row` is -1: a band
   * occupies every row of its columns, and inventing a row would be worse than saying so.
   */
  readonly x: number;
  readonly row: number;
  readonly radius: number;
  readonly focusRadius: number;
  /** Days from one traverse to the next — `transitDays` when the beam is continuous. */
  readonly traversePeriodDays: number;
  /** Traverses to a great year. 1 when the beam does not precess. */
  readonly greatYearTraverses: number;
  /** Length of the great year in days, after which position and track repeat exactly. */
  readonly greatYearDays: number;
  /** Which traverse of the current great year this is, 1..K. */
  readonly traverse: number;
  /** Days into the current traverse. */
  readonly intoTraverse: number;
  /** Whether the beam is present every day. */
  readonly continuous: boolean;
}

/**
 * Ceiling on sub-centres per day for a swept blob. See `SolarBeam.onBind`.
 *
 * 4096 is roughly 40× what the shipped configuration needs, so nothing a GM is likely
 * to compose reaches it; it exists so a pathological combination (a one-day transit
 * across a 2048-wide world at 64 oscillations) degrades into a coarser track rather
 * than a per-tile loop of a hundred thousand iterations.
 */
const BEAM_MAX_SUBSTEPS = 4096;

export interface SolarBeamParams {
  /**
   * Real days for the beam to cross the world once. This is SEVERITY: it sets how
   * long any one tile bakes underneath. 120d transit sterilises (SIMULATION.md).
   */
  transitDays: number;
  /**
   * Real days from the start of one purge to the start of the next. This is RECOVERY
   * TIME. Between purges the beam is dormant and the world grows back.
   *
   * ★ IGNORED BY A CONTINUOUS BLOB — see `continuous`, which is the shipped default.
   * It still governs a `band` beam and a blob with `continuous: false`.
   *
   * ★ Under a BAND these two MUST stay separate. Collapsing them into a single "period"
   * inverts the effect: a longer period becomes a SLOWER beam, each tile bakes longer,
   * and the world sterilises — at a single-knob 900-day period, water reached 0%.
   * Validated band default: 60d transit / 360d cycle.
   *
   * ★ THAT FINDING DOES NOT TRANSFER TO A BLOB, and it was re-measured rather than
   * assumed — see decision `0024`. Under a band every tile of a column sits under the
   * wall for the whole time the wall takes to clear its own width, so dwell is
   * `widthCols / (width / transitDays)` and grows linearly with transit. Under a blob
   * dwell is `(2·radius+1) / trackSpeed` where track speed is dominated by the sine's
   * ROW speed, which is `4·amp·(height/2)·oscillations / transitDays` — an order of
   * magnitude larger than the column speed. At every setting this spec measured, that
   * quotient is below one day, and `World` gives a tile at most one beam-exposed
   * evaluation per day by construction, so blob dwell is pinned at 1 day and cannot be
   * lengthened by slowing the beam down. What a longer traverse period buys a blob is a
   * longer GREAT YEAR — the same total dose spread over more days — not a hotter tile.
   */
  cycleDays: number;
  /**
   * BLOB ONLY. Whether the beam is permanently present.
   *
   * `true` (the default) is the wandering sun: one traverse ends and the next begins on
   * the very next day, `cycleDays` is not consulted at all, and there is no day on which
   * the beam contributes nothing. `transitDays` becomes the TRAVERSE PERIOD and it is
   * the only time knob the blob has.
   *
   * `false` restores the old purge-and-recover schedule, in which the beam is dormant
   * for `cycleDays − transitDays` days out of every `cycleDays`.
   *
   * ★ RECOVERY DID NOT DISAPPEAR, IT BECAME LOCAL. A dormant beam gives every tile the
   * same recovery interval whether the beam ever visited it or not; a precessing beam
   * gives each tile the interval its own track return implies, which is the great year
   * (`greatYearTraverses × transitDays`). That is both better physics and a better GM
   * dial, and it is what makes a permanently-present beam survivable at all.
   */
  continuous: boolean;
  /** Which geometry this beam is. See `SolarBeamShape`. */
  shape: SolarBeamShape;
  /** BAND ONLY. Width of the scorching band, in columns. */
  widthCols: number;
  /** Heat added across the whole beam, whatever its shape. Validated at +70. */
  heat: number;
  /** BAND ONLY. Width of the melting core, in columns. Raises Focus. */
  focusCols: number;
  /** Extra heat inside the core, on top of `heat`. Pushes sand past melting. */
  focusHeat: number;
  /**
   * BLOB ONLY. Radius of the scorching disc, in HEX RINGS, inclusive — r=2 is 5 tiles
   * across and 19 tiles in area. This is the severity dial and the first-class GM knob:
   * the measured radius table lives in `.wiki/specs/2915cb06-1_contract-and-beam.md`.
   *
   * Every figure below is from `anvil` — the beam-only world, so the beam is the only
   * thing standing between a tile and a live out-rule — at 240×144, seed 20260729,
   * 1200 days, with the track held fixed and radius the only variable.
   *
   * ★ What it buys is COVERAGE, and coverage SATURATES. r=2 delivers 10,623 tile-days
   * per purge to 28.46% of the map, r=8 reaches 93.34%, and by r=12 coverage is pinned
   * at 100.00%. Past saturation radius buys only heat with no reach behind it — r=32
   * delivers 348,033 tile-days, 268% of a full band's 129,600, over the same 100.00% of
   * the world, and the share of it with no live out-rule barely moves (13.90% at r=12,
   * 13.36% at r=32). The world consumes the fraction of itself the beam reaches.
   *
   * ★ BELOW SATURATION THE BINDING CONSTRAINT IS INVARIANT 8, NOT THE LIVENESS TEST.
   * A small radius does not announce itself as a broken world. At r=2 `anvil` PASSES
   * `npm run sim`'s test 1 — entropy 0.686 against a 0.65 floor, churn 0.180% against
   * 0.15% — while 61.56% of the world has no live out-rule and six biome families latch
   * above the 2% limit (tundra 16.01%, forest 10.66%, grassland 6.27%, frozensea 4.78%,
   * savanna 4.40%, desert 2.47%). A beam reaching 28% of the map moves enough
   * composition to clear the churn floor with the other 72% frozen solid.
   * `npm run sim:check` catches this and `npm run sim` does not, so a GM lowering the
   * radius should be pointed at invariant 8: the smallest radius that keeps `sim:check`
   * green on `anvil` is 8. r=4 still latches four families.
   *
   * The full table is in the spec cited above. Its coverage and tile-days columns agree
   * with the numbers here to the digit — that geometry has not changed — but the table
   * was taken before spec 2's thermal inertia landed, so its entropy, churn and
   * invariant-8 columns sit a few tenths away from what this branch now measures.
   */
  radiusHexes: number;
  /**
   * BLOB ONLY. Radius of the melting core, in hex rings. 0 is legal and means only the
   * centreline tile melts; the Focus flag is still raised, so the melt chemistry stays
   * open on a world whose beam is a needle.
   */
  focusRadiusHexes: number;
  /**
   * BLOB ONLY. Amplitude of the sinusoidal track, as a FRACTION OF `height / 2` — not
   * a row count.
   *
   * ★ This is a fraction on purpose and the choice is load-bearing. The golden worlds
   * are 160×96 and the viewer's floor is a 16-row world, so an absolute-row default is
   * correct at exactly one world size and silently wrong at every other. At 1.0 the
   * track reaches every latitude the torus has; at 0.5 it visits a little over half the
   * rows and the rest of the world is structurally beam-free FOREVER, because the track
   * is periodic and retraces itself purge after purge.
   */
  amplitudeHalfHeights: number;
  /**
   * BLOB ONLY. Full sine cycles per transit. MUST BE AN INTEGER: the track starts at
   * column 0 and ends at column W, which is column 0 again, and only a whole number of
   * oscillations makes the two ends of the scar meet at the torus seam. A fractional
   * count leaves a discontinuity that a player would read as a bug in the world.
   */
  oscillations: number;
  /** BLOB ONLY. Phase of the sine, in turns [0,1). Slides the track's crossings. */
  wavePhase: number;
  /**
   * BLOB ONLY. How many traverses make one GREAT YEAR — the `K` in a precession of
   * `1/K` turns of wave phase per traverse. `1` means no precession at all.
   *
   * ★ THIS IS WHAT MAKES "EVENTUALLY EVERYWHERE" POSSIBLE. Without it the track is
   * derived from progress through a single traverse and therefore identical every
   * traverse: measured on the old geometry, coverage after one traverse 7.47% and after
   * five traverses still 7.47%. Whatever the first pass missed was missed for the life
   * of the world, and the only way to reach every tile was a radius wide enough to cover
   * 100% in one pass — which is exactly how the beam stopped being visible.
   *
   * ★ IT IS A RATIONAL `1/K` AND NOT A DRIFT, ON PURPOSE. `mod(n, K) / K` returns the
   * track to its starting curve after exactly K traverses, so the world has a great year
   * of `K × transitDays` days and a player who learns one number knows where the sun
   * will be forever. An irrational or seed-random advance would also cover the map, and
   * would be unlearnable — which defeats the point of the beam being predictable.
   *
   * ★ WHY `mod(n, K) / K` AND NOT `n / K`. It is a pure function of the day either way
   * (R-004), but `n/K` grows without bound and a world stepped past day ~10^13 would
   * start losing wave-phase precision to the float. Reducing first keeps the phase in
   * [0,1) exactly and makes K-periodicity exact rather than approximate.
   *
   * Choosing it: precession slides the sine horizontally by one full wavelength over the
   * great year, so `K` wants to be about `width / (2 · oscillations · beamWidthCols)`.
   * Do not trust that — the cumulative coverage table in
   * `.wiki/specs/0280c42b_wandering-sun.md` is measured, and it is the number to read.
   */
  greatYearTraverses: number;
  /** BLOB ONLY. Row the track oscillates about. 0 is the hot equator. */
  homeRow: number;
  /** Direction of travel. -1 sweeps the other way; the maths is symmetric. */
  direction: 1 | -1;
  /** Day the first purge begins. Lets two beams on one world be out of phase. */
  phaseDays: number;
}

/**
 * ★ THESE DEFAULTS ARE CHOSEN FOR LEGIBILITY FIRST, AND THAT IS A REVERSAL.
 *
 * The previous set — r=16 / 9 oscillations / 45–60d transit / dormant 5 days in 6 — was
 * chosen as "the shape that does not change the world": the smallest set of numbers that
 * reproduced the band prototype's verdicts and biome counts. It succeeded at that and
 * the result was a sun nobody could see. Three compounding measurements, all on this
 * tree at 240×144:
 *
 *   · at 9 oscillations over a 45-day traverse the centre swept 143 of the world's 144
 *     ROWS in a single day — 68, 30, 143, 30, 68, 143 … — so the wave aliased into a
 *     full-height smear rather than reading as a wave at all;
 *   · at radius 16 one pass covered 100.00% of the map, so even the cumulative scar was
 *     uniform and there was no pattern left to follow;
 *   · and the track retraced exactly, so coverage after one traverse (7.47%) and after
 *     five (7.47%) were the same number.
 *
 * ★ AND "LEGIBLE" MEANS THE SCAR, NOT AN OVERLAY. The user's clarification: "I didnt mean
 * to render its path. I simply meant that because of the immense heat of the beam
 * effecting the biomes, it will be easy to see where it has been because of the biome
 * changes preceding it." So the trail is glass, ash and lava in the biome grid, and these
 * defaults are chosen so that trail draws a wave anyone can trace. That makes partial
 * coverage load-bearing twice over: **a beam that burns everything leaves no trail.**
 *
 * The defaults below are the smallest set that makes the SCAR followable and still leaves
 * the world healthy, and every one of them is measured:
 *
 *   · 2 oscillations over a 60-day traverse. Two things follow, and the second is why
 *     the count came down from 3. Daily row travel is 0–15 rows of 144, mean 9.6 — a
 *     fifteenth of the world's height a day, against 143 of 144 at the old default. And
 *     the track's SLOPE, `2π·amplitude·oscillations / width`, falls to 3.8 rows per
 *     column: at 3 oscillations it is 5.7 and at 9 it is 17, and past roughly one hex of
 *     rise per column the scar stops reading as a wave and starts reading as a row of
 *     vertical stripes. Row speed and slope are both set by `oscillations / transitDays`,
 *     so those are the two knobs a GM turns to trade legibility against reach;
 *   · radius 8 — one pass covers 28.50% of the map, so roughly seven tenths of the world
 *     is unburned at any moment for the burned part to be legible against;
 *   · a great year of 8 traverses — cumulative coverage 28.50 → 52.34 → 72.88 → 86.92 →
 *     95.35 → 99.31 → 100.00%, and traverse 9 reproduces traverse 1 exactly. Every tile
 *     is reached within 480 days and the sun is exactly as predictable afterwards;
 *   · continuous — the beam is never dormant, so the sun is a permanent feature of the
 *     sky rather than a scheduled event.
 *
 * ★ THE WORLD SURVIVES THEM, AND THAT WAS CHECKED THE WAY THE LAST PASS SHOULD HAVE
 * BEEN. Below saturation the binding constraint is invariant 8, not the liveness test —
 * at r=2 on the old geometry `anvil` PASSED `npm run sim` while 61.56% of the world had
 * no live out-rule and six biome families latched. `npm run sim:check` is the gate that
 * catches it, and it is green on every preset at these defaults.
 *
 * ★ AND THE NUMBERS DID MOVE, WHICH IS THE POINT. A permanently-present beam that
 * reaches under a third of the world at a time is a different world from a periodic one
 * that flattens all of it; "the numbers did not move" would have meant this spec changed
 * nothing a player could see. Measured at 240×144, seed 20260729, over one traverse, the
 * share of the world whose biome differs from a no-cycle control — i.e. the visible
 * trail — is 8.74% here against **44.44%** at the r=16 / 9-oscillation default this
 * replaces, and that 44% is a uniform smear with no track in it at all.
 */
const SOLAR_BEAM_DEFAULTS: SolarBeamParams = {
  transitDays: 60,
  cycleDays: 360,
  shape: 'blob',
  continuous: true,
  widthCols: 8,
  heat: 70,
  focusCols: 2,
  focusHeat: 45,
  radiusHexes: 8,
  focusRadiusHexes: 2,
  amplitudeHalfHeights: 1,
  oscillations: 2,
  wavePhase: 0,
  greatYearTraverses: 8,
  homeRow: 0,
  direction: 1,
  phaseDays: 0,
};

interface BeamBandState {
  readonly shape: 'band';
  /** Leading column of the gaze this day. */
  readonly centre: number;
}

/**
 * The day's ARC, not the day's point — see `SweptArc`, whose geometry this is.
 *
 * The beam was the first consumer of the travelling disc and is no longer the only one;
 * the curve, the sampling rate and the bounding box now live in `SinusoidTrack` /
 * `SweptArc` / `arcDistance` so that a storm and a sun cannot disagree about the shape
 * of a sinusoid.
 */
interface BeamBlobState extends SweptArc {
  readonly shape: 'blob';
}

type BeamState = BeamBandState | BeamBlobState;

/**
 * The existing sweep+beam, generalised into a cycle.
 *
 * One behavioural note versus the prototype: the beam centre is now resolved once per
 * DAY instead of once per sweep step. At the validated 60d transit the beam advances
 * 4 columns/day, i.e. ~0.13 columns per step, so the band is effectively static within
 * a day and the numbers are unchanged — but it also removes an aliasing hazard, where
 * a gaze and a beam both moving in +col at different speeds could systematically over-
 * or under-expose particular columns. Every tile in the band now gets exactly one
 * beam-exposed evaluation per day, by construction.
 */
export class SolarBeam extends WorldCycle<BeamState> {
  readonly params: SolarBeamParams;

  /** Sub-centres sampled per day along the arc. Blob only; set in `onBind`. */
  private substeps = 1;
  /** The track the blob traverses. Constant for the life of the world. */
  private track: SinusoidTrack = FLAT_TRACK;

  constructor(key = 'beam', params: Partial<SolarBeamParams> = {}) {
    super('solarbeam', key);
    this.params = { ...SOLAR_BEAM_DEFAULTS, ...params };
  }

  /**
   * The beam's track and the resolution its arc is sampled at.
   *
   * Both come from the shared travelling-disc geometry — see `SinusoidTrack` and
   * `trackSubsteps`. At the shipped 240×144 / 45d / 9 oscillations that is 5.3 columns
   * plus 90.5 rows a day, so 96 sub-centres.
   */
  protected override onBind(): void {
    const { transitDays, amplitudeHalfHeights, oscillations, wavePhase, homeRow, direction } =
      this.params;
    this.track = {
      width: this.width,
      height: this.height,
      startCol: 0,
      direction,
      amplitudeHalfHeights,
      oscillations,
      wavePhase,
      homeRow,
    };
    this.substeps = trackSubsteps(this.track, transitDays, BEAM_MAX_SUBSTEPS);
  }

  /**
   * True while a purge is crossing the world.
   *
   * ★ A CONTINUOUS BLOB IS ALWAYS TRUE, and that is the whole of "always present". The
   * `false` branch is the old purge-and-recover schedule, still what a `band` does.
   */
  active(day: number): boolean {
    const { cycleDays, transitDays, phaseDays } = this.params;
    if (transitDays <= 0) return false;
    if (this.isContinuous) return true;
    if (cycleDays <= 0) return false;
    return mod(day - phaseDays, cycleDays) < transitDays;
  }

  /** Whether this beam is a permanently-present blob. A band never is. */
  private get isContinuous(): boolean {
    return this.params.shape === 'blob' && this.params.continuous;
  }

  /**
   * Days from the start of one traverse to the start of the next.
   *
   * For a continuous blob this IS `transitDays` — the two knobs collapse, which is what
   * makes the beam permanent. For everything else it is `cycleDays`, and the gap between
   * them is the dormancy.
   */
  get traversePeriodDays(): number {
    return this.isContinuous ? this.params.transitDays : this.params.cycleDays;
  }

  /**
   * How many traverses the track takes to return to its starting curve. 1 when the beam
   * does not precess, in which case the track retraces exactly and forever.
   */
  get greatYearTraverses(): number {
    if (this.params.shape !== 'blob') return 1;
    return Math.max(1, Math.floor(this.params.greatYearTraverses));
  }

  /**
   * Length of the great year in days — the interval after which the beam's whole
   * schedule, position and track repeat. This is the number a player learns.
   */
  get greatYearDays(): number {
    return this.greatYearTraverses * this.traversePeriodDays;
  }

  /**
   * Which traverse a day falls in.
   *
   * ★ DERIVED FROM THE DAY, NEVER ACCUMULATED (R-004). A precession counter advanced
   * once per traverse would make the track depend on the history of the run, which is
   * precisely the property `cycles.ts` exists to refuse — day N would stop agreeing with
   * itself when resolved out of order.
   */
  traverseIndex(day: number): number {
    const period = this.traversePeriodDays;
    if (period <= 0) return 0;
    return Math.floor((day - this.params.phaseDays) / period);
  }

  /**
   * The track traverse `n` walks — the base curve, precessed by `n/K` turns.
   *
   * `mod(n, K)` first, so the phase stays exact and in [0,1) however far the world has
   * been stepped. Returns the shared base track unchanged when K is 1, so a
   * non-precessing beam allocates nothing per day and is bit-identical to the old one.
   */
  trackFor(n: number): SinusoidTrack {
    const k = this.greatYearTraverses;
    if (k <= 1) return this.track;
    return { ...this.track, wavePhase: this.track.wavePhase + mod(n, k) / k };
  }

  dayState(day: number): BeamState | null {
    if (!this.active(day)) return null;
    const { transitDays, phaseDays, direction, shape } = this.params;
    const period = this.traversePeriodDays;
    const intoPurge = mod(day - phaseDays, period);
    if (shape === 'band') {
      const travelled = (intoPurge / transitDays) * this.width * direction;
      return { shape: 'band', centre: mod(Math.floor(travelled), this.width) };
    }
    // The day's arc, from p to p + dp. `p` is NOT wrapped: the last day of a transit
    // ends at exactly p=1, i.e. column 0 again, which is how the scar's two ends meet
    // at the seam.
    const arc = sweepArc(
      this.trackFor(this.traverseIndex(day)),
      intoPurge / transitDays,
      1 / transitDays,
      this.substeps,
      this.params.radiusHexes,
    );
    return { shape: 'blob', ...arc };
  }

  affect(state: BeamState, out: CycleEffect, col: number, row: number): void {
    if (state.shape === 'band') {
      const delta = Math.abs(wrapDelta(col - state.centre, this.width));
      if (delta >= this.params.widthCols) return;
      out.heat += this.params.heat;
      out.flags |= CycleFlag.Beam;
      if (delta < this.params.focusCols) {
        out.heat += this.params.focusHeat;
        out.flags |= CycleFlag.Focus;
      }
      return;
    }

    const best = arcDistance(state, col, row, this.width, this.height, this.params.radiusHexes);
    if (best === Infinity) return;

    out.heat += this.params.heat;
    out.flags |= CycleFlag.Beam;
    if (best <= this.params.focusRadiusHexes) {
      out.heat += this.params.focusHeat;
      out.flags |= CycleFlag.Focus;
    }
  }

  /**
   * Leading column of the beam today, or -1 when dormant.
   *
   * For a blob this is the column its centre has reached, which is the honest answer to
   * "where is the sun" and NOT the answer to "is my tile under it" — under a blob those
   * are different questions and only `forecast` answers the second.
   */
  column(day: number): number {
    const s = this.dayState(day);
    if (s === null) return -1;
    if (s.shape === 'band') return s.centre;
    return Math.round(s.xs[s.xs.length - 1]!) % this.width;
  }

  /**
   * Where the beam is today: the leading sub-centre for a blob, or the band's centre
   * column with `row: -1` — a band occupies every row of its columns, so there is no
   * row to give and inventing one would be worse than saying so.
   *
   * `null` when the beam is dormant.
   */
  position(day: number): { col: number; row: number } | null {
    const s = this.dayState(day);
    if (s === null) return null;
    if (s.shape === 'band') return { col: s.centre, row: -1 };
    const last = s.xs.length - 1;
    return {
      col: Math.round(s.xs[last]!) % this.width,
      row: Math.round(s.ys[last]!) % this.height,
    };
  }

  /**
   * Day the current or next purge begins. The cycle-level question, closed form.
   *
   * For a continuous blob a purge is always in progress, so this is the start of the
   * traverse `fromDay` is inside — which is still the useful answer, because it is what
   * "how far through this crossing are we" is measured from.
   */
  nextPurgeDay(fromDay: number): number {
    const { transitDays, phaseDays } = this.params;
    const period = this.traversePeriodDays;
    if (transitDays <= 0 || period <= 0) return Infinity;
    const into = mod(fromDay - phaseDays, period);
    return into < transitDays ? fromDay - into : fromDay - into + period;
  }

  /**
   * Where the beam is today and where it is going — everything a renderer needs, in one
   * pure call. `null` only when the beam is dormant, which a continuous blob never is.
   *
   * ★ THE POSITION IS THE ARC'S LAST SUB-CENTRE, IN `hexX` SPACE AND UNROUNDED, unlike
   * `position()`, which rounds to a tile for callers that want one. Rounding here would
   * put the drawn sun up to half a hex from the burned ground.
   */
  sighting(day: number): BeamSighting | null {
    const s = this.dayState(day);
    if (s === null) return null;
    const k = this.greatYearTraverses;
    const n = this.traverseIndex(day);
    const common = {
      key: this.key,
      shape: this.params.shape,
      radius: this.params.shape === 'band' ? this.params.widthCols : this.params.radiusHexes,
      focusRadius:
        this.params.shape === 'band' ? this.params.focusCols : this.params.focusRadiusHexes,
      traversePeriodDays: this.traversePeriodDays,
      greatYearTraverses: k,
      greatYearDays: this.greatYearDays,
      traverse: mod(n, k) + 1,
      intoTraverse: mod(day - this.params.phaseDays, Math.max(1, this.traversePeriodDays)),
      continuous: this.isContinuous,
    };
    if (s.shape === 'band') return { ...common, x: s.centre, row: -1 };
    const last = s.xs.length - 1;
    return { ...common, x: s.xs[last]!, row: s.ys[last]! };
  }

  /**
   * "How many days until the purge reaches my column?" — the question the API exists
   * to answer, and the reason forecasting is built on a pure schedule at all.
   *
   * This deliberately uses the base class's forward scan rather than a closed form.
   * A closed form has to re-derive where the band is, and it gets the two hard cases
   * wrong in opposite directions: the coverage window is cut in two by the torus seam
   * (so columns near the seam are hit at the instant a purge begins AND again when the
   * front comes round), and the centre advances in whole-day jumps of width/transit
   * columns (so a one-column-wide sliver of that window may never actually be sampled).
   * Both bugs were live here and both reported hundreds of days of false warning.
   * Scanning the real `affect` cannot drift from the simulation by construction, and
   * the cost is a few hundred arithmetic ops on an API call.
   *
   * The horizon is widened to one full cycle plus one transit. Under a BAND that is
   * provably enough for every column, because the band spans every row and its centre
   * visits every column once a transit.
   *
   * ★ UNDER A BLOB THE HORIZON MUST BE A GREAT YEAR, NOT A CYCLE, and that is the whole
   * of what precession changed here. A non-precessing blob's track is periodic per
   * traverse: it retraces exactly the same tiles every purge, forever, so a tile the
   * track misses is missed for the life of the world and `null` is not a failure to
   * answer but the correct answer. Measured on that geometry over a 40 × 24 sample of a
   * 240×144 world: at r=2, 682 of 960 tiles (71.0%) never got an arrival.
   *
   * With `greatYearTraverses` above 1 the track only repeats after K traverses, so a
   * horizon of one cycle would report "never" for most of the map purely because the
   * beam happened to be on a later traverse. `greatYearDays` is the shortest horizon
   * that can distinguish "not on this traverse" from "not ever", and it is therefore the
   * one this asks for. `Infinity` remains a real answer — a track with amplitude below
   * 1.0 still leaves whole latitudes structurally beam-free — so callers must still
   * render "never" rather than "unknown".
   */
  override forecast(
    col: number,
    row: number,
    fromDay: number,
    horizonDays: number = DEFAULT_FORECAST_HORIZON,
    view: WorldView = DETACHED_VIEW,
  ): CycleForecast | null {
    const { transitDays } = this.params;
    if (transitDays <= 0 || this.traversePeriodDays <= 0) return null;
    const need = Math.ceil(this.greatYearDays + transitDays) + 2;
    return super.forecast(col, row, fromDay, Math.max(horizonDays, need), view);
  }

  /**
   * Mean days between purges at a tile.
   *
   * ★ FOR A PRECESSING BLOB THIS IS THE GREAT YEAR, not the traverse period, and the
   * difference is the point of the design. A tile is not under the beam once per
   * traverse — the traverse mostly goes elsewhere — it is under the beam about once per
   * return of the track, which is what recovery time now means. Reporting the traverse
   * period here would understate a tile's recovery by a factor of K.
   */
  override expectedIntervalDays(): number {
    return this.params.shape === 'blob' ? this.greatYearDays : this.params.cycleDays;
  }

  /**
   * ★ `periodDays` IS THE GREAT YEAR FOR A BLOB. It is the cycle's "dominant repeat
   * time" and for a wandering sun that is when the whole sky repeats, not when one
   * crossing ends. GM-facing summaries quote this.
   */
  override describe(): CycleDescription {
    const { label, summary, flags } = this.catalogue;
    return {
      key: this.key,
      kind: this.kind,
      label,
      summary,
      periodDays: this.params.shape === 'blob' ? this.greatYearDays : this.params.cycleDays,
      flags,
      params: { ...this.params },
    };
  }
}

// ===========================================================================
// Seasons — the periodic global swing
// ===========================================================================

export interface SeasonsParams {
  /** Length of one full year. */
  periodDays: number;
  /** Peak heat swing, at the latitude where seasonality is strongest. */
  heatAmplitude: number;
  /** Peak moisture swing added to the diffusion target. */
  moistureAmplitude: number;
  /**
   * Quarter-turns the wet season lags the hot season. 1 = rain peaks a quarter-year
   * after peak heat (a late-summer monsoon-ish climate); 2 = wet winters.
   */
  moistureLagQuarters: number;
  /**
   * If true (default), seasonality is weakest at the hot band and strongest at the
   * cold band — the torus analogue of "tropics have no seasons, poles have savage
   * ones". If false, the swing is uniform, which suits an airless or tide-locked world.
   */
  latitudeWeighted: boolean;
  /** Fraction of the year's swing past which Heatwave / Freeze / Storm / Drought fire. */
  extremeThreshold: number;
  /**
   * Latitude weight below which no THERMAL extreme (Heatwave / Freeze) is raised. The
   * tropics get a mild temperature swing in the numbers but never a named hot or cold
   * season, which is correct: seasonality in temperature is a latitude phenomenon.
   *
   * It does NOT gate Storm / Drought — see `wetWeightFloor`. Gating the wet/dry season
   * on latitude too is the mistake this parameter used to make, and it silently
   * switched the seasons off exactly where the new drying ladder needs them: savanna,
   * desert and badlands all key off Heatwave / Drought / Storm, and `Rock -> Badlands`
   * and `Mountain -> Badlands` are gated on `Storm | Drought` outright. With a single
   * shared gate at 0.35, ~40% of rows centred on the equator got no seasonal
   * disturbance at all and badlands became a mid-latitude biome by accident.
   */
  extremeMinWeight: number;
  /**
   * Floor under the MOISTURE seasonality weight, independent of latitude.
   *
   * The tropics have no winter and a ferocious wet/dry cycle; that asymmetry is real
   * and it is what gives the equatorial belt its disturbance. 0 reproduces the old
   * behaviour (no tropical seasons at all); 1 makes the wet season globally uniform.
   */
  wetWeightFloor: number;
  /** Day of peak heat. Offsets one world's calendar from another's. */
  phaseDays: number;
}

const SEASONS_DEFAULTS: SeasonsParams = {
  periodDays: 360,
  /**
   * Weighted, so this is the swing AT THE COLD BAND and roughly half of it at the
   * mid-latitudes. Raised from 9 for a structural reason, not for flavour: at 9 the
   * cold-band sea never came within 10 degrees of the sea-ice thaw threshold in any
   * season, so every tile that froze stayed frozen forever and an eighth of the world
   * became immutable. A polar cap that advances and retreats needs a polar seasonal
   * amplitude, and 22 is what makes ICE_FORM (22) and ICE_THAW (28) both reachable.
   */
  heatAmplitude: 22,
  /**
   * ★ TINY ON PURPOSE. This is bug #1's cousin and it is easy to get wrong by a factor
   * of ten.
   *
   * `CycleEffect.moisture` is an additive push on the diffusion TARGET, and the
   * hydrology's retention sits at 0.9998 precisely so that moisture carries deep
   * inland without decaying (SIMULATION.md bug #1). The two facts together mean a
   * SUSTAINED, SPATIALLY BROAD push has a steady-state gain of roughly 1/(1-r) — on
   * temperate land, where the heat sink is near zero, that is enormous. Marsh
   * neighbours use the same channel at +2 each and are safe because they are rare and
   * local; a global seasonal term is not.
   *
   * Measured on a crucible world, average LAND moisture across one year:
   *
   *   amplitude 0  (baseline, geography only)   67.9 – 74.6
   *   amplitude 4  (this value, monsoon 10)     ~25  – ~99
   *   amplitude 10 (with a 26-strength monsoon)  2.4 – 99.9   ← desert belt gone
   *
   * At 10 the desert belt vanished for half of every year and the whole continent
   * alternated between bone-dry and saturated. The point of the 0.9998 retention is to
   * produce wet coasts and arid hearts FROM GEOGRAPHY; a global sinusoid with a gain of
   * thousands erases that geography twice a year.
   *
   * 4 is where a real wet/dry season survives — the drought half of the sinusoid is
   * what drives desert, badlands and barren, and dropping this to 1 made the world
   * uniformly forested and cost 0.04 of entropy — without the swing washing out the
   * map. Note the seasonal moisture swing that matters most comes for FREE and through
   * the correct channel: heat is a multiplicative decay on retention, so
   * `heatAmplitude` already dries the continental interiors every summer, bounded and
   * geographically shaped.
   */
  moistureAmplitude: 4,
  moistureLagQuarters: 2,
  latitudeWeighted: true,
  extremeThreshold: 0.72,
  extremeMinWeight: 0.35,
  wetWeightFloor: 0.55,
  phaseDays: 0,
};

interface SeasonState {
  /** -1..1, the heat phase of the year. */
  readonly heatPhase: number;
  /** -1..1, the moisture phase (lagged). */
  readonly moisturePhase: number;
}

/**
 * A slow global climate swing.
 *
 * The cheapest cycle in the set and, per unit of cost, one of the most valuable: it
 * makes every threshold in biomes.ts breathe. A tile parked just below the forest
 * moisture cut-off crosses it every year instead of never, which converts static
 * boundaries into migrating ones. It also composes usefully with everything else —
 * a purge landing in deep winter scours far less than one landing at peak summer,
 * with no interaction code written anywhere.
 *
 * Note that only HEAT is applied directly; the accompanying moisture swing comes both
 * from the explicit term and, larger, for free — heat is a multiplicative decay on
 * moisture retention inside World, so a hot season dries the continental interiors on
 * its own.
 */
export class Seasons extends WorldCycle<SeasonState> {
  readonly params: SeasonsParams;
  /** Per-row THERMAL seasonality weight, precomputed. Avoids a cos() per tile per day. */
  private weight = new Float32Array(0);
  /** Per-row MOISTURE seasonality weight — floored, so the tropics keep a wet season. */
  private wetWeight = new Float32Array(0);

  constructor(key = 'seasons', params: Partial<SeasonsParams> = {}) {
    super('seasons', key);
    this.params = { ...SEASONS_DEFAULTS, ...params };
  }

  protected override onBind(): void {
    this.weight = new Float32Array(this.height);
    this.wetWeight = new Float32Array(this.height);
    const floor = Math.max(0, Math.min(1, this.params.wetWeightFloor));
    for (let r = 0; r < this.height; r++) {
      // latitudeHeat is 26*cos(2*PI*r/H): row 0 is the hot band, row H/2 the cold one.
      // Thermal seasonality is the complement — flat at the equator, savage in the
      // cold band. Moisture seasonality is floored instead, because a wet/dry cycle at
      // the equator is not a weaker version of a polar winter, it is a different and
      // equally strong phenomenon.
      const w = this.params.latitudeWeighted
        ? (1 - Math.cos((2 * Math.PI * r) / this.height)) / 2
        : 1;
      this.weight[r] = w;
      this.wetWeight[r] = floor + (1 - floor) * w;
    }
  }

  dayState(day: number): SeasonState | null {
    const { periodDays, phaseDays, moistureLagQuarters } = this.params;
    if (periodDays <= 0) return null;
    const t = (day - phaseDays) / periodDays;
    return {
      heatPhase: Math.cos(2 * Math.PI * t),
      moisturePhase: Math.cos(2 * Math.PI * (t - moistureLagQuarters / 4)),
    };
  }

  affect(state: SeasonState, out: CycleEffect, _col: number, row: number): void {
    const w = this.weight[row]!;
    const { heatAmplitude, moistureAmplitude, extremeThreshold, extremeMinWeight } = this.params;
    // Wet/dry seasonality does not vanish at the equator the way thermal seasonality
    // does — the tropics have the strongest wet/dry cycle on any real world.
    const wWet = this.wetWeight[row]!;

    // ★ `ambientHeat`, NOT `heat`. A season is a months-long forcing that a coastline
    // may legitimately lag behind, and this is the only channel World's thermal filter
    // low-passes — so this one line is what actually delivers "the temperature changes
    // more slowly around water". The acute channel is for purges and eruptions, whose
    // whole effect is a single-day spike that a lag would erase.
    out.ambientHeat += heatAmplitude * w * state.heatPhase;
    out.moisture += moistureAmplitude * wWet * state.moisturePhase;

    // The named seasons are gated on latitude, not scaled by it. Multiplying the phase
    // by the weight and then testing a fixed threshold silently means "no tile outside
    // the cold band ever sees winter", which is not the same statement and is easy to
    // ship by accident.
    if (w >= extremeMinWeight) {
      if (state.heatPhase > extremeThreshold) out.flags |= CycleFlag.Heatwave;
      else if (state.heatPhase < -extremeThreshold) out.flags |= CycleFlag.Freeze;
    }

    // Storm and Drought are NOT gated on the thermal weight. That gate is what used to
    // leave the equatorial belt with no seasonal disturbance whatsoever, while the
    // savanna / desert / badlands rules that key off these flags all live there.
    if (wWet >= extremeMinWeight) {
      if (state.moisturePhase > extremeThreshold) out.flags |= CycleFlag.Storm;
      else if (state.moisturePhase < -extremeThreshold) out.flags |= CycleFlag.Drought;
    }
  }

  override expectedIntervalDays(): number {
    return this.params.periodDays;
  }

  protected override forecastLabel(flags: number): string {
    if (flags & CycleFlag.Freeze) return 'deep winter';
    if (flags & CycleFlag.Heatwave) return 'high summer';
    if (flags & CycleFlag.Storm) return 'the wet season';
    if (flags & CycleFlag.Drought) return 'the dry season';
    return 'the turning year';
  }

  override describe(): CycleDescription {
    const { label, summary, flags } = this.catalogue;
    return {
      key: this.key,
      kind: this.kind,
      label,
      summary,
      periodDays: this.params.periodDays,
      flags,
      params: { ...this.params },
    };
  }
}

// ===========================================================================
// Tectonics — fault lines, quakes, orogeny
// ===========================================================================

export interface TectonicsParams {
  /** Number of fault lines crossing the world. */
  faults: number;
  /** Mean days between quakes ON ONE FAULT. More faults = more quakes overall. */
  meanIntervalDays: number;
  /** How many days a quake sequence rumbles for. */
  durationDays: number;
  /** Half-width, in columns, of the shaken band either side of the fault. */
  shakeCols: number;
  /**
   * Half-width, in columns, of the ridge that can rise. Must be <= shakeCols.
   *
   * This is the parameter that decides whether a world HAS mountains. The first pass
   * shipped `ridgeCols: 2`, which is a four-column ribbon on a 240-column world: the
   * theoretical ceiling was ~1% of the map before erosion, measured 0.13-0.45%, and
   * granite/silver/skyquartz were unobtainable in every one of 96 regions — a material
   * family that existed in the taxonomy and nowhere in the world. A range needs a
   * province-sized footprint, not a seam.
   */
  ridgeCols: number;
  /** Half-length, in rows, of the rupture at magnitude 1. */
  reachRows: number;
  /**
   * Magnitude above which the ridge uplifts rather than merely shaking, AT THE FAULT.
   * The requirement scales up with distance from the fault (see `affect`), so the
   * ridge has a soft edge: every quake lifts the core, only the large ones lift the
   * flanks. That is what makes a range taper instead of ending in a cliff.
   */
  upliftThreshold: number;
}

const TECTONICS_DEFAULTS: TectonicsParams = {
  faults: 4,
  meanIntervalDays: 140,
  durationDays: 4,
  shakeCols: 12,
  ridgeCols: 8,
  reachRows: 34,
  upliftThreshold: 0.45,
};

interface Fault {
  /** Column of the fault at row 0. */
  readonly c0: number;
  /** Columns of drift per row. Chosen so the fault closes on itself across the wrap. */
  readonly slope: number;
}

interface Quake {
  readonly fault: number;
  readonly epicentreRow: number;
  /** 0..1. */
  readonly magnitude: number;
  readonly reach: number;
}

interface TectonicState {
  readonly quakes: readonly Quake[];
}

/**
 * Faults are permanent geography; quakes are Poisson events along them.
 *
 * This is the orogeny the prototype lacked — SIMULATION.md notes rock sat at 4-5% and
 * only ever weathered, with nowhere for new stone to come from. Uplift on the ridge
 * gives rock/basalt/badlands a door to mountain, and mountain then erodes back down,
 * which closes a loop instead of adding another sink.
 *
 * It is also glass's most important exit. Glass shattering back to sand under `Quake`
 * is what turns a purge scar from a graveyard into an intermediate state: beam makes
 * glass, quake makes sand, water makes soil, soil makes forest.
 *
 * Fault geometry closes across the torus by construction: slope is an integer multiple
 * of width/height, so advancing `height` rows advances a whole number of widths and the
 * line meets itself at the seam. No seam special case, same as everything else here.
 */
export class Tectonics extends WorldCycle<TectonicState> {
  readonly params: TectonicsParams;
  private faultLines: Fault[] = [];

  constructor(key = 'tectonics', params: Partial<TectonicsParams> = {}) {
    super('tectonics', key);
    this.params = { ...TECTONICS_DEFAULTS, ...params };
  }

  protected override onBind(): void {
    this.faultLines = [];
    const unit = this.width / this.height;
    for (let f = 0; f < this.params.faults; f++) {
      const c0 = Math.floor(rollAt(this.stream, 0xfa, f) * this.width);
      // k in {-2,-1,1,2}: never 0, so faults always cross latitudes and no fault is a
      // pure meridian that could sit permanently under the beam's path.
      const k = [-2, -1, 1, 2][Math.floor(rollAt(this.stream, 0xfb, f) * 4)]!;
      this.faultLines.push({ c0, slope: k * unit });
    }
  }

  /** Column of fault `f` at a given row. */
  private faultCol(f: Fault, row: number): number {
    return mod(f.c0 + f.slope * row, this.width);
  }

  dayState(day: number): TectonicState | null {
    const { meanIntervalDays, durationDays, reachRows } = this.params;
    if (this.faultLines.length === 0 || meanIntervalDays <= 0) return null;

    const p = Math.min(0.9, EPOCH_DAYS / meanIntervalDays);
    const epoch = Math.floor(day / EPOCH_DAYS);
    let quakes: Quake[] | null = null;

    // Look back far enough that an event which began in an earlier epoch is still
    // seen today. One epoch back is enough for the default 4-day rupture; a GM who
    // asks for a 200-day rupture sequence gets one, rather than a silently clipped
    // 64-day one. See epochLookback.
    for (let e = epoch - epochLookback(durationDays); e <= epoch; e++) {
      for (let f = 0; f < this.faultLines.length; f++) {
        if (epochRoll(this.stream, e, f, 1) >= p) continue;
        const start = e * EPOCH_DAYS + Math.floor(epochRoll(this.stream, e, f, 2) * EPOCH_DAYS);
        if (day < start || day >= start + durationDays) continue;
        const magnitude = epochRoll(this.stream, e, f, 3);
        const epicentreRow = Math.floor(epochRoll(this.stream, e, f, 4) * this.height);
        (quakes ??= []).push({
          fault: f,
          epicentreRow,
          magnitude,
          reach: reachRows * (0.4 + magnitude),
        });
      }
    }
    return quakes === null ? null : { quakes };
  }

  affect(state: TectonicState, out: CycleEffect, col: number, row: number): void {
    const { shakeCols, ridgeCols, upliftThreshold } = this.params;
    for (let q = 0; q < state.quakes.length; q++) {
      const quake = state.quakes[q]!;
      const dRow = Math.abs(wrapDelta(row - quake.epicentreRow, this.height));
      if (dRow > quake.reach) continue;
      const line = this.faultLines[quake.fault]!;
      const dCol = Math.abs(wrapDelta(col - this.faultCol(line, row), this.width));
      if (dCol > shakeCols) continue;

      out.flags |= CycleFlag.Quake;
      if (dCol <= ridgeCols) {
        // Soft-edged ridge: the magnitude a quake needs in order to lift ground rises
        // linearly with distance from the fault, from `upliftThreshold` at the fault
        // to double that at the ridge margin. A hard `dCol <= ridgeCols` test gives a
        // range with vertical sides and a uniform interior; this gives one with a core
        // that rises on almost every rupture and flanks that rise only on the big ones,
        // which is both the real mechanism and a far more legible map.
        const need = upliftThreshold * (1 + (ridgeCols === 0 ? 0 : dCol / ridgeCols));
        if (quake.magnitude >= need) {
          out.flags |= CycleFlag.Uplift;
          // Rising ground is cooler ground. Small, and nothing like an albedo loop —
          // it is transient and applies to a narrow ribbon for a few days.
          out.heat -= 4 * quake.magnitude;
        }
      }
    }
  }

  /** Distance in columns from a tile to the nearest fault. Useful for worldgen too. */
  faultDistance(col: number, row: number): number {
    let best = Infinity;
    for (const f of this.faultLines) {
      const d = Math.abs(wrapDelta(col - this.faultCol(f, row), this.width));
      if (d < best) best = d;
    }
    return best;
  }

  override expectedIntervalDays(col: number, row: number): number {
    const { meanIntervalDays, shakeCols, reachRows } = this.params;
    if (this.faultDistance(col, row) > shakeCols) return Infinity;
    // Only the share of ruptures whose epicentre lands within reach of this row.
    // Mean reach is reachRows * (0.4 + E[magnitude]) = reachRows * 0.9.
    const rowShare = Math.min(1, (2 * reachRows * 0.9) / this.height);
    return meanIntervalDays / Math.max(1e-6, rowShare);
  }

  protected override get announced(): boolean {
    return false;
  }

  protected override forecastLabel(flags: number): string {
    return flags & CycleFlag.Uplift ? 'the mountains rise' : 'the ground shakes';
  }

  override describe(): CycleDescription {
    const { label, summary, flags } = this.catalogue;
    return {
      key: this.key,
      kind: this.kind,
      label,
      summary,
      periodDays: this.params.meanIntervalDays,
      flags,
      params: { ...this.params },
    };
  }
}

// ===========================================================================
// Volcanism — vents, lava, ashfall
// ===========================================================================

export interface VolcanismParams {
  /** Number of vents scattered across the world. */
  vents: number;
  /** Mean days between eruptions AT ONE VENT. */
  meanIntervalDays: number;
  /** How long an eruption runs. Any length; the scheduler looks back far enough. */
  durationDays: number;
  /** Radius, in tiles, of the lava field at magnitude 1. Raises Focus + Eruption. */
  lavaRadius: number;
  /** Radius, in tiles, of the ash plume. Raises Ashfall. */
  ashRadius: number;
  /** Heat added at the vent mouth. Must clear the melting point on its own. */
  ventHeat: number;
  /** Heat added at the edge of the ash plume. */
  plumeHeat: number;
}

/**
 * Sized from throughput, not from taste.
 *
 * Lava, ash and fertile soil are all FLOWS with dwell times of days, so their standing
 * share of the world is (production rate x lifetime) and production rate is the vent
 * duty cycle times the affected area — nothing else. The first pass shipped 5 vents,
 * a 200-day interval, a 6-day eruption and a 3.5-tile lava radius, which multiplies out
 * to roughly 6 tiles of lava on a 240x144 world: measured 0.02% lava, 0.01% ash and
 * 0.01% soil on a preset whose entire identity is volcanism. A cycle a GM switched on
 * deliberately has to be visible on the map.
 *
 * The numbers below give ~0.6% of the world under ashfall at any moment, which is what
 * makes basalt and soil real provinces rather than rounding errors. Note this is safe
 * to scale in a way the albedo constant is not: vent heat is externally scheduled and
 * has no dependence on what the surrounding tiles became, so it cannot amplify itself.
 */
const VOLCANISM_DEFAULTS: VolcanismParams = {
  vents: 10,
  meanIntervalDays: 110,
  durationDays: 9,
  lavaRadius: 5,
  ashRadius: 14,
  ventHeat: 95,
  plumeHeat: 6,
};

interface Eruption {
  readonly vent: number;
  readonly magnitude: number;
  readonly lavaR: number;
  readonly ashR: number;
}

interface VolcanicState {
  readonly eruptions: readonly Eruption[];
}

/**
 * Vents that erupt, lava that cools, soil that grows forests.
 *
 * Volcanism is the cycle that most directly makes a world MORE alive rather than less,
 * because its output is fertile: lava cools to basalt when dry and to soil when wet,
 * ash settles to soil above moisture 38, and soil is a flow rather than a stock — it
 * becomes grassland in weeks and forest not long after. A volcanic world should show
 * measurably higher churn AND higher living share than a quiet one.
 *
 * Vent heat is a genuine heat term, not an albedo term. The +1.2 albedo cap exists
 * because desert and glass raise their NEIGHBOURS' heat permanently, which feeds back
 * into more desert and more glass — a self-amplifying loop that sterilised the world at
 * +2.5. A vent is the opposite shape: large, but transient and externally scheduled,
 * with no dependence on what the surrounding tiles became. It cannot run away.
 */
export class Volcanism extends WorldCycle<VolcanicState> {
  readonly params: VolcanismParams;
  private ventCols: Int32Array = new Int32Array(0);
  private ventRows: Int32Array = new Int32Array(0);

  constructor(key = 'volcanism', params: Partial<VolcanismParams> = {}) {
    super('volcanism', key);
    this.params = { ...VOLCANISM_DEFAULTS, ...params };
  }

  protected override onBind(): void {
    const n = this.params.vents;
    this.ventCols = new Int32Array(n);
    this.ventRows = new Int32Array(n);
    for (let v = 0; v < n; v++) {
      this.ventCols[v] = Math.floor(rollAt(this.stream, 0x0e, v) * this.width);
      this.ventRows[v] = Math.floor(rollAt(this.stream, 0x0f, v) * this.height);
    }
  }

  /** Vent sites, for worldgen seeding and for the map render. */
  ventSites(): { col: number; row: number }[] {
    return Array.from(this.ventCols, (c, v) => ({ col: c, row: this.ventRows[v]! }));
  }

  dayState(day: number): VolcanicState | null {
    const { meanIntervalDays, durationDays, lavaRadius, ashRadius, vents } = this.params;
    if (vents === 0 || meanIntervalDays <= 0) return null;

    const p = Math.min(0.9, EPOCH_DAYS / meanIntervalDays);
    const epoch = Math.floor(day / EPOCH_DAYS);
    let eruptions: Eruption[] | null = null;

    for (let e = epoch - epochLookback(durationDays); e <= epoch; e++) {
      for (let v = 0; v < vents; v++) {
        if (epochRoll(this.stream, e, v, 11) >= p) continue;
        const start = e * EPOCH_DAYS + Math.floor(epochRoll(this.stream, e, v, 12) * EPOCH_DAYS);
        if (day < start || day >= start + durationDays) continue;
        const magnitude = 0.35 + 0.65 * epochRoll(this.stream, e, v, 13);
        (eruptions ??= []).push({
          vent: v,
          magnitude,
          lavaR: lavaRadius * magnitude,
          ashR: ashRadius * magnitude,
        });
      }
    }
    return eruptions === null ? null : { eruptions };
  }

  affect(state: VolcanicState, out: CycleEffect, col: number, row: number): void {
    const { ventHeat, plumeHeat } = this.params;
    for (let i = 0; i < state.eruptions.length; i++) {
      const er = state.eruptions[i]!;
      const dc = wrapDelta(col - this.ventCols[er.vent]!, this.width);
      const dr = wrapDelta(row - this.ventRows[er.vent]!, this.height);
      // Squared distance: no sqrt on the hot path.
      const d2 = dc * dc + dr * dr;
      const ash2 = er.ashR * er.ashR;
      if (d2 > ash2) continue;

      const lava2 = er.lavaR * er.lavaR;
      if (d2 <= lava2) {
        // Falls off to the plume value at the lava field's edge, so there is no cliff
        // between "melting" and "merely warm".
        const t = lava2 === 0 ? 0 : d2 / lava2;
        out.heat += plumeHeat + (ventHeat - plumeHeat) * (1 - t);
        out.flags |= CycleFlag.Eruption | CycleFlag.Focus;
      } else {
        const t = (d2 - lava2) / Math.max(1e-6, ash2 - lava2);
        out.heat += plumeHeat * (1 - t);
        out.flags |= CycleFlag.Ashfall;
        // A plume shades and rains grit; a little moisture, not a monsoon. Kept below
        // 1 for the diffusion-gain reason documented on SeasonsParams.moistureAmplitude
        // — a plume is broad and lasts days, which is exactly the shape that compounds.
        out.moisture += 0.8 * (1 - t);
      }
    }
  }

  override expectedIntervalDays(col: number, row: number): number {
    const { meanIntervalDays, ashRadius, vents } = this.params;
    let best = Infinity;
    for (let v = 0; v < vents; v++) {
      const dc = wrapDelta(col - this.ventCols[v]!, this.width);
      const dr = wrapDelta(row - this.ventRows[v]!, this.height);
      const d = Math.sqrt(dc * dc + dr * dr);
      if (d <= ashRadius && meanIntervalDays < best) best = meanIntervalDays;
    }
    return best;
  }

  protected override get announced(): boolean {
    return false;
  }

  protected override forecastLabel(flags: number): string {
    return flags & CycleFlag.Eruption ? 'the mountain opens' : 'ashfall';
  }

  override describe(): CycleDescription {
    const { label, summary, flags } = this.catalogue;
    return {
      key: this.key,
      kind: this.kind,
      label,
      summary,
      periodDays: this.params.meanIntervalDays,
      flags,
      params: { ...this.params },
    };
  }
}

// ===========================================================================
// Monsoon — the regional moisture surge
// ===========================================================================

export interface MonsoonParams {
  /** Days between one monsoon and the next. */
  periodDays: number;
  /** Days the front spends crossing, per period. The rest of the period is dry. */
  transitDays: number;
  /** Row the front starts from. */
  startRow: number;
  /**
   * Rows the front travels during its transit. 0 means "the whole world".
   *
   * It used to default to half the world, on the reasoning that a monsoon runs from
   * the hot band to the cold band. On a sphere that is a hemisphere; on a TORUS it is
   * a band that stops in the middle of nowhere and never comes back, because a torus
   * has no hemispheres. Measured over 10 game-years, 56 of 144 rows were never rained
   * on once — an eighth of the world permanently outside the rain cycle, which is a
   * disturbance hole and not a climate. The front now closes on itself.
   */
  travelRows: number;
  /** Half-height of the rain band, in rows. */
  bandRows: number;
  /** Moisture added at the centre of the band. */
  moisture: number;
  /** Heat removed under cloud cover. Small — this is shade, not winter. */
  heatDrop: number;
  /** Fraction of peak moisture past which Storm is raised. */
  stormThreshold: number;
  phaseDays: number;
}

const MONSOON_DEFAULTS: MonsoonParams = {
  periodDays: 360,
  transitDays: 45,
  startRow: 0,
  travelRows: 0, // 0 = the full torus, resolved at bind time
  bandRows: 9,
  /**
   * Small for the same reason SeasonsParams.moistureAmplitude is small: this is an
   * additive push on a diffusion target whose retention is 0.9998, so its gain is
   * ~1/(1-r) and a value in the tens saturates every land tile the band passes over.
   * At the 26 this shipped with, a monsoon did not water a region — it flooded the
   * planet. A meaningful share of the front's effect is carried by `heatDrop` instead,
   * which is both physically right (cloud cover shades; shade raises retention) and
   * inherently bounded, because retention cannot exceed 1.
   */
  moisture: 10,
  /** Cloud cover. Half the monsoon's real channel: cooler ground holds its moisture. */
  heatDrop: 6,
  stormThreshold: 0.55,
  phaseDays: 120,
};

interface MonsoonState {
  readonly centreRow: number;
}

/**
 * A rain front that migrates across latitudes.
 *
 * Deliberately the ROW-wise counterpart to the beam's COLUMN-wise sweep. Two fronts
 * moving on perpendicular axes give the map a genuine two-dimensional weather history
 * instead of banding, and it means the introspection question generalises exactly as
 * required: the beam answers "days until the purge reaches this column", the monsoon
 * answers "days until the rains reach this row", through the same interface.
 *
 * Mechanically this is the counterweight to desertification. The albedo feedback is
 * capped at +1.2 because it self-amplifies; a monsoon is an un-amplifiable external
 * push in the opposite direction, so a world with strong monsoons can safely carry a
 * harsher beam than one without. That trade is the GM's difficulty dial.
 */
export class Monsoon extends WorldCycle<MonsoonState> {
  readonly params: MonsoonParams;
  private travel = 0;

  constructor(key = 'monsoon', params: Partial<MonsoonParams> = {}) {
    super('monsoon', key);
    this.params = { ...MONSOON_DEFAULTS, ...params };
  }

  protected override onBind(): void {
    // The full torus by default: a front that only crosses half of a wrapping world
    // leaves the other half permanently dry. See MonsoonParams.travelRows.
    this.travel = this.params.travelRows || this.height;
  }

  active(day: number): boolean {
    const { periodDays, transitDays, phaseDays } = this.params;
    if (periodDays <= 0 || transitDays <= 0) return false;
    return mod(day - phaseDays, periodDays) < transitDays;
  }

  dayState(day: number): MonsoonState | null {
    if (!this.active(day)) return null;
    const { periodDays, transitDays, phaseDays, startRow } = this.params;
    const progress = mod(day - phaseDays, periodDays) / transitDays;
    return { centreRow: mod(startRow + progress * this.travel, this.height) };
  }

  affect(state: MonsoonState, out: CycleEffect, _col: number, row: number): void {
    const { bandRows, moisture, heatDrop, stormThreshold } = this.params;
    const d = Math.abs(wrapDelta(row - state.centreRow, this.height));
    if (d >= bandRows) return;
    const intensity = 1 - d / bandRows;
    out.moisture += moisture * intensity;
    out.heat -= heatDrop * intensity;
    if (intensity >= stormThreshold) out.flags |= CycleFlag.Storm;
  }

  override expectedIntervalDays(): number {
    return this.params.periodDays;
  }

  protected override forecastLabel(): string {
    return 'the rains';
  }

  override describe(): CycleDescription {
    const { label, summary, flags } = this.catalogue;
    return {
      key: this.key,
      kind: this.kind,
      label,
      summary,
      periodDays: this.params.periodDays,
      flags,
      params: { ...this.params },
    };
  }
}

// ===========================================================================
// Weather — storms that travel, morph against the ground, and die
// ===========================================================================

/**
 * ★ THE MOISTURE BUDGET: `peak moisture × radius² ≤ 300`.
 *
 * `CycleEffect.moisture` is an additive push on a diffusion target whose retention is
 * 0.9998 (`world.ts`), so a sustained, spatially broad push has a steady-state gain of
 * roughly 1/(1-r) — enormous on temperate land. This is the mistake that produced
 * `Seasons.moistureAmplitude`'s warning (at 10 the desert belt vanished for half of
 * every year) and `Monsoon.moisture`'s (at 26 a monsoon did not water a region, it
 * flooded the planet), and a storm is the same shape of push with a smaller footprint.
 *
 * The ok/over boundary was measured between M·R² = 343 and 384, across three independent
 * radii, against `still` land-moisture mean 67.1 and monsoon-only 78.4:
 *
 *     R=7  M=7   343   land mean 77.6   ok
 *     R=7  M=8   392   land mean 78.7   OVER
 *     R=14 M=1   196   land mean 74.1   ok
 *     R=14 M=2   392   land mean 79.2   OVER
 *     R=28 M=1   784   land mean 85.0   OVER
 *
 * BREADTH DOMINATES STRENGTH — doubling the radius costs four times the budget — which
 * is why the ceiling is on the product and not on either number. 300 is the largest
 * round figure inside the measured boundary.
 *
 * Enforced in `Weather.onBind`, not merely documented, because it is a constraint on a
 * PAIR of parameters and a per-parameter min/max cannot express it: R=14, M=1 is legal
 * and R=14, M=2 is not.
 */
export const WEATHER_MOISTURE_BUDGET = 300;

/** Ceiling on sub-centres per day for a storm's arc. See `trackSubsteps`. */
const WEATHER_MAX_SUBSTEPS = 512;

/**
 * Probe points sampled under the track, per day of a storm's life, as offsets in
 * (column, row) scaled by `sampleSpread`.
 *
 * Seven: the centre and a ring of six. Deliberately a FIXED set that does not depend on
 * the storm's current type — the type is derived from what these probes see, so a
 * type-dependent probe geometry would be a classifier reading its own output.
 */
const WEATHER_PROBES: readonly (readonly [number, number])[] = [
  [0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, -1], [-1, 1],
];

export interface WeatherParams {
  /**
   * Concurrent storm TRACKS. Each one rolls independently, per epoch, whether it
   * carries a storm — so this is the population size, not the storm count.
   */
  storms: number;
  /** Mean days between storms ON ONE TRACK. */
  meanIntervalDays: number;
  /** Mean days a storm lives. Actual lives run 0.6× to 1.4× this. */
  durationDays: number;
  /**
   * Radius of a RAIN disc, in hex rings. Every other type is this scaled by a fixed
   * factor (see `STORM_PROFILES`) — a gale is broader than a rain cell and a rain cell
   * is the one that carries moisture, which is what the budget above is about.
   */
  radiusHexes: number;
  /**
   * ★ THE LOOKBACK, IN DAYS, AND THE WHOLE ARCHITECTURE RESTS ON IT.
   *
   * A storm's type is a function of the terrain under the last K days of its track,
   * sampled from the grid AS IT IS TODAY. Nothing is accumulated: the storm's entire
   * condition is recomputable from (seed, day, world-now), which is what lets a freshly
   * bound cycle handed only the day-N grid reproduce the live simulation exactly.
   *
   * An accumulator was measured and is unimplementable against this contract — a cold
   * resolver never converges on a day-by-day one (max |Δwetness| 0.045 → 0.256 with NO
   * decay in K). What K buys is REACH, not compute, and the reach is stated at the
   * SHIPPED K because that is the only one any preset runs: at K=12, 160×96 `garden`,
   * 600 days, the oldest day still inside the window sits a mean 50.9 tiles from today's
   * centre and the furthest of its seven probes 56.3 — better than a third of the world's
   * width, i.e. a storm's type is decided by ground it left a region or two ago. Raising
   * it to 20 stretches those to 61.1 and 69.2.
   */
  lookbackDays: number;
  /** Spread of the seven terrain probes, in hexes from the track centre. */
  sampleSpread: number;
  /** Water fraction under the lookback at or above which a storm is a DOWNPOUR. */
  wetHeavyRain: number;
  /** ... at or above which it RAINS. */
  wetRain: number;
  /** ... at or above which it is HEAVY CLOUD. */
  wetHeavyCloud: number;
  /** ... at or above which it is CLOUD. Below it the storm has dried into wind. */
  wetCloud: number;
  /** ... below which the wind is a GALE. Nothing wet has been under it for a while. */
  wetWind: number;
  /**
   * Fraction of the seven probes that must be stone or lava for a day to count as
   * lethal. "The storm dies completely when passing another terrain."
   */
  deathFraction: number;
  /**
   * Consecutive lethal days that kill a storm outright. Death is DERIVED from the same
   * bounded lookback rather than stored: an absorbing `alive` flag cannot be inferred
   * from a grid, and one was measured wrong for 2 of 3 storms at small K. Once the run
   * is complete the storm is gone for the rest of its life, because the scan runs from
   * the storm's birth and its life is bounded.
   */
  deathDays: number;
  /** PEAK moisture at the centre of a downpour. See `WEATHER_MOISTURE_BUDGET`. */
  rainMoisture: number;
  /** Heat removed at the centre of a rain or cloud disc. Shade, not winter. */
  cloudHeatDrop: number;
  /** Whole sine cycles per traverse. A storm rolls 1..this many. */
  oscillations: number;
  /** Amplitude of the sinusoidal track, as a fraction of `height / 2`. */
  amplitudeHalfHeights: number;
  /** Offsets the whole storm calendar. Two weather cycles can be out of phase. */
  phaseDays: number;
}

/**
 * ★ THESE NUMBERS ARE MEASURED, NOT CHOSEN. The wet thresholds are set against a world
 * whose sea share is 22–24% (22.2% `still`, 22.4% `garden`, 24.2% `crucible` at day 1500
 * on this tree), so a storm sitting over open water reads 1.0, one working a coastline
 * reads ~0.4, and one over a continental interior reads 0. The rain shares that produces
 * are on `CYCLE_CATALOGUE`'s weather entry; spec `2915cb06-4`'s table is the same
 * measurement taken before rivers existed.
 */
const WEATHER_DEFAULTS: WeatherParams = {
  storms: 6,
  meanIntervalDays: 90,
  durationDays: 40,
  radiusHexes: 7,
  lookbackDays: 12,
  sampleSpread: 4,
  wetHeavyRain: 0.55,
  wetRain: 0.3,
  wetHeavyCloud: 0.14,
  wetCloud: 0.05,
  wetWind: 0.01,
  /**
   * ★ 3 OF THE 7 PROBES, FOR 2 CONSECUTIVE DAYS, AND BOTH NUMBERS ARE MEASURED.
   * Mortality as a share of scheduled storm-days, `garden`, 160×96, 1000 days,
   * RE-MEASURED on this tree (rivers moved every one of these; see below):
   *
   *     fraction 0.60 / 3 days   0.0%       0.60 / 2 days    0.0%
   *     fraction 0.45 / 3 days   0.0%       0.45 / 2 days    0.9%
   *     fraction 0.30 / 3 days   0.6%       0.30 / 2 days    5.3%
   *     fraction 0.15 / 3 days   6.3%       0.15 / 2 days   18.8%
   *
   * At 0.45 and above, five of seven probes must land on hard ground at once and no
   * world produces a mass that solid — storms essentially never die. What 0.30/2 buys is
   * a death rate that reads the WORLD rather than the parameter. Measured at these
   * defaults over 1500 days: `still` kills 0.3% of storm-days, `garden` (fault ridges)
   * 5.1%, and `crucible` (beam scars, basalt fields, live lava) 23.7%, against hard
   * ground of 0.4% / 3.9% / 8.2% of the map at day 1500. Storms die where the world is
   * hard, which is the whole fiction, and no line of code says so.
   *
   * ★ THE WHOLE TABLE FELL WHEN SPEC 5 LANDED, AND THAT IS THE POINT OF IT BEING A
   * READING. Spec 4 measured 10.2% at 0.30/2 and 9.2% on `garden` at 1500 days on the
   * 22-biome tree; the same runs on this one give 5.3% and 5.1%. Nothing about the
   * mechanism moved — the ordering across presets, the cliff above 0.45 and the
   * world-reading property all reproduce — and `still` and `crucible` barely shifted at
   * all (0.3% and 24.8% → 23.7%). What moved is the world `garden` grows, which is
   * exactly the kind of thing a spec is allowed to move and this comment is not allowed
   * to keep quoting from a tree that no longer exists.
   */
  deathFraction: 0.3,
  deathDays: 2,
  /**
   * 6 at radius 7 is M·R² = 294, just inside the 300 ceiling — the same order as
   * `Monsoon.moisture` (10) and `Seasons.moistureAmplitude` (4), and for the same
   * reason. A rain disc at 10 and radius 28 reached a land-moisture mean of 97.0 and
   * reproduced the desert-belt failure exactly.
   */
  rainMoisture: 6,
  cloudHeatDrop: 5,
  oscillations: 3,
  amplitudeHalfHeights: 0.7,
  phaseDays: 0,
};

/** The six types a storm can be, in ladder order from wettest to driest. */
type StormType = 'heavyrain' | 'rain' | 'heavycloud' | 'cloud' | 'wind' | 'heavywind';

interface StormProfile {
  /** Radius, as a multiple of `radiusHexes`. A rain cell is tight; a gale is broad. */
  readonly radiusScale: number;
  /** Peak moisture, as a fraction of `rainMoisture`. */
  readonly moistureScale: number;
  /**
   * Peak heat DROP, as a fraction of `cloudHeatDrop`. Always ≥ 0 — cloud and rain shade
   * the ground and nothing here warms it.
   *
   * ★ WIND IS 0 AND MUST STAY 0. Wind as a heat term is a whole new climate channel and
   * it is explicitly out of scope; what wind does is dry and abrade, through
   * `dryingBoost` in `biomes.ts`, which is the existing idiom for exactly that.
   */
  readonly heatScale: number;
  readonly flags: number;
  readonly label: string;
}

/**
 * ★ A HEAVY TYPE ALWAYS RAISES ITS LIGHT PARTNER, and heavy rain also raises `Storm`.
 * That is what lets every rule that already means "a downpour is happening" keep working
 * unchanged, and it is why nothing in `biomes.ts` has to test for a pair of flags.
 */
const STORM_PROFILES: Readonly<Record<StormType, StormProfile>> = {
  heavyrain: {
    radiusScale: 1,
    moistureScale: 1,
    heatScale: 1,
    flags: CycleFlag.Rain | CycleFlag.HeavyRain | CycleFlag.Storm,
    label: 'a downpour',
  },
  rain: {
    radiusScale: 0.85,
    moistureScale: 0.5,
    heatScale: 0.6,
    flags: CycleFlag.Rain,
    label: 'rain',
  },
  heavycloud: {
    radiusScale: 1.4,
    moistureScale: 0,
    heatScale: 1,
    flags: CycleFlag.Cloud | CycleFlag.HeavyCloud,
    label: 'heavy overcast',
  },
  cloud: {
    radiusScale: 1.15,
    moistureScale: 0,
    heatScale: 0.5,
    flags: CycleFlag.Cloud,
    label: 'cloud',
  },
  wind: {
    radiusScale: 1.3,
    moistureScale: 0,
    heatScale: 0,
    flags: CycleFlag.Wind,
    label: 'wind',
  },
  heavywind: {
    radiusScale: 1.6,
    moistureScale: 0,
    heatScale: 0,
    flags: CycleFlag.Wind | CycleFlag.HeavyWind,
    label: 'a gale',
  },
};

const STORM_LADDER: readonly StormType[] = [
  'heavyrain', 'rain', 'heavycloud', 'cloud', 'wind', 'heavywind',
];

/** One storm resolved for one day: the arc it sweeps and what it is doing. */
interface Storm extends SweptArc {
  readonly radius: number;
  readonly moisture: number;
  readonly heatDrop: number;
  readonly flags: number;
  /** Water fraction under the lookback that produced this type. For diagnostics. */
  readonly wetness: number;
}

interface WeatherState {
  readonly storms: readonly Storm[];
}

/**
 * A small population of storms, each a disc on a sinusoid whose TYPE, RADIUS and
 * SURVIVAL are functions of the terrain it has crossed.
 *
 * ---------------------------------------------------------------------------
 * ★ THIS IS THE FIRST CYCLE THAT READS THE WORLD, AND WHAT THAT COSTS
 * ---------------------------------------------------------------------------
 * `cycles.ts`'s contract says a cycle is a pure function of (worldSeed, key, day), and
 * defends it with lazy fast-forwarding of unobserved regions. `ARCHITECTURE.md` decision
 * 10.1 already abandoned that property for terrain, so the price was paid before this
 * cycle existed — but a world with weather in its cycle set genuinely cannot have a
 * region resolved on contact without stepping it. `readsWorld` is how a caller finds
 * out; see decision `0015`.
 *
 * What survives, and it is the whole design, is **bounded lookback over the current
 * grid**. The storm's TRACK is a pure function of seed and day. Its TYPE is derived by
 * sampling the grid under the last K days of that pure track. Its DEATH is derived by
 * scanning its own bounded life for a run of lethal days. There is no accumulated state
 * anywhere, so the storm's whole condition is recomputable from (seed, day, world-now) —
 * which is why a freshly bound cycle handed only the day-N grid reproduces the live
 * simulation's storms exactly rather than approximately.
 *
 * ---------------------------------------------------------------------------
 * ★ WHAT `forecast()` MAY PROMISE
 * ---------------------------------------------------------------------------
 * WHEN is fact and WHAT is a projection, and the split is structural rather than lucky:
 * the storm population, its schedule and its track are pure functions of (seed, day), so
 * the only thing that can move an arrival is a storm dying before it gets there — which
 * shows up as an arrival that never happens, never as one on the wrong day.
 *
 * MEASURED ON THIS TREE — re-run after spec 5, because the grid these forecasts project
 * from is the grid rivers changed. 400 tiles on a 20×20 lattice over a 160×96 world,
 * forecasting at day 300 over a 150-day horizon against the day-300 grid frozen, then
 * simulating those 150 days:
 *
 *                                garden+weather      crucible+weather
 *     predicted a hit, got one        395                  395
 *     predicted a hit, none came        0  (0.0%)            0  (0.0%)
 *     predicted nothing, hit came       0                    0
 *     ARRIVAL DAY exact             395/395 (100%)       395/395 (100%)
 *     FLAGS exact                   386/395 (97.7%)      394/395 (99.7%)
 *     mean lead time                 38.5 d               38.4 d
 *
 * ★ THE ERROR IS ALL IN THE LONG LEADS, WHICH IS EXACTLY WHERE A PROJECTION SHOULD FAIL.
 * Split by lead time on `garden`: at 0–9 days 93/93 flags exact, at 10–29 days 111/111,
 * and at 30–149 days 182/191 (95.3%). A forecast a week out is effectively a fact; one
 * two months out is a guess about terrain that has not happened yet. `basis` reports
 * `projected` for all of them and the API layer should surface that rather than implying
 * a precision that only the near end has.
 *
 * (The spec predicted 99.2% / 92.3% / 9.6% from the prototype. WHEN came out better and
 * so did WHAT; the no-show rate came out far lower because the shipped storm population
 * is dense enough that the mean lead is 38 days rather than the horizon, and most
 * forecast storms simply do not live long enough to die first. The conclusion the
 * prototype's numbers supported — over-promises, never under-promises — reproduces
 * exactly: zero unpredicted arrivals on both presets.)
 */
export class Weather extends WorldCycle<WeatherState> {
  readonly params: WeatherParams;
  /** Probe offsets pre-scaled by `sampleSpread`, so the lookback allocates nothing. */
  private probeCols = new Int32Array(0);
  private probeRows = new Int32Array(0);
  /** Per-type radius, rounded, and clamped to what the torus can hold. */
  private radii = new Float64Array(STORM_LADDER.length);
  private maxRadius = 0;
  /** Probes that must be lethal for a day to count against a storm's life. */
  private killNeed = 1;

  constructor(key = 'weather', params: Partial<WeatherParams> = {}) {
    super('weather', key);
    this.params = { ...WEATHER_DEFAULTS, ...params };
  }

  /**
   * Size the discs, check the moisture budget, and pre-scale the probes.
   *
   * Two constraints are resolved here and they are resolved differently on purpose.
   *
   * ★ THE MOISTURE BUDGET THROWS. `rainMoisture × radius² > 300` is a parameter error a
   * GM made, it is independent of the world, and a world built with it is a world whose
   * desert belt quietly disappears — the failure `Seasons.moistureAmplitude` and
   * `Monsoon.moisture` both shipped once. Naming it is strictly better than running it.
   *
   * ★ THE TORUS FIT CLAMPS. `2r + 1 < min(width, height)` is what makes
   * `hexDistanceWithin`'s y-wrap exact; past it a disc wraps onto itself and stops being
   * a travelling thing at all. The beam is held to the same rule and REJECTS, because a
   * beam's radius is its severity dial and silently shrinking it would misreport the
   * severity of the world. A storm's radius is one of six derived sizes, a world too
   * small to hold a gale is a world with no room for weather in it either way, and a
   * throw here would turn "16×16 with the garden preset" into an error page. So the
   * discs are held to what the torus can carry and the constraint is stated in the
   * catalogue note.
   */
  protected override onBind(): void {
    const p = this.params;
    const spread = Math.max(1, Math.round(p.sampleSpread));
    this.probeCols = new Int32Array(WEATHER_PROBES.length);
    this.probeRows = new Int32Array(WEATHER_PROBES.length);
    for (let i = 0; i < WEATHER_PROBES.length; i++) {
      this.probeCols[i] = WEATHER_PROBES[i]![0] * spread;
      this.probeRows[i] = WEATHER_PROBES[i]![1] * spread;
    }
    this.killNeed = Math.max(
      1,
      Math.min(WEATHER_PROBES.length, Math.ceil(p.deathFraction * WEATHER_PROBES.length)),
    );

    // The budget is checked on the radius the GM ASKED FOR, before the torus clamp:
    // a world small enough to shrink the disc would otherwise silently make an illegal
    // configuration legal, and the same cycle set would then be rejected or not
    // depending on the size of the world it was dropped into.
    for (const type of STORM_LADDER) {
      const profile = STORM_PROFILES[type];
      const asked = Math.max(0, Math.round(p.radiusHexes * profile.radiusScale));
      const moisture = p.rainMoisture * profile.moistureScale;
      const budget = moisture * asked * asked;
      if (budget > WEATHER_MOISTURE_BUDGET) {
        throw new Error(
          `weather "${this.key}": ${type} would push ${moisture.toFixed(1)} moisture over a ` +
            `radius of ${asked}, i.e. M·R² = ${budget.toFixed(0)}, above the measured ceiling ` +
            `of ${WEATHER_MOISTURE_BUDGET}. Moisture is an additive push on a diffusion ` +
            'target with 0.9998 retention, so its steady-state gain is ~1/(1-r) and breadth ' +
            'costs four times what strength does: the ok/over boundary was measured between ' +
            'M·R² = 343 and 384 across three independent radii, and past it the desert belt ' +
            'stops existing. Lower rainMoisture or radiusHexes.',
        );
      }
    }

    // Torus fit. `hexDistanceWithin` guarantees an exact y-wrap only under half the
    // height, and a disc as wide as the world is a global offset rather than a storm.
    const fit = Math.max(0, Math.floor((Math.min(this.width, this.height) - 2) / 2));
    this.maxRadius = 0;
    for (let i = 0; i < STORM_LADDER.length; i++) {
      const profile = STORM_PROFILES[STORM_LADDER[i]!];
      const r = Math.min(fit, Math.max(0, Math.round(p.radiusHexes * profile.radiusScale)));
      this.radii[i] = r;
      if (r > this.maxRadius) this.maxRadius = r;
    }
  }

  /** ★ The declaration decision `0007` exists for. This cycle's day depends on terrain. */
  override get readsWorld(): boolean {
    return true;
  }

  /** How many epochs back a storm born earlier may still be alive today. */
  private get lookbackEpochs(): number {
    return epochLookback(this.params.durationDays * 1.4);
  }

  /**
   * Everything about a storm that does NOT depend on the world: when it is born, how
   * long it lives, and the curve it traverses. Pure in (stream, epoch, source).
   */
  private plan(epoch: number, source: number): {
    birth: number;
    life: number;
    track: SinusoidTrack;
    vigour: number;
  } {
    const p = this.params;
    const birth =
      epoch * EPOCH_DAYS +
      Math.floor(epochRoll(this.stream, epoch, source, 31) * EPOCH_DAYS) +
      p.phaseDays;
    const life = Math.max(1, Math.round(p.durationDays * (0.6 + 0.8 * epochRoll(this.stream, epoch, source, 32))));
    // Whole oscillations only, for the reason decision `0008` records: a track that
    // starts at one column and ends at the same column meets itself at the torus seam
    // only for an integer count, and a fractional one leaves a visible discontinuity.
    const osc = 1 + Math.floor(epochRoll(this.stream, epoch, source, 36) * Math.max(1, p.oscillations));
    return {
      birth,
      life,
      vigour: epochRoll(this.stream, epoch, source, 37),
      track: {
        width: this.width,
        height: this.height,
        startCol: Math.floor(epochRoll(this.stream, epoch, source, 33) * this.width),
        direction: epochRoll(this.stream, epoch, source, 34) < 0.5 ? 1 : -1,
        amplitudeHalfHeights: p.amplitudeHalfHeights,
        oscillations: osc,
        wavePhase: epochRoll(this.stream, epoch, source, 35),
        homeRow: Math.floor(epochRoll(this.stream, epoch, source, 38) * this.height),
      },
    };
  }

  /**
   * Resolve one storm against the grid: is it still alive, and if so what is it?
   *
   * Walks the storm's life from its birth to today, sampling the seven probes under the
   * track on each of those days. The walk is bounded by the storm's own lifetime, and
   * every read is of TODAY's grid — nothing here remembers a previous day, which is the
   * property the whole design rests on.
   *
   * Returns null when the storm is dead: `deathDays` consecutive days on which
   * `killNeed` of the seven probes were stone or lava. Because the scan starts at birth,
   * a storm that crossed a range on day 6 of its life is still dead on day 30 — a real
   * death rather than a dormancy that wears off — without a single byte of stored state.
   */
  private resolve(
    epoch: number,
    source: number,
    day: number,
    view: WorldView,
  ): Storm | null {
    const plan = this.plan(epoch, source);
    if (day < plan.birth || day >= plan.birth + plan.life) return null;

    const { lookbackDays, deathDays } = this.params;
    const probes = WEATHER_PROBES.length;
    let wetSum = 0;
    let wetDays = 0;
    let killRun = 0;

    for (let t = plan.birth; t <= day; t++) {
      const progress = (t - plan.birth + 1) / plan.life;
      const x = trackX(plan.track, progress);
      const y = trackY(plan.track, progress);
      const row0 = mod(Math.round(y), this.height);
      // `trackX` is in `hexX` space, where an odd row sits half a column to the right;
      // undo that before rounding to a tile or every odd-row sample is biased right.
      const col0 = Math.round(x - 0.5 * (row0 & 1));

      let wet = 0;
      let kill = 0;
      for (let i = 0; i < probes; i++) {
        const cls = view.terrainAt(col0 + this.probeCols[i]!, row0 + this.probeRows[i]!);
        if (cls & TerrainClass.Sea) wet++;
        else if (cls & (TerrainClass.Stone | TerrainClass.Molten)) kill++;
      }

      if (kill >= this.killNeed) {
        killRun++;
        if (killRun >= deathDays) return null;
      } else {
        killRun = 0;
      }

      if (t > day - lookbackDays) {
        wetSum += wet;
        wetDays++;
      }
    }

    const wetness = wetDays === 0 ? 0 : wetSum / (wetDays * probes);
    return this.dress(plan.track, plan.birth, plan.life, day, wetness, plan.vigour);
  }

  /**
   * Turn a water fraction into today's storm: type, radius, moisture, flags, and the
   * arc it sweeps today.
   *
   * `vigour` is a per-storm constant that scales the water fraction by 0.75–1.25 before
   * the ladder is read. It is a property of the storm, not of the world, so it adds
   * variety without giving the classifier anything of its own making to read.
   */
  private dress(
    track: SinusoidTrack,
    birth: number,
    life: number,
    day: number,
    wetness: number,
    vigour: number,
  ): Storm {
    const p = this.params;
    const w = wetness * (0.75 + 0.5 * vigour);
    let index = STORM_LADDER.length - 1;
    if (w >= p.wetHeavyRain) index = 0;
    else if (w >= p.wetRain) index = 1;
    else if (w >= p.wetHeavyCloud) index = 2;
    else if (w >= p.wetCloud) index = 3;
    else if (w >= p.wetWind) index = 4;

    const profile = STORM_PROFILES[STORM_LADDER[index]!];
    const radius = this.radii[index]!;
    const substeps = trackSubsteps(track, life, WEATHER_MAX_SUBSTEPS);
    const arc = sweepArc(track, (day - birth) / life, 1 / life, substeps, radius);
    return {
      ...arc,
      radius,
      moisture: p.rainMoisture * profile.moistureScale,
      heatDrop: p.cloudHeatDrop * profile.heatScale,
      flags: profile.flags,
      wetness,
    };
  }

  dayState(day: number, view: WorldView): WeatherState | null {
    // ★ DETACHED. `forecast()` may run against a cycle with no world attached, and the
    // honest answer for a world-reading cycle with no terrain to read is "nothing" —
    // which `forecast` turns into `null` rather than a fabricated storm. Decision `0007`.
    if (view.width === 0) return null;

    const { storms, meanIntervalDays, durationDays } = this.params;
    if (storms <= 0 || meanIntervalDays <= 0 || durationDays <= 0) return null;

    const p = Math.min(0.9, EPOCH_DAYS / meanIntervalDays);
    const epoch = Math.floor((day - this.params.phaseDays) / EPOCH_DAYS);
    let live: Storm[] | null = null;

    // Same Poisson-per-epoch shape as Tectonics and Volcanism, including the lookback
    // so a long-lived storm born in an earlier epoch is not silently truncated.
    for (let e = epoch - this.lookbackEpochs; e <= epoch; e++) {
      for (let s = 0; s < storms; s++) {
        if (epochRoll(this.stream, e, s, 30) >= p) continue;
        const storm = this.resolve(e, s, day, view);
        if (storm === null) continue;
        (live ??= []).push(storm);
      }
    }
    return live === null ? null : { storms: live };
  }

  affect(state: WeatherState, out: CycleEffect, col: number, row: number): void {
    for (let i = 0; i < state.storms.length; i++) {
      const storm = state.storms[i]!;
      const d = arcDistance(storm, col, row, this.width, this.height, storm.radius);
      if (d === Infinity) continue;
      // Flags across the whole disc, magnitudes with a linear falloff: the footprint a
      // rule sees is the footprint a person would see, and the moisture budget above is
      // stated as a PEAK, so a falloff can only spend less of it than the ceiling.
      const intensity = 1 - d / (storm.radius + 1);
      out.flags |= storm.flags;
      if (storm.moisture !== 0) out.moisture += storm.moisture * intensity;
      // ★ ACUTE, like the monsoon's cloud cooling and unlike a season: a storm passes a
      // tile in days, and the thermal filter would erase it. Never positive — see
      // `StormProfile.heatScale`.
      if (storm.heatDrop !== 0) out.heat -= storm.heatDrop * intensity;
    }
  }

  /**
   * Mean days between storms at one tile — an ESTIMATE, and labelled as one.
   *
   * Storms are Poisson in time and roughly uniform in space, so the honest form is
   * (epoch length) / (storms per epoch × the share of the world one storm sweeps). The
   * swept share is the arc length times the disc width, which is an over-estimate where
   * a track crosses itself. It is the same class of statement as `Tectonics`'s row
   * share, and like that one it is a rate rather than a date.
   */
  override expectedIntervalDays(): number {
    const { storms, meanIntervalDays, durationDays, radiusHexes, amplitudeHalfHeights } =
      this.params;
    if (storms <= 0 || meanIntervalDays <= 0 || durationDays <= 0) return Infinity;
    const perEpoch = storms * Math.min(0.9, EPOCH_DAYS / meanIntervalDays);
    // Arc length of one traverse: the full width, plus the sine's own path length.
    const arc = this.width + 2 * Math.PI * Math.abs(amplitudeHalfHeights) * (this.height / 2);
    const swept = Math.min(1, (arc * (2 * this.maxRadius + 1)) / (this.width * this.height));
    if (perEpoch <= 0 || swept <= 0) return Infinity;
    return EPOCH_DAYS / (perEpoch * swept);
  }

  protected override forecastLabel(flags: number): string {
    for (const type of STORM_LADDER) {
      const profile = STORM_PROFILES[type];
      // The heavy types are checked first because they carry their light partner's flag.
      if ((flags & profile.flags) === profile.flags) return profile.label;
    }
    return 'weather';
  }

  override describe(): CycleDescription {
    const { label, summary, flags } = this.catalogue;
    return {
      key: this.key,
      kind: this.kind,
      label,
      summary,
      periodDays: this.params.meanIntervalDays,
      flags,
      params: { ...this.params },
    };
  }
}

// ===========================================================================
// The catalogue — what exists, before any world does
// ===========================================================================

/**
 * `describe()` is an instance method, so it can only answer questions about a cycle
 * that has already been built into a world. A configuration UI needs the opposite:
 * what kinds exist, what each one does, which knobs it has and what they default to,
 * BEFORE there is a world at all. That is this table.
 *
 * Two rules keep it honest:
 *
 *   1. **Defaults are derived, never retyped.** Every `default` below is read out of
 *      the same `*_DEFAULTS` constant the constructor uses, so the catalogue cannot
 *      drift from the simulation by a digit.
 *   2. **Every sentence states something that was measured.** These descriptions exist
 *      because the good material was already written — in JSDoc, where no user ever
 *      sees it — and it is all sourced from real runs (R-003). This is not flavour
 *      text and must not become flavour text: a GM choosing a cycle set is making a
 *      difficulty decision, and the numbers are the whole content of it.
 *
 * Note what is NOT here: `key`. A key is per-INSTANCE, not per-kind, and it seeds the
 * cycle's RNG stream — two monsoons with different keys are genuinely different
 * monsoons, which is why a world may hold several cycles of one kind.
 */
export interface CycleParamDef {
  /** Property name on the spec. */
  readonly name: string;
  readonly label: string;
  /**
   * How to present and validate it. `integer` rejects fractions, `choice` restricts to
   * `choices`, `boolean` is a checkbox. Everything else is a real number.
   */
  readonly type: 'number' | 'integer' | 'boolean' | 'choice';
  /** Read from the kind's `*_DEFAULTS` constant, never written by hand. */
  readonly default: number | boolean | string;
  /** Advisory-but-enforced bounds. Outside them the cycle stops meaning anything. */
  readonly min?: number;
  readonly max?: number;
  /**
   * Legal values for a `choice`. STRINGS ARE ALLOWED and are not cosmetic: the beam's
   * `shape` is a genuinely non-numeric choice — `band` and `blob` are two different
   * geometries, not two points on a scale — and encoding it as 0/1 would put a number
   * in front of a GM that means nothing. `CycleDescription.params` already permitted
   * strings; this is the catalogue side of the same widening.
   */
  readonly choices?: readonly (number | string)[];
  readonly unit?: string;
  /** One line on what the number does. Mined from the JSDoc above. */
  readonly note: string;
}

export interface CycleCatalogueEntry {
  readonly kind: string;
  /** The poetic name, matching `describe().label`. */
  readonly label: string;
  /** What it does mechanically, and what it costs or unlocks. */
  readonly summary: string;
  /** Flags this kind can raise. The basis of the reachable-biome analysis. */
  readonly flags: readonly string[];
  /**
   * True when this kind's day depends on the terrain, so its forecasts are PROJECTIONS.
   * Absent means false. Mirrors `WorldCycle.readsWorld`, and exists so the composition
   * UI can say which of a GM's choices are schedules and which are weather.
   */
  readonly readsWorld?: boolean;
  readonly params: readonly CycleParamDef[];
}

/**
 * Build a kind's parameter list from its defaults plus a note per parameter.
 *
 * The mapped type is the point: it requires an entry for EVERY key of the params
 * interface, so adding a parameter to `SolarBeamParams` without describing it is a
 * type error rather than a knob that silently never appears in the UI.
 */
function paramDefs<P extends object>(
  defaults: P,
  notes: { [K in keyof P & string]: Omit<CycleParamDef, 'name' | 'default'> },
): readonly CycleParamDef[] {
  return (Object.keys(notes) as (keyof P & string)[]).map((name) => ({
    name,
    ...notes[name],
    default: defaults[name] as number | boolean | string,
  }));
}

const DAYS = 'days';
const COLS = 'columns';
const ROWS = 'rows';
const HEXES = 'hexes';
const TURNS = 'turns';
const TRAVERSES = 'traverses';

export const CYCLE_CATALOGUE: readonly CycleCatalogueEntry[] = [
  {
    kind: 'solarbeam',
    label: 'the cleansing sweep',
    summary:
      'A permanently present focus of scorching heat that crosses the world once per ' +
      'TRAVERSE and precesses a little each time, so it burns a fraction of the map on ' +
      'any one crossing and all of it over a GREAT YEAR. Its SHAPE decides what ' +
      '"crosses" means. As a blob (the default) it is a hex disc tracing a sinusoid. ' +
      'Every figure that follows is from a 240×144 world at seed 20260729; the blob ones ' +
      'are at the shipped track (radius 6, 3 oscillations, full amplitude, 60-day ' +
      'traverse, great year of 7) unless they name another radius. One pass covers ' +
      '30.64% of the map, and cumulative coverage over a great year runs 30.64, 56.92, ' +
      '78.22, 91.15, 98.00, 99.98, 100.00% — after which traverse 8 reproduces traverse ' +
      '1 exactly. That 420-day great year is the number a player learns: it is when the ' +
      'sun is back on the track it started on, and it is what makes a beam that misses ' +
      'most of the world today still reach every tile eventually. Radius buys coverage ' +
      'per pass and is the severity dial — on the same track, radius 2 covers 9.98%, ' +
      'radius 4 20.32%, radius 8 40.81%, radius 16 78.24% — but what breaks at a small ' +
      'radius is NOT the liveness test. On `npm run sim:check`\'s own instrument with a ' +
      'beam-only world, radius 6 leaves 14.21% of the map with no live out-rule and no ' +
      'latched family, radius 4 leaves 19.03%, and radius 2 latches six families at ' +
      '40.24% while `npm run sim` still calls that world alive. Check `sim:check`, not ' +
      '`sim`. THE TWO TIME KNOBS ARE NOT INTERCHANGEABLE, AND WHICH ONE MATTERS DEPENDS ' +
      'ON THE SHAPE. Under a BAND, transit is DWELL TIME and cycle is RECOVERY TIME, ' +
      'they must stay separate, and collapsing them sterilises: at a single-knob 900-day ' +
      'period the sea drains from 23.81% to 5.60% over 60 game-years. Under a CONTINUOUS ' +
      'BLOB they collapse into one traverse period deliberately, and the same 900-day ' +
      'period does not drain the sea at all (23.81% → 23.52%) — it makes the world QUIET ' +
      'instead, entropy 0.685 and churn 0.24%. So the direction a GM turns the dial ' +
      'INVERTS with the shape: a SHORTER transit softens a band, a LONGER traverse ' +
      'softens a blob. As a band it is instead a full-height wall of columns covering ' +
      '100% of the world every purge and dormant between them; that is the shape the ' +
      'original prototype was validated with, and it is unchanged. Either way it is one ' +
      'of only two cycles that opens the melt chemistry: without a beam or volcanism ' +
      'there is no route to lava, ash, basalt or fertile soil.',
    flags: ['beam', 'focus'],
    params: paramDefs(SOLAR_BEAM_DEFAULTS, {
      transitDays: {
        label: 'transit', type: 'number', min: 1, max: 2000, unit: DAYS,
        note: 'Days to cross the world once. This is SEVERITY — how long one tile bakes. 120d sterilises.',
      },
      cycleDays: {
        label: 'cycle', type: 'number', min: 1, max: 5000, unit: DAYS,
        note: 'Days from one purge to the next, for a BAND or a blob with continuous off. IGNORED by the default continuous blob, whose traverse period is transit and whose recovery time is the great year.',
      },
      continuous: {
        label: 'continuous', type: 'boolean',
        note: 'BLOB ONLY, default on. The beam is permanently present: one traverse ends and the next begins the next day, cycle is not consulted, and there is no dormant day. Turn it off to restore the old purge-and-recover schedule.',
      },
      shape: {
        label: 'shape', type: 'choice', choices: ['blob', 'band'],
        note: 'blob = a travelling hex disc on a sinusoid, sized by radius. band = a full-height wall of columns covering 100% of the world every purge, the validated prototype.',
      },
      widthCols: {
        label: 'band width', type: 'number', min: 1, max: 512, unit: COLS,
        note: 'BAND ONLY. Width of the scorching band. Ignored by a blob, which uses radius.',
      },
      heat: {
        label: 'beam heat', type: 'number', min: 0, max: 300,
        note: 'Heat added across the whole beam, whatever its shape. Validated at +70; do not raise casually.',
      },
      focusCols: {
        label: 'focus width', type: 'number', min: 0, max: 512, unit: COLS,
        note: 'BAND ONLY. Width of the melting core. Raises Focus, which is the gate for sand → lava.',
      },
      focusHeat: {
        label: 'focus heat', type: 'number', min: 0, max: 300,
        note: 'Extra heat inside the core, on top of beam heat. Pushes sand past melting.',
      },
      radiusHexes: {
        label: 'radius', type: 'integer', min: 0, max: 256, unit: HEXES,
        note: 'BLOB ONLY, and the severity dial. Hex rings, inclusive — 2 is 5 tiles across. It buys COVERAGE, which saturates at 100% by radius 12; below radius 8 a beam-only world still passes the liveness test while most of it has no live out-rule, so check `npm run sim:check`, not `npm run sim`. Measured radius table in .wiki/specs/2915cb06-1_contract-and-beam.md.',
      },
      focusRadiusHexes: {
        label: 'focus radius', type: 'integer', min: 0, max: 256, unit: HEXES,
        note: 'BLOB ONLY. Radius of the melting core. 0 is legal and melts only the centreline.',
      },
      amplitudeHalfHeights: {
        label: 'track amplitude', type: 'number', min: 0, max: 1,
        note: 'BLOB ONLY. Sine amplitude as a FRACTION of half the world height. 1.0 reaches every latitude; below that the rows the track misses are beam-free forever.',
      },
      oscillations: {
        label: 'oscillations', type: 'integer', min: 0, max: 64,
        note: 'BLOB ONLY. Whole sine cycles per transit. Must be an integer or the two ends of the scar do not meet at the torus seam.',
      },
      wavePhase: {
        label: 'wave phase', type: 'number', min: 0, max: 1, unit: TURNS,
        note: 'BLOB ONLY. Phase of the sine in turns. Slides where the track crosses the equator.',
      },
      greatYearTraverses: {
        label: 'great year', type: 'integer', min: 1, max: 512, unit: TRAVERSES,
        note: 'BLOB ONLY. Traverses per great year — the beam advances its wave phase by 1/this each crossing and returns to its starting track after exactly this many. 1 disables precession, and then the track retraces forever and whatever the first pass misses is missed for the life of the world. This is what makes the sun eventually reach everywhere.',
      },
      homeRow: {
        label: 'home row', type: 'number', min: 0, max: 2048, unit: ROWS,
        note: 'BLOB ONLY. Row the track oscillates about. 0 is the hot equator.',
      },
      direction: {
        label: 'direction', type: 'choice', choices: [1, -1],
        note: 'Direction of travel. The maths is symmetric; -1 simply sweeps the other way.',
      },
      phaseDays: {
        label: 'phase', type: 'number', min: 0, max: 5000, unit: DAYS,
        note: 'Day the first purge begins. Two beams on one world can be out of phase.',
      },
    }),
  },
  {
    kind: 'seasons',
    label: 'the turning year',
    summary:
      'A slow global heat swing, and per unit of cost the most valuable cycle in the ' +
      'set: it makes every threshold in the ruleset breathe, so a tile parked just ' +
      'below the forest moisture cut-off crosses it every year instead of never. Most ' +
      'of its effect arrives through heat rather than the explicit rain term, because ' +
      'heat is a multiplicative decay on moisture retention — a hot season dries ' +
      'continental interiors on its own, bounded and geographically shaped. The polar ' +
      'amplitude is load-bearing at 22: at 9 the cold-band sea never came within 10 ' +
      'degrees of the ice-thaw threshold and an eighth of the world froze permanently. ' +
      'Rain amplitude is the opposite — it is tiny on purpose, and at 10 the desert ' +
      'belt vanished for half of every year (land moisture swinging 2.4–99.9, against ' +
      '25–99 at 4). Its heat arrives on the AMBIENT channel, so it is the one cycle a ' +
      "tile's thermal inertia low-passes: near water the year's swing is damped and " +
      'delayed, which is what gives a coast a maritime climate and an interior a ' +
      'continental one. Acute cycles — the beam, eruptions, quakes — bypass that filter.',
    flags: ['heatwave', 'freeze', 'storm', 'drought'],
    params: paramDefs(SEASONS_DEFAULTS, {
      periodDays: {
        label: 'year length', type: 'number', min: 1, max: 5000, unit: DAYS,
        note: 'Length of one full year.',
      },
      heatAmplitude: {
        label: 'heat swing', type: 'number', min: 0, max: 100,
        note: 'Swing at the COLD BAND, about half of it at mid-latitudes. 22 is what makes ice form and thaw both reachable.',
      },
      moistureAmplitude: {
        label: 'rain swing', type: 'number', min: 0, max: 40,
        note: '★ Tiny on purpose. An additive push on a diffusion target with 0.9998 retention, so its steady-state gain is ~1/(1-r). At 10 the desert belt disappears.',
      },
      moistureLagQuarters: {
        label: 'rain lag', type: 'number', min: 0, max: 4, unit: 'quarter-years',
        note: 'Quarter-turns the wet season lags the hot one. 1 = late-summer monsoon, 2 = wet winters.',
      },
      latitudeWeighted: {
        label: 'latitude weighted', type: 'boolean',
        note: 'On: flat at the hot band, savage at the cold band. Off: uniform, which suits an airless or tide-locked world.',
      },
      extremeThreshold: {
        label: 'extreme threshold', type: 'number', min: 0, max: 1,
        note: 'Fraction of the swing past which heatwave / freeze / storm / drought are raised.',
      },
      extremeMinWeight: {
        label: 'extreme floor', type: 'number', min: 0, max: 1,
        note: 'Latitude weight below which no NAMED thermal season fires. Seasonality in temperature is a latitude phenomenon; it does not gate rain.',
      },
      wetWeightFloor: {
        label: 'tropical rain floor', type: 'number', min: 0, max: 1,
        note: 'Floor under the rain weight, independent of latitude. 0 leaves the tropics with no seasons at all — which made badlands a mid-latitude biome by accident.',
      },
      phaseDays: {
        label: 'phase', type: 'number', min: 0, max: 5000, unit: DAYS,
        note: 'Day of peak heat. Offsets one world’s calendar from another’s.',
      },
    }),
  },
  {
    kind: 'tectonics',
    label: 'the shifting deeps',
    summary:
      'Permanent fault lines with quakes rupturing along them on a memoryless ' +
      'schedule. This is the ONLY route to mountain: a world without tectonics has no ' +
      'path to mountain at all, and the granite / silver / skyquartz material family ' +
      'does not exist in it. It is also glass’s most important exit — glass shatters ' +
      'back to sand under a quake, which is what turns a purge scar from a graveyard ' +
      'into an intermediate state (beam makes glass, quake makes sand, water makes ' +
      'soil, soil makes forest). Ridge width decides whether the world gets ranges or ' +
      'seams: at 2 columns the theoretical ceiling was ~1% of a 240-column map, ' +
      'measured 0.13–0.45%, and mountain materials were unobtainable in all 96 sampled ' +
      'regions.',
    flags: ['quake', 'uplift'],
    params: paramDefs(TECTONICS_DEFAULTS, {
      faults: {
        label: 'faults', type: 'integer', min: 0, max: 64,
        note: 'Fault lines crossing the world. Permanent geography; quakes are events along them.',
      },
      meanIntervalDays: {
        label: 'mean interval', type: 'number', min: 1, max: 5000, unit: DAYS,
        note: 'Mean days between quakes ON ONE FAULT. More faults means more quakes overall.',
      },
      durationDays: {
        label: 'rupture length', type: 'number', min: 1, max: 2000, unit: DAYS,
        note: 'Days a quake sequence rumbles for. Any length: the scheduler looks back however many epochs it takes.',
      },
      shakeCols: {
        label: 'shake half-width', type: 'number', min: 0, max: 256, unit: COLS,
        note: 'Half-width of the shaken band either side of the fault.',
      },
      ridgeCols: {
        label: 'ridge half-width', type: 'number', min: 0, max: 256, unit: COLS,
        note: 'Half-width of the ground that can RISE. Must be ≤ shake half-width. This is the parameter that decides whether a world has mountains.',
      },
      reachRows: {
        label: 'rupture reach', type: 'number', min: 1, max: 512, unit: ROWS,
        note: 'Half-length of the rupture at magnitude 1, along the fault.',
      },
      upliftThreshold: {
        label: 'uplift threshold', type: 'number', min: 0, max: 1,
        note: 'Magnitude needed to lift ground AT the fault; the requirement doubles by the ridge margin, so ranges taper instead of ending in a cliff.',
      },
    }),
  },
  {
    kind: 'volcanism',
    label: 'the fire below',
    summary:
      'Vents that erupt, lava that cools, ash that settles. The cycle that most ' +
      'directly makes a world MORE alive rather than less, because its output is ' +
      'fertile: lava cools to basalt when dry and to soil when wet, ash settles to ' +
      'soil above moisture 38, and soil becomes grassland in weeks. Size it from ' +
      'throughput, not taste — standing share is production rate times dwell time, and ' +
      'the first pass (5 vents, 200d interval, 6d eruption, 3.5-tile lava radius) ' +
      'measured 0.02% lava and 0.01% soil on a preset whose entire identity is ' +
      'volcanism. The defaults below put ~0.6% of the world under ashfall at any ' +
      'moment, which is what makes basalt and soil real provinces rather than rounding ' +
      'errors. Along with the beam it is one of only two routes to lava, ash, basalt ' +
      'and fertile soil.',
    flags: ['eruption', 'focus', 'ashfall'],
    params: paramDefs(VOLCANISM_DEFAULTS, {
      vents: {
        label: 'vents', type: 'integer', min: 0, max: 256,
        note: 'Vents scattered across the world. Fixed sites; eruptions are events at them.',
      },
      meanIntervalDays: {
        label: 'mean interval', type: 'number', min: 1, max: 5000, unit: DAYS,
        note: 'Mean days between eruptions AT ONE VENT.',
      },
      durationDays: {
        label: 'eruption length', type: 'number', min: 1, max: 2000, unit: DAYS,
        note: 'How long an eruption runs. Half of what sets lava’s standing share.',
      },
      lavaRadius: {
        label: 'lava radius', type: 'number', min: 0, max: 128, unit: 'tiles',
        note: 'Radius of the lava field at magnitude 1. Raises Focus and Eruption.',
      },
      ashRadius: {
        label: 'ash radius', type: 'number', min: 0, max: 256, unit: 'tiles',
        note: 'Radius of the ash plume. The plume is what produces soil, so this is the fertility dial.',
      },
      ventHeat: {
        label: 'vent heat', type: 'number', min: 0, max: 400,
        note: 'Heat at the vent mouth. Must clear the melting point on its own. Safe to scale where albedo is not: a vent cannot amplify itself.',
      },
      plumeHeat: {
        label: 'plume heat', type: 'number', min: 0, max: 100,
        note: 'Heat at the edge of the ash plume.',
      },
    }),
  },
  {
    kind: 'monsoon',
    label: 'the rains',
    summary:
      'A rain front that migrates across latitudes — deliberately the row-wise ' +
      'counterpart to the beam’s column-wise sweep, so two fronts on perpendicular ' +
      'axes give the map a two-dimensional weather history instead of banding. ' +
      'Mechanically it is the counterweight to desertification: the albedo feedback is ' +
      'capped at +1.2 because it self-amplifies, and a monsoon is an un-amplifiable ' +
      'push in the opposite direction, so a strongly monsooned world can safely carry ' +
      'a harsher beam. Travel defaults to the whole torus for a measured reason: at ' +
      'half the world, 56 of 144 rows were never rained on once across 10 game-years. ' +
      'Keep the moisture term small — it pushes a diffusion target whose retention is ' +
      '0.9998, and at the 26 it originally shipped with a monsoon did not water a ' +
      'region, it flooded the planet.',
    flags: ['storm'],
    params: paramDefs(MONSOON_DEFAULTS, {
      periodDays: {
        label: 'period', type: 'number', min: 1, max: 5000, unit: DAYS,
        note: 'Days between one monsoon and the next.',
      },
      transitDays: {
        label: 'transit', type: 'number', min: 1, max: 2000, unit: DAYS,
        note: 'Days the front spends crossing. The rest of the period is dry.',
      },
      startRow: {
        label: 'start row', type: 'integer', min: 0, max: 4096,
        note: 'Row the front starts from.',
      },
      travelRows: {
        label: 'travel', type: 'number', min: 0, max: 4096, unit: ROWS,
        note: '0 means the whole torus, resolved at bind time. Anything less leaves rows permanently outside the rain cycle.',
      },
      bandRows: {
        label: 'band half-height', type: 'number', min: 1, max: 512, unit: ROWS,
        note: 'Half-height of the rain band.',
      },
      moisture: {
        label: 'moisture', type: 'number', min: 0, max: 60,
        note: '★ Small for the same reason the seasonal rain swing is: additive push on a 0.9998-retention diffusion target. At 26 it saturates every land tile the band crosses.',
      },
      heatDrop: {
        label: 'cloud cooling', type: 'number', min: 0, max: 60,
        note: 'Heat removed under cloud cover. Half the monsoon’s real channel — cooler ground holds its moisture — and inherently bounded, since retention cannot exceed 1.',
      },
      stormThreshold: {
        label: 'storm threshold', type: 'number', min: 0, max: 1,
        note: 'Fraction of peak moisture past which Storm is raised.',
      },
      phaseDays: {
        label: 'phase', type: 'number', min: 0, max: 5000, unit: DAYS,
        note: 'Offsets the front. Two monsoons out of phase is a legitimate world.',
      },
    }),
  },
  {
    kind: 'weather',
    label: 'the weather',
    summary:
      'A small population of storms, each a disc travelling a sinusoid, whose TYPE, ' +
      'RADIUS and SURVIVAL are decided by the ground it has crossed. A system that has ' +
      'been over open water rains; one that has been dry for a while reverts to wind; ' +
      'one that crosses a range or a lava field two days running — three of its seven ' +
      'ground probes on hard ground each day — DIES, and stays dead for the rest of its ' +
      'life. How often that happens is a fact about the world rather than about this ' +
      'cycle: at the shipped settings, over 1500 days, the terrain killed 0.3% of ' +
      'storm-days on the no-disturbance control, 5.1% on a world with fault ridges, and ' +
      '23.7% on one with beam scars, basalt fields and live lava — the same ordering as ' +
      'the hard ground under them, 0.4% / 3.9% / 8.2% of the map. It is the only cycle ' +
      'that reads the world, so its forecasts are PROJECTIONS rather than schedules — ' +
      'though measured over 400 tiles at a 150-day horizon, WHEN is exact (395/395, mean ' +
      'error 0.00 d, because the track is world-independent) and only WHAT degrades, ' +
      'from 100% correct inside thirty days to 95.3% past them. It never misses an ' +
      'arrival it did not predict. Its classifier is GEOGRAPHIC and must stay that ' +
      'way: gated on open water it oscillates between 24.6% and 38.5% rain share across ' +
      'five 300-day windows of a 1500-day run with no trend, and keeps all six types in ' +
      'use (normalised type entropy 0.97); gated on moisture instead, the same storm ' +
      'latched to 100% — it rained, the ground got wet, so it rained forever. Rain ' +
      'moisture is tiny for the same reason the monsoon\'s is, and the ' +
      'ceiling is on the PRODUCT: moisture × radius² must stay under 300, because ' +
      'breadth costs four times what strength does. Wind dries and abrades; it carries ' +
      'no heat. Be honest about what it buys — it was measured liveness-NEUTRAL against ' +
      'the same world without it. What it adds is texture and legibility, not churn.',
    flags: ['rain', 'heavyrain', 'wind', 'heavywind', 'cloud', 'heavycloud', 'storm'],
    readsWorld: true,
    params: paramDefs(WEATHER_DEFAULTS, {
      storms: {
        label: 'storm tracks', type: 'integer', min: 0, max: 64,
        note: 'Concurrent storm TRACKS. Each rolls independently per epoch whether it carries a storm, so this is the population, not the storm count.',
      },
      meanIntervalDays: {
        label: 'mean interval', type: 'number', min: 1, max: 5000, unit: DAYS,
        note: 'Mean days between storms ON ONE TRACK. More tracks means more weather overall.',
      },
      durationDays: {
        label: 'storm life', type: 'number', min: 1, max: 2000, unit: DAYS,
        note: 'Mean days a storm lives; actual lives run 0.6×–1.4× this. It is also the SPEED knob — a storm crosses the world exactly once in its life, so a shorter life is a faster storm.',
      },
      radiusHexes: {
        label: 'rain radius', type: 'integer', min: 0, max: 64, unit: HEXES,
        note: 'Radius of a RAIN disc. The other five types scale off it — a gale is 1.6× as broad, a rain cell is the one that carries moisture. A disc must fit its torus (2r+1 < the smaller axis) or it wraps onto itself; discs are held to that.',
      },
      lookbackDays: {
        label: 'lookback', type: 'integer', min: 1, max: 200, unit: DAYS,
        note: '★ The window of its own track a storm classifies itself from. Nothing is accumulated — the type is recomputed from today\'s grid every day, which is what keeps the cycle resolvable from a cold start. What it costs is REACH: at the default 12 days the window\'s oldest sample sits a mean 51 tiles from the storm\'s centre, and its furthest probe 56.',
      },
      sampleSpread: {
        label: 'probe spread', type: 'number', min: 1, max: 32, unit: HEXES,
        note: 'How far the seven terrain probes sit from the track centre. Fixed, and deliberately independent of the storm\'s type: a type-dependent probe would be a classifier reading its own output.',
      },
      wetHeavyRain: {
        label: 'downpour above', type: 'number', min: 0, max: 1,
        note: 'Water fraction under the lookback at or above which the storm is a downpour. A downpour also raises the Storm flag, so every existing wet-season rule fires under it.',
      },
      wetRain: {
        label: 'rain above', type: 'number', min: 0, max: 1,
        note: 'Water fraction at or above which it rains. Against a world 22–24% sea, 0.3 means the storm has been working a coastline or better.',
      },
      wetHeavyCloud: {
        label: 'heavy cloud above', type: 'number', min: 0, max: 1,
        note: 'Water fraction at or above which the system is heavy overcast rather than rain.',
      },
      wetCloud: {
        label: 'cloud above', type: 'number', min: 0, max: 1,
        note: 'Water fraction at or above which it is cloud. Below this the storm has dried out and reverts to wind.',
      },
      wetWind: {
        label: 'gale below', type: 'number', min: 0, max: 1,
        note: 'Water fraction below which the wind is a gale — nothing wet has passed under the storm for a while.',
      },
      deathFraction: {
        label: 'death fraction', type: 'number', min: 0, max: 1,
        note: 'Share of the seven probes that must be stone or lava for a day to count as lethal. This is "the storm dies when it passes another terrain".',
      },
      deathDays: {
        label: 'death days', type: 'integer', min: 1, max: 100, unit: DAYS,
        note: 'Consecutive lethal days that kill a storm outright. Death is DERIVED by rescanning the storm\'s own bounded life, never stored — an absorbing flag cannot be inferred from a grid.',
      },
      rainMoisture: {
        label: 'rain moisture', type: 'number', min: 0, max: 60,
        note: '★ PEAK moisture at the centre of a downpour, and the ceiling is on moisture × radius², not on this alone. Over 300 the desert belt stops existing; the world refuses to build rather than run it.',
      },
      cloudHeatDrop: {
        label: 'cloud cooling', type: 'number', min: 0, max: 60,
        note: 'Heat removed under rain or cloud. Shade, not winter — and it is the ACUTE channel, because a storm passes in days and the thermal filter would erase it. Wind carries no heat at all.',
      },
      oscillations: {
        label: 'max oscillations', type: 'integer', min: 1, max: 32,
        note: 'A storm rolls between 1 and this many whole sine cycles per traverse. Whole numbers only, so a track meets itself at the torus seam.',
      },
      amplitudeHalfHeights: {
        label: 'track amplitude', type: 'number', min: 0, max: 1,
        note: 'Sine amplitude as a FRACTION of half the world height, not a row count. Each storm also picks its own home row, so the population covers every latitude even at a small amplitude.',
      },
      phaseDays: {
        label: 'phase', type: 'number', min: 0, max: 5000, unit: DAYS,
        note: 'Offsets the whole storm calendar. Two weather cycles on one world can run out of phase.',
      },
    }),
  },
];

const CATALOGUE_BY_KIND: ReadonlyMap<string, CycleCatalogueEntry> = new Map(
  CYCLE_CATALOGUE.map((e) => [e.kind, e]),
);

/** The catalogue entry for a kind. Throws on an unknown kind, like `makeCycle`. */
export function cycleCatalogueEntry(kind: string): CycleCatalogueEntry {
  const entry = CATALOGUE_BY_KIND.get(kind);
  if (entry === undefined) throw new Error(`Unknown cycle kind: ${kind}`);
  return entry;
}

/** Kinds a world's cycles are made of. The input to the reachability analysis. */
export const CYCLE_KINDS: readonly string[] = CYCLE_CATALOGUE.map((e) => e.kind);

// ===========================================================================
// Configuration — what a Game Master actually writes
// ===========================================================================

export type CycleSpec =
  | ({ kind: 'solarbeam'; key?: string } & Partial<SolarBeamParams>)
  | ({ kind: 'seasons'; key?: string } & Partial<SeasonsParams>)
  | ({ kind: 'tectonics'; key?: string } & Partial<TectonicsParams>)
  | ({ kind: 'volcanism'; key?: string } & Partial<VolcanismParams>)
  | ({ kind: 'monsoon'; key?: string } & Partial<MonsoonParams>)
  | ({ kind: 'weather'; key?: string } & Partial<WeatherParams>);

/** Build a cycle from a plain, serialisable spec. This is the GM-facing surface. */
export function makeCycle(spec: CycleSpec): WorldCycle {
  switch (spec.kind) {
    case 'solarbeam': {
      const { kind, key, ...p } = spec;
      return new SolarBeam(key ?? 'beam', p);
    }
    case 'seasons': {
      const { kind, key, ...p } = spec;
      return new Seasons(key ?? 'seasons', p);
    }
    case 'tectonics': {
      const { kind, key, ...p } = spec;
      return new Tectonics(key ?? 'tectonics', p);
    }
    case 'volcanism': {
      const { kind, key, ...p } = spec;
      return new Volcanism(key ?? 'volcanism', p);
    }
    case 'monsoon': {
      const { kind, key, ...p } = spec;
      return new Monsoon(key ?? 'monsoon', p);
    }
    case 'weather': {
      const { kind, key, ...p } = spec;
      return new Weather(key ?? 'weather', p);
    }
    default: {
      const unknown: never = spec;
      throw new Error(`Unknown cycle kind: ${JSON.stringify(unknown)}`);
    }
  }
}

/**
 * Named starting points a GM can take and tune. Each is a WORLD'S IDENTITY, not a
 * difficulty slider: "Anvil" is a place where the sun comes for you, "Kiln" is a place
 * where the ground does. They should feel different to live on, not merely harder.
 */
export const CYCLE_PRESETS: Readonly<Record<string, CycleSpec[]>> = {
  /** No disturbance at all. The control case — SIMULATION.md showed it freezes. */
  still: [],

  /**
   * The wandering sun and nothing else. A 60-day traverse, never dormant, precessing to a
   * 420-day great year — the shipped beam defaults, unqualified.
   *
   * It is the world where the beam is the ONLY thing standing between a tile and a live
   * out-rule, which is why it, and not `crucible`, is what sets the floor on beam
   * severity: `npm run sim:check`'s escapability reads 14.21% here against `crucible`'s
   * 5.08%, because five other cycles are disturbing that world whatever the beam does.
   *
   * `cycleDays` is deliberately absent. Under a continuous blob it is not consulted, and
   * leaving the old `cycleDays: 360` in place would have been a number that reads like a
   * setting and controls nothing.
   */
  anvil: [{ kind: 'solarbeam', transitDays: 60 }],

  /**
   * A living world: weather and geology, no god. Gentle, and still never static.
   *
   * It is the preset whose NAME was already a promise of weather, so it is the one that
   * got it: storms travelling their own tracks, morphing against the coast and dying
   * over the fault ridges tectonics puts there. On this world 5.1% of storm-days end in
   * a death (1500 days, 160×96), which is the middle of the three presets and comes
   * entirely from the ridges — the control kills 0.3%.
   */
  garden: [
    { kind: 'seasons' },
    { kind: 'monsoon' },
    { kind: 'tectonics', meanIntervalDays: 200 },
    { kind: 'weather' },
  ],

  /** Volcanic. Harsh in patches, extremely fertile between them. */
  kiln: [
    { kind: 'seasons' },
    { kind: 'monsoon' },
    { kind: 'volcanism', vents: 14, meanIntervalDays: 85 },
    { kind: 'tectonics', meanIntervalDays: 120 },
  ],

  /**
   * Everything at once. The full chemistry: melt, cool, shatter, drown, regrow.
   *
   * The beam is tuned DOWN from the 60d/360d that `anvil` validated, and the shape of
   * the change is the interesting part: disturbances STACK. A purge landing during a
   * seasonal heatwave, on ground already stripped by a quake and buried by a plume,
   * scours far harder than the same purge on a quiet world — at 60d/360d the living
   * share bottomed out at 2% of the map, a world that has to be repopulated rather
   * than one that recovers.
   *
   * ★ THE KNOB THAT HELPS NOW TURNS THE OTHER WAY, AND THE OLD VALUE IS THE TRAP.
   * Under the BAND this preset was tuned for, shortening the transit to 45 days was the
   * fix — transit was dwell time, and dwell time was what sterilised. Under a continuous
   * blob, transit is the TRAVERSE PERIOD, and a shorter one means the beam walks the same
   * track more often, so the world absorbs more per day rather than less. Decision `0024`
   * has the dwell and dose tables; this preset is where it bites.
   *
   * Measured at the shipped beam geometry, 60 game-years at 120×72, seed 20260729, sea
   * share y0 → y60 — the AC2 instrument from spec `2915cb06-3`, whose standing verdict is
   * ±5 pp over 60 game-years, i.e. ±0.0833 pp/y:
   *
   *    150 d traverse   23.81 → 29.78   +0.0995 pp/y   ✗ over the verdict
   *    200 d traverse   23.81 → 27.23   +0.0571 pp/y   ← shipped
   *    250 d traverse   23.81 → 25.78   +0.0328 pp/y
   *
   * 200 rather than 250 because the margin at 200 is already comfortable and the point of
   * this preset is that everything is happening at once, not that the sun has been turned
   * off in all but name.
   *
   * against this preset's own pre-spec baseline of 23.81 → 26.37, +0.0426 pp/y. A smaller
   * sun is the other way to buy the same margin and was measured too — radius 6 at 150 d
   * gives +0.0405, closest of all to the baseline — but it would put a second beam
   * geometry in the presets for no gain a player could see. Only the PERIOD differs
   * between `anvil` and `crucible`, which is the knob decision `0024` says is the
   * shape-appropriate one to turn.
   *
   * Keeping 45 would have flooded the world by 10.7 pp in 60 game-years, twice the
   * standing verdict, while looking like the conservative choice — because it is the
   * number that WAS conservative under the previous shape.
   *
   * The great year here is 1600 days. That is a long recovery, and it is the point: on a
   * world where five other cycles are already working the ground, the sun coming back
   * less often is what keeps the water where it is.
   */
  crucible: [
    { kind: 'solarbeam', transitDays: 200 },
    { kind: 'seasons' },
    { kind: 'monsoon', phaseDays: 180 },
    { kind: 'tectonics' },
    { kind: 'volcanism' },
    // Everything at once means everything, and this is also the preset the golden
    // worlds are taken from — so weather being here is what puts a world-reading cycle
    // under the determinism gate on every run rather than only under a harness.
    // It is the harshest world for a storm: 23.7% of storm-days die on the scars.
    { kind: 'weather' },
  ],
};

// ---------------------------------------------------------------------------

function mod(v: number, n: number): number {
  return ((v % n) + n) % n;
}
