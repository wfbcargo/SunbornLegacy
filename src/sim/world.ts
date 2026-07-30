/**
 * The world: terrain state, climate, the solar sweep, and the cleansing beam.
 *
 * TIME MODEL
 *   1 tick            = 6 real seconds
 *   1 revolution      = 14,400 ticks = 1 real day. The sun's gaze crosses the world.
 *   1 sweep step      = one band of columns evaluated as the gaze passes over it.
 *
 * Every tile is therefore evaluated exactly once per real day, and transition
 * medians are expressed in days — which is the granularity at which terrain change
 * should be legible to a player who checks in a couple of times a day.
 *
 * The gaze is a BAND, not a random subset. Neighbours load and write together, no
 * tile is ever evaluated against neighbours in inconsistent update states, and the
 * whole thing is visible in the fiction: the world changes where the sun is looking.
 */

import { HexTorus } from './hex.ts';
import { medianToProbability, mulberry32, rollAt } from './rng.ts';
import {
  ARID, BIOME_COUNT, Biome, BIOMES, COLD, DRY, GLACIAL, MOIST, RULES_BY_BIOME,
  SCORCHING, WARM, WET, type TileContext,
} from './biomes.ts';
import {
  CycleEffect, CycleFlag, SolarBeam, TerrainClass, makeCycle,
  type CycleForecast, type CycleSpec, type WorldCycle, type WorldView,
} from './cycles.ts';

export const TICKS_PER_DAY = 14_400;

/**
 * `TerrainClass` bits per biome id — the taxonomy `WorldView.terrainAt` hands a
 * world-reading cycle.
 *
 * ★ DERIVED FROM `BiomeDef` PREDICATES, NEVER HAND-ENUMERATED, for the same reason
 * `SEA`, `DROWNABLE` and `FREEZABLE` are: a hand-written list of "which ids count as
 * sea" is a biome that silently stops being sea the day someone adds one. It lives here
 * rather than in `cycles.ts` because `biomes.ts` already imports `CycleFlag`, and a
 * cycle between those two files would be a module-evaluation-order hazard rather than a
 * design. Decision `0015`.
 */
const TERRAIN_CLASS: Uint8Array = (() => {
  const table = new Uint8Array(BIOME_COUNT);
  for (const def of BIOMES) {
    let bits = 0;
    if (def.water && !def.molten) bits |= TerrainClass.Sea;
    if (def.molten) bits |= TerrainClass.Molten;
    if (def.stone) bits |= TerrainClass.Stone;
    table[def.id] = bits;
  }
  return table;
})();

/**
 * Default columns evaluated per sweep step.
 *
 * `width` does NOT have to be a multiple of this. `stepDay()` runs
 * `ceil(width / bandWidth)` steps and the day's LAST band is short rather than a full
 * band that wraps — see `step()`. Any width ages evenly; decision `0006`.
 */
export const DEFAULT_BAND_WIDTH = 8;

// ---------------------------------------------------------------------------
// The thermal filter — stored temperature, water coupling, distance falloff
// ---------------------------------------------------------------------------

/**
 * Relaxation rate per visit (= per day) for LAND.
 *
 * A tile's heat used to be a pure function of its neighbourhood, recomputed on every
 * visit, so "the temperature changes more slowly near water" had nothing to slow down.
 * `temperature` is that missing state and these are its time constants: land settles in
 * a handful of days, the sea takes a season.
 */
export const THERMAL_ALPHA_LAND = 0.5;
/**
 * Relaxation rate per visit for TRUE WATER (`water && !molten`).
 *
 * 0.023 is a ~43-day time constant, which against the 360-day year puts the sea's
 * seasonal peak ~37 days behind the land's at ~80% of its amplitude. That lag IS the
 * feature: the anomaly it creates is what the coupling below carries inland.
 */
export const THERMAL_ALPHA_WATER = 0.023;

/**
 * Coupling weight at the shoreline. `w(d) = WATER_COUPLING * exp(-(d-1)/WATER_COUPLING_FOLD)`,
 * zero beyond `WATER_REACH`, and 0 on water itself.
 *
 * ★ THIS NUMBER IS SPENT OUT OF INVARIANT 8's HEADROOM, and the trade is close to
 * linear — see the spec's table. It is not a free "more maritime climate" dial.
 */
export const WATER_COUPLING = 0.6;
/** e-folding distance of the falloff, in hexes. */
export const WATER_COUPLING_FOLD = 2;
/** Hexes the water field is propagated. Beyond this a tile is inland, full stop. */
export const WATER_REACH = 6;

/** `w(d)`, precomputed. Index 0 is water itself and is deliberately 0. */
const COUPLING_WEIGHT = (() => {
  const w = new Float64Array(WATER_REACH + 1);
  for (let d = 1; d <= WATER_REACH; d++) {
    w[d] = WATER_COUPLING * Math.exp(-(d - 1) / WATER_COUPLING_FOLD);
  }
  return w;
})();

/** Sentinel in `waterDist` for "further from water than WATER_REACH". */
const NO_WATER = 255;

export interface WorldOptions {
  width: number;
  height: number;
  seed: number;
  /** Columns evaluated per sweep step. */
  bandWidth?: number;
  /**
   * The world's disturbance engine. Any number of cycles in any combination — the
   * beam is just one of them, and a world with none of them freezes (SIMULATION.md).
   * This array IS the world's identity and difficulty, and it is what a Game Master
   * configures. Specs are plain serialisable objects; instances are also accepted.
   */
  cycles?: (CycleSpec | WorldCycle)[];

  // -- Legacy single-beam options. Sugar for one `solarbeam` cycle; kept so the
  //    existing sweep/diagnose harnesses and their recorded results still run.
  /** Enable the cleansing beam. */
  beam?: boolean;
  /**
   * Real days for the beam to cross the world once. This is SEVERITY: it sets how
   * long any single tile spends under the beam. A slow transit bakes each tile for
   * many days and sterilises it permanently.
   */
  beamTransitDays?: number;
  /**
   * Real days from the start of one purge to the start of the next. This is
   * RECOVERY TIME. Between purges the beam is dormant and the world grows back.
   */
  beamCycleDays?: number;
  /** Width of the beam in columns. */
  beamWidth?: number;
  seaLevel?: number;
}

export class World {
  readonly grid: HexTorus;
  readonly seed: number;

  readonly biome: Uint8Array;
  readonly moisture: Float32Array;
  /**
   * Stored temperature — the state the thermal filter relaxes. This is what a rule
   * reads as `TileContext.heat` (plus any ACUTE cycle heat, which bypasses the filter).
   */
  readonly temperature: Float32Array;
  /**
   * The equilibrium heat `H` as of each tile's last visit.
   *
   * Stored rather than recomputed for one reason: the water field below needs a water
   * tile's thermal ANOMALY (`T - H`), and recomputing `heatAt` for every water tile
   * during the daily field refresh would be a second neighbour gather over the whole
   * sea. Being one visit stale is correct as well as cheap — the field is resolved at
   * the START of the day, so every land tile reads the same snapshot whatever order the
   * sweep reaches them in.
   */
  readonly heatBase: Float32Array;
  /**
   * Worldgen elevation, 0..1. WRITTEN ONCE IN `generate()` AND NEVER AGAIN.
   *
   * ★ WHY IT HAS TO BE STORED AT ALL. It looks recoverable from `heatOffset`, and it is
   * not: that term is `-34 * max(0, elev - 0.5) + (rough - 0.5) * 10`, which is FLAT for
   * every tile below 0.5 and contaminated by an independent roughness field above it. Half
   * the world would read as one elevation and the other half would read as elevation plus
   * noise — and the downhill gate would then be a random gate, which is the one thing that
   * is worse than no gate (see `TileContext.upstreamRiverNeighbours`). 4 bytes/tile: 138 KiB
   * at 240×144, 983 KiB at the viewer's 640×384 ceiling.
   *
   * ★ AND WHY IT IS STATIC. Subsidence and orogeny move the BIOME, never the height —
   * `ground subsides` writes Shallows onto a tile whose elevation is unchanged. A mutable
   * elevation field feeding `heatOffset` would be a neighbour-blind, spatially broad,
   * self-reinforcing heat term: the albedo runaway that sterilised a world (bug #4), with a
   * longer fuse and no cap. Nothing in the stepping path writes here. Decision `0018`.
   */
  readonly elevation: Float32Array;
  /** Static per-tile climate offsets from worldgen (elevation, prevailing damp). */
  private readonly heatOffset: Float32Array;
  private readonly moistOffset: Float32Array;

  /** Hexes to the nearest true water, or `NO_WATER`. Refreshed once a day. */
  private readonly waterDist: Uint8Array;
  /** Mean thermal anomaly of the water reaching this tile. Refreshed once a day. */
  private readonly waterAnomaly: Float32Array;
  /** BFS frontier for the water field. Every tile is enqueued at most once. */
  private readonly fieldQueue: Int32Array;

  private readonly bandWidth: number;

  /** The world's cycles. Order is irrelevant — contributions are additive. */
  readonly cycles: readonly WorldCycle[];
  /**
   * Today's per-cycle derived state, refreshed once a day. Dormant cycles resolve to
   * null and are dropped from `activeCycles` entirely, so a beam between purges and a
   * volcano between eruptions cost nothing per tile.
   */
  private readonly cycleStates: unknown[] = [];
  private readonly activeCycles: WorldCycle[] = [];
  private cycleStatesDay = -1;
  /** Reused per tile. Cycles only ever accumulate into it; no allocation on the loop. */
  private readonly effect = new CycleEffect();
  /** This world as a read-only window, handed to every `dayState`. */
  private readonly worldView: WorldView;

  /** Leading column of the sun's gaze. */
  private gaze = 0;
  private steps = 0;
  private readonly stepsPerDay: number;

  private readonly counts = new Int32Array(BIOME_COUNT);

  constructor(opts: WorldOptions) {
    this.grid = new HexTorus(opts.width, opts.height);
    this.seed = opts.seed;
    this.bandWidth = opts.bandWidth ?? DEFAULT_BAND_WIDTH;
    this.stepsPerDay = Math.ceil(opts.width / this.bandWidth);

    const specs: (CycleSpec | WorldCycle)[] =
      opts.cycles ??
      (opts.beam
        ? [{
            kind: 'solarbeam' as const,
            // ★ EXPLICITLY `band`. These options are sugar for the ORIGINAL beam, and
            // `beamWidth` is a band width in columns — a knob a blob does not have. The
            // sweep and diagnose harnesses and every number they recorded were taken
            // with a band, so the sugar keeps meaning what it meant even though the
            // catalogue default is now a blob.
            shape: 'band' as const,
            transitDays: opts.beamTransitDays ?? 60,
            cycleDays: opts.beamCycleDays ?? 360,
            widthCols: opts.beamWidth ?? 8,
          }]
        : []);
    this.cycles = specs.map((s) =>
      (typeof (s as WorldCycle).dayState === 'function' ? (s as WorldCycle) : makeCycle(s as CycleSpec))
        .bind(opts.width, opts.height, opts.seed),
    );
    const n = this.grid.size;
    this.biome = new Uint8Array(n);
    this.moisture = new Float32Array(n);
    this.temperature = new Float32Array(n);
    this.heatBase = new Float32Array(n);
    this.elevation = new Float32Array(n);
    this.heatOffset = new Float32Array(n);
    this.moistOffset = new Float32Array(n);
    this.waterDist = new Uint8Array(n);
    this.waterAnomaly = new Float32Array(n);
    this.fieldQueue = new Int32Array(n);

    this.generate(opts.seaLevel ?? 0.44);
    this.seedTemperature();

    // A plain object rather than `this` on purpose: handing a cycle the `World` would
    // hand it `stepDay`, `biome` and the hydrology, and a cycle that can step the world
    // is a cycle that can recurse into itself. Four members is the whole affordance.
    // Built here, not as a field initializer, because field initializers run before the
    // constructor body and `this.grid` does not exist yet at that point.
    this.worldView = {
      width: this.grid.width,
      height: this.grid.height,
      biomeAt: (col, row) => this.biome[this.grid.index(col, row)]!,
      moistureAt: (col, row) => this.moisture[this.grid.index(col, row)]!,
      terrainAt: (col, row) => TERRAIN_CLASS[this.biome[this.grid.index(col, row)]!]!,
    };

    // ★ AFTER `generate`, NOT BEFORE. This used to be the first thing the constructor
    // did, which was invisible only for as long as no cycle read the world: `dayState`
    // was handed a `WorldView` over a `biome` array that did not exist yet, so a
    // world-reading cycle either threw during construction or — worse — guarded itself
    // and silently resolved day 0 against nothing. Moving it costs nothing and was
    // verified behaviour-preserving: both golden hashes are unchanged by the move alone.
    //
    // ★ AND IT MUST STAY THE ONLY THING HERE THAT TOUCHES A CYCLE. `refreshCycles` calls
    // `dayState` once per cycle; it must never grow into a call to `affect`, which is
    // per TILE. `invariants.ts` §9 counts `affect` calls to measure the sweep and asserts
    // the constructor makes zero — a day-0 pass that called `affect` on every tile would
    // read as a whole extra sweep and turn that check red for a reason unrelated to it.
    // That is why `seedTemperature` above resolves `heatAt` with no cycle contribution
    // rather than by building a real `TileContext`.
    this.refreshCycles(0);
    this.refreshWaterField();
  }

  /**
   * Day-0 temperature: every tile starts at its own GEOGRAPHIC equilibrium.
   *
   * Load-bearing, and the choice of "geographic" over "today's equilibrium" is the
   * whole point. Cycle heat is excluded deliberately — day 0 is the seasonal peak
   * (`cos 0 = 1`), and seeding a 43-day filter at the summer maximum is seeding it with
   * a whole season of error that then takes hundreds of days to leak out. The annual
   * mean of the ambient channel is zero, so the cycle-free equilibrium IS the correct
   * initial condition for the slow water filter, and land relaxes out of any residual
   * within a handful of days at alpha 0.5.
   *
   * Same discipline as the moisture seed in `generate`: day 0 must already be a
   * consistent state, not a state the first hundred days are spent recovering from.
   */
  private seedTemperature(): void {
    const { grid, biome, temperature, heatBase } = this;
    const counts = new Int32Array(BIOME_COUNT);
    for (let i = 0; i < grid.size; i++) {
      counts.fill(0);
      let openWater = 0;
      let ice = 0;
      for (let d = 0; d < 6; d++) {
        const nb = biome[grid.neighbourAt(i, d)]! as Biome;
        counts[nb]!++;
        const def = BIOMES[nb]!;
        if (def.water && !def.molten) {
          if (nb === Biome.FrozenSea) ice++;
          else openWater++;
        }
      }
      const h = this.heatAt(i, biome[i]! as Biome, counts, openWater, ice, 0);
      temperature[i] = h;
      heatBase[i] = h;
    }
  }

  get day(): number {
    return this.steps / this.stepsPerDay;
  }

  get tick(): number {
    return Math.floor(this.day * TICKS_PER_DAY);
  }

  // -------------------------------------------------------------------------
  // Climate
  // -------------------------------------------------------------------------

  /**
   * A torus has no poles, so latitude is a smooth periodic band instead: one hot
   * equator at row 0 and one cold band at row H/2, continuous across the seam.
   */
  private latitudeHeat(row: number): number {
    return 26 * Math.cos((2 * Math.PI * row) / this.grid.height);
  }

  /**
   * The tile's EQUILIBRIUM heat `H` — what its temperature is relaxing towards, not
   * what a rule reads. `TileContext.heat` is the filtered temperature plus acute cycle
   * heat; see `buildContext`.
   *
   * `ambientHeat` is the summed SLOW contribution of every active cycle for this tile
   * today — seasons, and anything else that is a months-long forcing. It replaces the
   * old hardcoded `if (underBeam) heat += 70`, which is now the SolarBeam cycle's own
   * parameter, and the beam no longer comes through here at all: acute heat bypasses
   * the filter entirely, because low-passing a one-day +115 impulse against a melt gate
   * of 120 does not soften the melt chemistry, it deletes it.
   *
   * Cycle heat is deliberately a separate term from albedo: albedo is a FEEDBACK
   * (desert heats its neighbours, which makes more desert) and is capped at 1.2 for
   * that reason, whereas cycle heat is externally scheduled and cannot amplify itself,
   * so it can be large and transient.
   *
   * ★ EVERY NEIGHBOUR-DEPENDENT TERM HERE IS A FEEDBACK LOOP AND MUST BE TINY.
   * That is the lesson of bug #4 (albedo at +2.5 sterilised the world in one purge)
   * and it was learned a second time on the cold side, where an untested
   * `heat -= 0.8 * (glacier + frozenSea)` combined with a glacier self-offset to latch
   * 12.5% of a world into permanently immutable ice. The ice term is gone; what
   * replaced it is a NEGATIVE feedback, documented below.
   */
  heatAt(
    index: number,
    current: Biome,
    counts: Int32Array,
    openWaterNeighbours: number,
    iceNeighbours: number,
    ambientHeat: number,
  ): number {
    let heat = 50 + this.latitudeHeat(this.grid.row(index)) + this.heatOffset[index]!;

    // Maritime moderation is EVAPORATIVE, so it scales with open water. Sea ice caps
    // evaporation — which is exactly why frozen sea is a moisture source of 55 rather
    // than 100 — so it moderates far less. This is the term that replaced the cold
    // albedo, and note that its sign is the safe one: ice makes its surroundings
    // slightly warmer than open water would, which melts ice. A NEGATIVE feedback
    // cannot latch, where the +0.8 cooling it replaced was a positive one that did.
    heat -= 3.0 * openWaterNeighbours + 1.0 * iceNeighbours;

    // Kept deliberately small. A large albedo bonus creates a runaway loop —
    // desert raises neighbour heat, heat cuts moisture retention, low moisture makes
    // more desert — and a single purge then desertifies the world permanently.
    heat += 1.2 * (counts[Biome.Desert]! + counts[Biome.Glass]!);
    heat -= 1.2 * (counts[Biome.Forest]! + counts[Biome.Rainforest]! + counts[Biome.Bloom]!);

    // Lava is a real heat source, not an albedo term — but it is still a NEIGHBOUR
    // term, so it is capped for the same reason. 8 is load-bearing: six lava
    // neighbours contribute 48, so a base-50 tile reaches 98 and lava can never on
    // its own push a neighbour past MOLTEN (120) into more lava. Raise it and you
    // have rebuilt the albedo runaway with a shorter fuse. Melting is gated on the
    // Focus flag rather than on heat precisely so this cannot become a loop.
    heat += 8 * counts[Biome.Lava]!;

    // Self-heat is elevation and latent heat: it depends only on what THIS tile is,
    // never on what its neighbours became, so it cannot amplify. Glacier and frozen
    // sea deliberately carry none — see BiomeDef.selfHeat.
    heat += BIOMES[current]!.selfHeat;

    return heat + ambientHeat;
  }

  // -------------------------------------------------------------------------
  // Simulation
  // -------------------------------------------------------------------------

  /**
   * Resolve every cycle's state for one day.
   *
   * Runs once per day per cycle, not per tile. Each `dayState` is a pure function of
   * (worldSeed, cycleKey, day) with no accumulated state, so calling this for day N
   * without ever having called it for day N-1 gives exactly the same answer — which is
   * what makes lazy fast-forwarding of an unobserved region possible at all.
   */
  private refreshCycles(day: number): void {
    this.cycleStates.length = 0;
    this.activeCycles.length = 0;
    for (const cycle of this.cycles) {
      const state = cycle.dayState(day, this.worldView);
      if (state === null) continue;
      this.activeCycles.push(cycle);
      this.cycleStates.push(state);
    }
    this.cycleStatesDay = day;
  }

  /**
   * Resolve the water-proximity field for one day: one capped multi-source BFS out
   * from every true-water tile, carrying the sea's thermal ANOMALY inland.
   *
   * ★ WHY A FIELD AND NOT NEIGHBOUR DIFFUSION. Diffusing the anomaly between adjacent
   * tiles was prototyped and it LATCHES. In a spatially uniform region the diffusive
   * form reduces to `T <- T + alpha*(1-m)*(H-T)`: the coupling weight multiplies the
   * GLOBAL time constant by `1/(1-m)`, so a coupling strong enough to be felt three
   * tiles inland slows down every tile on the map by the same factor. Measured on
   * `garden` at m=0.9: ice annual max fell 36.3 -> 31.3 against ICE_THAW 28, 18.01% of
   * sea-ice tiles never thawed in a year, and invariant 8 latched at frozensea 2.53% /
   * forest 2.30% against a 2.00% limit. It is structural, not a tuning miss — in any
   * nearest-neighbour scheme `reach ~ 0.5*sqrt(alpha*tau)`, so reach and inertia are
   * the same knob. A field separates them: reach is the BFS cap, inertia is alpha.
   *
   * ★ WHY DAILY AND NOT ONCE AT WORLDGEN. A static field is free and wrong. 4.0% of the
   * tiles inside the maritime band changed their water distance over 260 days on
   * `crucible`, and this epic exists to make coastlines move considerably more than
   * that. Measured cost of the refresh at 240x144: 0.26 ms against a 19.67 ms simulated
   * day, i.e. 1.3%; the per-tile 3-ring gather it replaces cost 5.4%.
   *
   * ★ WHY IT IS DETERMINISTIC (R-004). A multi-source BFS is exactly the shape that
   * violates determinism, so nothing here depends on discovery order. Ring 0 is built
   * by an ascending index scan. A tile discovered at ring `d` then computes its own
   * anomaly by gathering ITS neighbours that sit at ring `d-1`, in fixed direction
   * order 0..5 — a pull, not a push. Ring `d-1` is complete and frozen by then, so the
   * value written is a function of the biome array and the previous day's state alone,
   * not of which source happened to reach the tile first. There is no Set, no Map, and
   * no float sum whose order could vary.
   */
  private refreshWaterField(): void {
    const { grid, biome, temperature, heatBase, waterDist, waterAnomaly, fieldQueue } = this;
    const n = grid.size;

    waterDist.fill(NO_WATER);
    let tail = 0;
    for (let i = 0; i < n; i++) {
      const def = BIOMES[biome[i]!]!;
      // TRUE water only, the same test the hydrology uses: lava is `water` so that it
      // flows, and a lava field must not export a maritime climate.
      if (!def.water || def.molten) continue;
      waterDist[i] = 0;
      // The anomaly is the whole payload. `T - H` is a TRANSIENT: any sustained change
      // in H moves T by the same amount in steady state and drives this to zero, so the
      // DC gain from H to a rule's `heat` stays exactly 1 and no existing feedback's
      // gain changes. The coupling transports lag, never level.
      waterAnomaly[i] = temperature[i]! - heatBase[i]!;
      fieldQueue[tail++] = i;
    }

    let ringStart = 0;
    for (let d = 1; d <= WATER_REACH; d++) {
      const ringEnd = tail;
      if (ringStart === ringEnd) break;
      for (let q = ringStart; q < ringEnd; q++) {
        const u = fieldQueue[q]!;
        for (let k = 0; k < 6; k++) {
          const v = grid.neighbourAt(u, k);
          if (waterDist[v] !== NO_WATER) continue;
          waterDist[v] = d;
          let sum = 0;
          let cnt = 0;
          for (let j = 0; j < 6; j++) {
            const w = grid.neighbourAt(v, j);
            if (waterDist[w] === d - 1) {
              sum += waterAnomaly[w]!;
              cnt++;
            }
          }
          // cnt >= 1 by construction: `u` itself is at ring d-1.
          waterAnomaly[v] = sum / cnt;
          fieldQueue[tail++] = v;
        }
      }
      ringStart = ringEnd;
    }
  }

  /**
   * Everything that is resolved once per day, before the sweep touches a tile.
   *
   * The order is not arbitrary: the water field reads `temperature` and `heatBase` as
   * they stood at the end of yesterday, and the cycle states are what today's tiles
   * will be evaluated against. Both are snapshots, which is what keeps the day's result
   * independent of where the gaze happens to be when a question is asked.
   */
  private beginDay(day: number): void {
    this.refreshCycles(day);
    this.refreshWaterField();
  }

  /**
   * Advance the gaze one band.
   *
   * ★ THE DAY'S LAST BAND IS SHORT, NOT WRAPPED.
   * `stepsPerDay` is `ceil(width / bandWidth)`, so when the width is not a multiple of
   * the band the final step of a revolution has fewer than `bandWidth` columns left in
   * it. Evaluating a full band there runs past the end and lands back on columns already
   * done today: measured with an observer cycle counting `affect` calls, width 250 at
   * band 8 gave 1.024 evaluations/column/day, six columns doubled, and the doubled band
   * DRIFTS as the days go by. Nothing crashes and no output shows it — the world just
   * ages a couple of percent fast in a moving stripe. So the count is what is left in
   * the revolution, and `gaze` never passes `width`.
   *
   * `gaze` is exactly `(steps % stepsPerDay) * bandWidth`: it starts a revolution at 0,
   * the per-step counts sum to `width`, and the modulo returns it to 0 for the next one.
   * Widths that already divided evenly take the `bandWidth` branch of the `min` on every
   * step, so their behaviour is bit-identical to before this fix — which is why the
   * 160-wide golden worlds did not move. Decision `0006`.
   */
  step(): void {
    const { grid, biome, counts } = this;
    const day = Math.floor(this.day);
    if (day !== this.cycleStatesDay) this.beginDay(day);

    // Columns remaining in this revolution. Always >= 1: gaze is in [0, width).
    const cols = Math.min(this.bandWidth, grid.width - this.gaze);

    for (let b = 0; b < cols; b++) {
      // In range by construction — gaze + cols <= width — so no wrap is needed here.
      const col = this.gaze + b;

      for (let row = 0; row < grid.height; row++) {
        const i = row * grid.width + col;
        this.evaluateTile(i, day, col, row, counts, biome);
      }
    }

    this.gaze = (this.gaze + cols) % grid.width;
    this.steps++;
  }

  /** Advance one full revolution — every tile evaluated once. */
  stepDay(): void {
    for (let s = 0; s < this.stepsPerDay; s++) this.step();
  }

  /**
   * Everything a rule can see about one tile today, WITHOUT advancing it.
   *
   * Exists so `invariants.ts` can ask the question that climate-space satisfiability
   * cannot answer: not "could this rule fire in some climate", but "can the tile that
   * IS this biome ever reach that climate on this world". Those are different
   * questions, and the gap between them is where absorbing states hide — a review of
   * the first draft found 12.5% of a world made of tiles with zero live out-rules
   * under any climate their world could actually produce, while every rule in the file
   * was individually satisfiable and the graph was a single component.
   *
   * Note this RELAXES moisture and temperature rather than reading them back: it is a
   * preview of what `evaluateTile` would see, computed on copies, so calling it never
   * perturbs the simulation. Reading the stored values instead would report a tile one
   * day stale, and invariant 8 — which calls this for every tile every third day —
   * would then be asking about a world the simulator is not running.
   */
  inspect(index: number): TileContext {
    const day = Math.floor(this.day);
    if (day !== this.cycleStatesDay) this.beginDay(day);
    const counts = new Int32Array(BIOME_COUNT);
    return this.buildContext(index, this.grid.col(index), this.grid.row(index), counts, false);
  }

  /** Number of transition rules whose precondition is satisfied on this tile today. */
  liveRuleCount(index: number, ctx = this.inspect(index)): number {
    const rules = RULES_BY_BIOME[ctx.biome]!;
    let n = 0;
    for (let r = 0; r < rules.length; r++) if (rules[r]!.when(ctx) > 0) n++;
    return n;
  }

  /**
   * Gather neighbours, resolve climate, and (when `commit`) relax this tile's
   * temperature and moisture.
   *
   * Shared by the simulation and by `inspect`, deliberately: a second implementation
   * of the hydrology for the introspection path would drift from the first, and an
   * invariant checker reading a slightly different world than the simulator runs is
   * worse than no invariant checker.
   */
  private buildContext(
    i: number,
    col: number,
    row: number,
    counts: Int32Array,
    commit: boolean,
  ): TileContext {
    const { biome, moisture } = this;

    // Cycles compose by accumulation: `+=` for heat and moisture, `|=` for flags.
    // No cycle reads another's contribution, so there is no ordering dependency and
    // no combination needs special-casing — a quake during a purge is just
    // `Beam | Quake` and the ruleset can key off it if it wants to.
    const effect = this.effect.reset();
    const active = this.activeCycles;
    for (let c = 0; c < active.length; c++) {
      active[c]!.affect(this.cycleStates[c], effect, col, row);
    }

    counts.fill(0);
    let waterNeighbours = 0;
    let openWaterNeighbours = 0;
    let iceNeighbours = 0;
    let moistureSum = 0;
    let riverRing = 0;
    let upstreamRiverNeighbours = 0;
    let downhillNeighbours = 0;

    const myElevation = this.elevation[i]!;
    for (let d = 0; d < 6; d++) {
      const nb = this.grid.neighbourAt(i, d);
      const nbBiome = biome[nb]! as Biome;
      const def = BIOMES[nbBiome]!;
      counts[nbBiome]!++;
      // TRUE water only. Lava is water:true so that it flows, but counting it here
      // would let a lava field irrigate and cool the desert around it — the exact
      // opposite of what a lava field does.
      //
      // ★ AND RIVER IS NOT WATER, WHICH IS LOAD-BEARING RATHER THAN INCIDENTAL. `SEA` is
      // derived from `BiomeDef` and this test is `water && !molten`, so a `water: false`
      // river is STRUCTURALLY excluded from every piece of coastline arithmetic in the
      // simulator — drowning, deposition, evaporation, subsidence, the maritime thermal
      // field and `TERRAIN_CLASS.Sea` alike — without any of them naming it. Decision
      // `0019` records the measured counterfactual. Do not add a river branch here.
      if (def.water && !def.molten) {
        waterNeighbours++;
        if (nbBiome === Biome.FrozenSea) iceNeighbours++;
        else openWaterNeighbours++;
      }
      // The river ring, in DIRECTION order — `hex.ts` walks the ring cyclically at both
      // row parities, so bit `d` and bit `(d+1)%6` are 60° apart and `CHANNEL_OK` can read
      // "widening" off the mask. `>` and not `>=`: a flat pair is not a downhill pair, and
      // on the smooth fbm field ties are the interior of a basin.
      const nbElevation = this.elevation[nb]!;
      if (nbBiome === Biome.River) {
        riverRing |= 1 << d;
        if (nbElevation > myElevation) upstreamRiverNeighbours++;
      }
      if (nbElevation < myElevation) downhillNeighbours++;
      moistureSum += moisture[nb]!;
    }

    const current = biome[i]! as Biome;
    const def = BIOMES[current]!;

    // -- The thermal filter -------------------------------------------------
    //
    //   H      = heatAt(...) + ambientHeat        today's equilibrium
    //   target = H + w(d) * A                     A = anomaly of the water reaching us
    //   T     += (target - T) * alpha             land 0.5, water 0.023
    //   heat   = T + effect.heat                  ★ ACUTE cycle heat BYPASSES the filter
    //
    // ★ THE LAST LINE IS NOT A SHORTCUT. `Focus` dwell under the blob beam is exactly
    // one day and carries heat 70 + focusHeat 45 = +115 against `melting`'s
    // `heat > MOLTEN (120)` gate. At alpha 0.5 a one-day +115 impulse delivers +57.5 and
    // nothing on the world ever melts again — no lava, so no basalt, no glass, no
    // fertile soil. Seasons THROUGH the filter is what delivers maritime climate; the
    // beam through the filter deletes a third of the chemistry. That is what the two
    // channels on `CycleEffect` are for.
    const equilibrium = this.heatAt(i, current, counts, openWaterNeighbours, iceNeighbours, effect.ambientHeat);

    // Distance falloff. `waterDist` is 0 on water (which reads nothing — the field is
    // one-directional, so there is no loop to close) and NO_WATER past the reach.
    const dist = this.waterDist[i]!;
    const target = dist === 0 || dist > WATER_REACH
      ? equilibrium
      : equilibrium + COUPLING_WEIGHT[dist]! * this.waterAnomaly[i]!;

    // Water is the slow one, and it is what makes the anomaly exist at all.
    const alpha = def.water && !def.molten ? THERMAL_ALPHA_WATER : THERMAL_ALPHA_LAND;
    const t = this.temperature[i]!;
    const nextT = t + (target - t) * alpha;
    if (commit) {
      this.temperature[i] = nextT;
      this.heatBase[i] = equilibrium;
    }
    const heat = nextT + effect.heat;

    // Hydrology: open water is a saturated source, heat is the sink, and moisture
    // diffuses between them. That gives continents a real interior gradient —
    // wet coasts, arid hearts — and makes the equatorial band dry out on its own
    // instead of needing a hand-authored desert belt.
    //
    // The source strength is PER BIOME, not a flat 100 for anything water:true. Frozen
    // sea is water for the coastline's purposes but a weak source (55) because ice
    // caps evaporation, and lava is water for flow's purposes but a source of 0 — it
    // falls through to the diffusion branch below like any other dry tile.
    let wet: number;
    if (def.moistureSource > 0) {
      wet = def.moistureSource;
    } else {
      // Heat acts as a multiplicative decay on how far moisture carries, not as a
      // flat subtraction — a flat sink compounds across diffusion steps and drives
      // every inland tile to zero. Retention per tile: temperate land carries
      // moisture deep inland, hot land goes arid within a dozen tiles.
      // Because the target averages six neighbours, this is a diffusion equation,
      // not a 1-D product: moisture falls off as exp(-sqrt(2(1-r))·distance), so
      // retention has to sit very close to 1. At r=0.995 the decay is ~0.1/tile and
      // every continental interior is bone dry; at 0.9998 it is ~0.02/tile, which
      // carries rain properly inland and leaves the hot band arid on its own.
      const neighbourAvg = moistureSum / 6;
      const retention = 0.9998 - Math.max(0, heat - 52) * 0.0006;
      let target = neighbourAvg * Math.max(0.5, retention);
      // Wetland — and now river — neighbours push the diffusion target up. A river is
      // standing fresh water, so a valley floor beside one is humid; this is the channel
      // through which the biome is "wet" at all, and it is a LAND-side channel. It moves
      // moisture, never the coastline.
      target += 2 * (counts[Biome.Marsh]! + counts[Biome.Swamp]! + counts[Biome.River]!) +
        this.moistOffset[i]! * 0.05;
      // Cycle moisture enters as an additive push on the diffusion TARGET — the same
      // channel marsh neighbours use — never as a change to the retention constant.
      // Bug #1 (retention 0.9998) and bug #2 (heat is a multiplicative decay, not a
      // flat sink) live in the two lines above and must stay out of reach of cycles.
      target += effect.moisture;
      const next = moisture[i]! + (target - moisture[i]!) * 0.5;
      wet = next < 0 ? 0 : next > 100 ? 100 : next;
    }
    if (commit) moisture[i] = wet;

    return {
      biome: current,
      heat,
      moisture: wet,
      waterNeighbours,
      neighbourCounts: counts,
      riverRing,
      upstreamRiverNeighbours,
      downhillNeighbours,
      flags: effect.flags,
      underBeam: (effect.flags & CycleFlag.Beam) !== 0,
    };
  }

  private evaluateTile(
    i: number,
    day: number,
    col: number,
    row: number,
    counts: Int32Array,
    biome: Uint8Array,
  ): void {
    const ctx = this.buildContext(i, col, row, counts, true);

    // Evaluate every applicable rule independently. First one to fire wins; the
    // ordering bias is negligible because per-visit probabilities are small.
    //
    // ★ THE ROLL IS KEYED ON `rule.keyHash`, NEVER ON `r`.
    // `r` is the rule's position in its bucket, so keying on it made every rule's dice
    // a function of the order rules happen to sit in the RULES array: inserting one
    // renumbered every rule after it and silently changed unrelated outcomes. keyHash
    // is derived from the rule's own content, so a rule's dice belong to the rule. See
    // `ruleKey` in biomes.ts.
    const rules = RULES_BY_BIOME[ctx.biome]!;
    for (let r = 0; r < rules.length; r++) {
      const rule = rules[r]!;
      const pressure = rule.when(ctx);
      if (pressure <= 0) continue;
      const p = medianToProbability(rule.medianDays / pressure);
      if (rollAt(this.seed, i, day, rule.keyHash) < p) {
        biome[i] = rule.to;
        return;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Cycle introspection — the API surface
  // -------------------------------------------------------------------------

  /**
   * Every cycle's next acute effect on a tile, soonest first, in REAL DAYS.
   *
   * This is the general form of "how long until the purge reaches my column?" — and
   * because every cycle is a pure function of (worldSeed, key, day), the same question
   * is answerable for the rains, for winter, and for the fault under the valley,
   * through one interface and without touching the live simulation.
   */
  forecast(col: number, row: number, horizonDays?: number): CycleForecast[] {
    const out: CycleForecast[] = [];
    for (const cycle of this.cycles) {
      const f = cycle.forecast(col, row, this.day, horizonDays, this.worldView);
      if (f !== null) out.push(f);
    }
    return out.sort((a, b) => a.daysUntil - b.daysUntil);
  }

  /** Find a cycle by key, for targeted queries. */
  cycle(key: string): WorldCycle | undefined {
    return this.cycles.find((c) => c.key === key);
  }

  /** The first solar beam on this world, if it has one. */
  get beam(): SolarBeam | undefined {
    return this.cycles.find((c) => c instanceof SolarBeam) as SolarBeam | undefined;
  }

  /** True while a purge is in progress. Between purges the beam is dormant. */
  get purgeActive(): boolean {
    return this.beam?.active(Math.floor(this.day)) ?? false;
  }

  /** Leading column of the beam, or -1 when dormant or absent. */
  beamColumn(): number {
    return this.beam?.column(Math.floor(this.day)) ?? -1;
  }

  /**
   * Where the beam is today, or null when dormant or absent.
   *
   * ★ A COLUMN IS NO LONGER AN ANSWER. Under the default blob shape the beam is a disc
   * on a sinusoidal track, so "which column" leaves out the half of the position that
   * decides whether a tile is under it. `row: -1` is returned for a band beam, which
   * genuinely occupies every row of its columns — the honest encoding of "all of them".
   */
  beamPosition(): { col: number; row: number } | null {
    return this.beam?.position(Math.floor(this.day)) ?? null;
  }

  /**
   * Real days until the beam next reaches a TILE — the warning a player gets.
   *
   * ★ IT TAKES A ROW, and the row is not optional. This used to ask about a column and
   * hardcode row 0, which was harmless under a band (every row of a column is under it
   * at once) and badly wrong under a blob: measured on the shipped track at radius 2, the
   * column-and-row-0 form returned `Infinity` for 172 of 240 columns, because row 0 is
   * simply not where the track was.
   *
   * ★ `Infinity` IS AN ANSWER, not a failure. The blob's track is periodic and retraces
   * itself every purge, so a tile it misses is missed for the life of the world. Callers
   * must render "never", not "unknown" and not "soon".
   */
  daysUntilBeam(col: number, row: number): number {
    return this.beam?.forecast(col, row, this.day, undefined, this.worldView)?.daysUntil ?? Infinity;
  }

  // -------------------------------------------------------------------------
  // Worldgen
  // -------------------------------------------------------------------------

  private generate(seaLevel: number): void {
    const { grid } = this;
    const rand = mulberry32(this.seed ^ 0x5eed);
    const elevSeed = (rand() * 1e9) | 0;
    const moistSeed = (rand() * 1e9) | 0;
    const roughSeed = (rand() * 1e9) | 0;

    for (let row = 0; row < grid.height; row++) {
      for (let col = 0; col < grid.width; col++) {
        const i = row * grid.width + col;

        const elev = this.fbm(col, row, elevSeed, 3);
        const damp = this.fbm(col, row, moistSeed, 4);
        const rough = this.fbm(col, row, roughSeed, 5);

        // The ONE write to `elevation`, for the life of the world. See the field.
        this.elevation[i] = elev;
        // Elevation cools, and adds regional variety beyond pure latitude. Note this is
        // lossy in both directions — clamped below 0.5 and mixed with `rough` above it —
        // which is exactly why the raw field above is kept rather than inverted from here.
        this.heatOffset[i] = -34 * Math.max(0, elev - 0.5) + (rough - 0.5) * 10;
        this.moistOffset[i] = (damp - 0.5) * 26;

        const heat = 50 + this.latitudeHeat(row) + this.heatOffset[i]!;
        const moist = 45 + this.moistOffset[i]! + (damp - 0.5) * 30;

        const b = this.seedBiome(elev, heat, moist, seaLevel);
        this.biome[i] = b;
        // Seed from the SAME per-biome source the simulation uses, so day 0 is already
        // a consistent hydrological state. Reading `water ? 100` here while
        // `evaluateTile` reads `moistureSource` diverges the instant worldgen emits a
        // frozen sea (source 55) or a lava field (source 0), and the divergence shows
        // up as a one-day pulse of phantom moisture that is very hard to attribute.
        const source = BIOMES[b]!.moistureSource;
        this.moisture[i] = source > 0 ? source : Math.max(0, Math.min(100, moist));
      }
    }
  }

  /**
   * Day-0 biome for a tile.
   *
   * Every family must be represented at worldgen. A world that starts with no
   * mountains, no wetlands and no rainforest does eventually find them — but through
   * the slowest edges in the graph, so it takes game-centuries and the first
   * measurement window reports a world that is missing a third of its taxonomy. The
   * arms below are climate-plausible seeds, not a shortcut around the ruleset: every
   * one of them is somewhere the corresponding transition rule would have put it.
   */
  private seedBiome(elev: number, heat: number, moist: number, seaLevel: number): Biome {
    if (elev < seaLevel - 0.04) return heat < GLACIAL ? Biome.FrozenSea : Biome.Ocean;
    if (elev < seaLevel) return heat < GLACIAL ? Biome.FrozenSea : Biome.Shallows;

    // Highland: peaks, then bare stone below them.
    if (elev > 0.82) return Biome.Mountain;
    if (elev > 0.76) return heat < GLACIAL && moist > 45 ? Biome.Glacier : Biome.Rock;

    if (heat < GLACIAL && moist > 45) return Biome.Glacier;
    if (heat < COLD - 2) return moist < DRY && heat < GLACIAL + 6 ? Biome.Rock : Biome.Tundra;

    if (heat > SCORCHING && moist < ARID) return Biome.Desert;
    if (heat > SCORCHING && moist < DRY) return Biome.Savanna;

    if (moist > WET) {
      if (heat > 58 && heat < 82) return Biome.Rainforest;
      if (heat < 58) return Biome.Marsh;
    }
    if (moist > MOIST && heat >= 62) return Biome.Swamp;
    if (moist > MOIST && heat < WARM) return Biome.Forest;
    if (moist > DRY) return heat > WARM ? Biome.Savanna : Biome.Grassland;
    if (moist > ARID) return heat > WARM ? Biome.Savanna : Biome.Grassland;
    if (heat < COLD) return Biome.Tundra;
    if (heat > WARM) return Biome.Desert;
    return Biome.Barren;
  }

  /** Fractal value noise that tiles on the torus, so there is no seam. */
  private fbm(col: number, row: number, seed: number, octaves: number): number {
    let total = 0;
    let amplitude = 1;
    let norm = 0;
    let periodX = 4;
    let periodY = 3;

    for (let o = 0; o < octaves; o++) {
      total += amplitude * this.periodicNoise(col, row, periodX, periodY, seed + o * 7919);
      norm += amplitude;
      amplitude *= 0.5;
      periodX *= 2;
      periodY *= 2;
    }
    return total / norm;
  }

  private periodicNoise(col: number, row: number, periodX: number, periodY: number, seed: number): number {
    const gx = (col / this.grid.width) * periodX;
    const gy = (row / this.grid.height) * periodY;
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const fx = gx - x0;
    const fy = gy - y0;

    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);

    const wrap = (v: number, p: number) => ((v % p) + p) % p;
    const x1 = wrap(x0 + 1, periodX);
    const y1 = wrap(y0 + 1, periodY);
    const xw = wrap(x0, periodX);
    const yw = wrap(y0, periodY);

    const v00 = rollAt(seed, xw, yw);
    const v10 = rollAt(seed, x1, yw);
    const v01 = rollAt(seed, xw, y1);
    const v11 = rollAt(seed, x1, y1);

    const top = v00 + (v10 - v00) * sx;
    const bottom = v01 + (v11 - v01) * sx;
    return top + (bottom - top) * sy;
  }

  // -------------------------------------------------------------------------
  // Inspection
  // -------------------------------------------------------------------------

  /** Proportion of the world occupied by each biome. */
  biomeProportions(): Float64Array {
    const out = new Float64Array(BIOME_COUNT);
    for (let i = 0; i < this.biome.length; i++) out[this.biome[i]!]!++;
    for (let b = 0; b < BIOME_COUNT; b++) out[b]! /= this.biome.length;
    return out;
  }

  /**
   * Shannon entropy of the biome distribution, normalised 0..1.
   * The single best scalar for "is this world still varied, or has it flattened?"
   */
  biomeEntropy(): number {
    const p = this.biomeProportions();
    let h = 0;
    for (let b = 0; b < BIOME_COUNT; b++) {
      const v = p[b]!;
      if (v > 0) h -= v * Math.log(v);
    }
    return h / Math.log(BIOME_COUNT);
  }
}
