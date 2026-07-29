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
  /** Added to the tile's heat before the hydrology and the rules see it. */
  heat = 0;
  /** Added to the moisture diffusion TARGET, exactly like marsh neighbours are. */
  moisture = 0;
  /** OR of every flag raised on this tile today. */
  flags = 0;

  reset(): this {
    this.heat = 0;
    this.moisture = 0;
    this.flags = 0;
    return this;
  }
}

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
}

export interface CycleDescription {
  readonly key: string;
  readonly kind: string;
  readonly label: string;
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
   * The cycle's derived state for one day. MUST be a pure function of
   * (worldSeed, key, day) — no reading of `this` mutable state, no accumulation.
   * Return null when the cycle is dormant today; World then skips it entirely.
   */
  abstract dayState(day: number): S | null;

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
  ): CycleForecast | null {
    const start = Math.floor(fromDay);
    for (let d = start; d < start + horizonDays; d++) {
      const flags = this.probe(d, col, row);
      if (flags === 0) continue;

      // Found the arrival. Walk forward to measure how long it lasts and how hard it
      // peaks, so the API can say "6 days of ashfall" rather than just "ashfall".
      let duration = 0;
      let peakHeat = 0;
      let peakMoisture = 0;
      let union = 0;
      for (let e = d; e < start + horizonDays; e++) {
        const f = this.probe(e, col, row);
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
  protected probe(day: number, col: number, row: number): number {
    const state = this.dayState(day);
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

// ===========================================================================
// SolarBeam — the cleansing sweep
// ===========================================================================

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
   * ★ These two MUST stay separate. Collapsing them into a single "period" inverts
   * the effect: a longer period becomes a SLOWER beam, each tile bakes longer, and
   * the world sterilises — at a single-knob 900-day period, water reached 0%.
   * Validated default: 60d transit / 360d cycle.
   */
  cycleDays: number;
  /** Width of the scorching band, in columns. */
  widthCols: number;
  /** Heat added across the whole band. Validated at +70; do not raise casually. */
  heat: number;
  /** Width of the melting core, in columns. Raises Focus. */
  focusCols: number;
  /** Extra heat inside the core, on top of `heat`. Pushes sand past melting. */
  focusHeat: number;
  /** Direction of travel. -1 sweeps the other way; the maths is symmetric. */
  direction: 1 | -1;
  /** Day the first purge begins. Lets two beams on one world be out of phase. */
  phaseDays: number;
}

const SOLAR_BEAM_DEFAULTS: SolarBeamParams = {
  transitDays: 60,
  cycleDays: 360,
  widthCols: 8,
  heat: 70,
  focusCols: 2,
  focusHeat: 45,
  direction: 1,
  phaseDays: 0,
};

interface BeamState {
  /** Leading column of the gaze this day. */
  readonly centre: number;
}

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

  constructor(key = 'beam', params: Partial<SolarBeamParams> = {}) {
    super('solarbeam', key);
    this.params = { ...SOLAR_BEAM_DEFAULTS, ...params };
  }

  /** True while a purge is crossing the world. Between purges the beam is dormant. */
  active(day: number): boolean {
    const { cycleDays, transitDays, phaseDays } = this.params;
    if (transitDays <= 0 || cycleDays <= 0) return false;
    return mod(day - phaseDays, cycleDays) < transitDays;
  }

  dayState(day: number): BeamState | null {
    if (!this.active(day)) return null;
    const { cycleDays, transitDays, phaseDays, direction } = this.params;
    const intoPurge = mod(day - phaseDays, cycleDays);
    const travelled = (intoPurge / transitDays) * this.width * direction;
    return { centre: mod(Math.floor(travelled), this.width) };
  }

  affect(state: BeamState, out: CycleEffect, col: number, _row: number): void {
    const delta = Math.abs(wrapDelta(col - state.centre, this.width));
    if (delta >= this.params.widthCols) return;
    out.heat += this.params.heat;
    out.flags |= CycleFlag.Beam;
    if (delta < this.params.focusCols) {
      out.heat += this.params.focusHeat;
      out.flags |= CycleFlag.Focus;
    }
  }

  /** Leading column of the beam today, or -1 when dormant. */
  column(day: number): number {
    const s = this.dayState(day);
    return s === null ? -1 : s.centre;
  }

  /** Day the next purge begins. The cycle-level question, closed form. */
  nextPurgeDay(fromDay: number): number {
    const { cycleDays, transitDays, phaseDays } = this.params;
    if (transitDays <= 0 || cycleDays <= 0) return Infinity;
    const into = mod(fromDay - phaseDays, cycleDays);
    return into < transitDays ? fromDay - into : fromDay - into + cycleDays;
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
   * The horizon is widened to one full cycle plus one transit, which is provably
   * enough for every column, so the beam is always forecastable however long its cycle.
   */
  override forecast(
    col: number,
    row: number,
    fromDay: number,
    horizonDays: number = DEFAULT_FORECAST_HORIZON,
  ): CycleForecast | null {
    const { cycleDays, transitDays } = this.params;
    if (transitDays <= 0 || cycleDays <= 0) return null;
    const need = Math.ceil(cycleDays + transitDays) + 2;
    return super.forecast(col, row, fromDay, Math.max(horizonDays, need));
  }

  override expectedIntervalDays(): number {
    return this.params.cycleDays;
  }

  override describe(): CycleDescription {
    return {
      key: this.key,
      kind: this.kind,
      label: 'the cleansing sweep',
      periodDays: this.params.cycleDays,
      flags: ['beam', 'focus'],
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

    out.heat += heatAmplitude * w * state.heatPhase;
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
    return {
      key: this.key,
      kind: this.kind,
      label: 'the turning year',
      periodDays: this.params.periodDays,
      flags: ['heatwave', 'freeze', 'storm', 'drought'],
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
    return {
      key: this.key,
      kind: this.kind,
      label: 'the shifting deeps',
      periodDays: this.params.meanIntervalDays,
      flags: ['quake', 'uplift'],
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
    return {
      key: this.key,
      kind: this.kind,
      label: 'the fire below',
      periodDays: this.params.meanIntervalDays,
      flags: ['eruption', 'focus', 'ashfall'],
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
    return {
      key: this.key,
      kind: this.kind,
      label: 'the rains',
      periodDays: this.params.periodDays,
      flags: ['storm'],
      params: { ...this.params },
    };
  }
}

// ===========================================================================
// Configuration — what a Game Master actually writes
// ===========================================================================

export type CycleSpec =
  | ({ kind: 'solarbeam'; key?: string } & Partial<SolarBeamParams>)
  | ({ kind: 'seasons'; key?: string } & Partial<SeasonsParams>)
  | ({ kind: 'tectonics'; key?: string } & Partial<TectonicsParams>)
  | ({ kind: 'volcanism'; key?: string } & Partial<VolcanismParams>)
  | ({ kind: 'monsoon'; key?: string } & Partial<MonsoonParams>);

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

  /** The validated prototype: beam only, 60d transit / 360d cycle. */
  anvil: [{ kind: 'solarbeam', transitDays: 60, cycleDays: 360 }],

  /** A living world: weather and geology, no god. Gentle, and still never static. */
  garden: [
    { kind: 'seasons' },
    { kind: 'monsoon' },
    { kind: 'tectonics', meanIntervalDays: 200 },
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
   * Note WHICH knob moved. Lengthening the cycle to 480 helped a little (2% -> 8%);
   * shortening the TRANSIT to 45 helped far more (-> 13% floor, 28.4% mean), because
   * transit is dwell time and dwell time is what sterilises. That is the two-knobs
   * finding from SIMULATION.md restated for a five-cycle world: when a GM adds cycles,
   * the first thing to reach for is a faster beam, not a rarer one.
   */
  crucible: [
    { kind: 'solarbeam', transitDays: 45, cycleDays: 420 },
    { kind: 'seasons' },
    { kind: 'monsoon', phaseDays: 180 },
    { kind: 'tectonics' },
    { kind: 'volcanism' },
  ],
};

// ---------------------------------------------------------------------------

function mod(v: number, n: number): number {
  return ((v % n) + n) % n;
}
