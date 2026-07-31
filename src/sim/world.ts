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
import { medianToProbability, rollAt } from './rng.ts';
import {
  BIOME_COUNT, Biome, BIOMES, RULES_BY_BIOME, type TileContext,
} from './biomes.ts';
// The climate thresholds and the noise field moved out with `seedBiome` — worldgen is a
// pure function of position now, and `World.generate` is a loop over it (spec `d53ccbb6-1`).
import {
  latitudeHeat, makeWorldgenTile, worldgenAt, worldgenConfig,
} from './worldgen.ts';
import {
  CycleEffect, CycleFlag, SolarBeam, TerrainClass, makeCycle,
  type BeamSighting, type CycleForecast, type CycleSpec, type WorldCycle, type WorldView,
} from './cycles.ts';

/**
 * Where the world's suns are on one day. See `World.sky`.
 *
 * ★ POSITIONS ONLY, AND NO FORWARD TRACKS. Where the beam is GOING is meant to be read
 * off the ground it has already burned, not off a predicted line — decision `0025`.
 */
export interface WorldSky {
  readonly day: number;
  readonly beams: readonly BeamSighting[];
}

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
// The thermal filter — stored temperature, per-biome mass, neighbour exchange
// ---------------------------------------------------------------------------

/**
 * ★ THE TWO-CLASS `THERMAL_ALPHA_LAND` / `THERMAL_ALPHA_WATER` PAIR IS GONE.
 *
 * Relaxation rate is a property of the material, so it lives on the material:
 * `BiomeDef.thermalAlpha` in `biomes.ts`. They are deleted rather than left at their old
 * values because a constant that reads like a setting and controls nothing is the trap
 * this file has been bitten by before. The land value was 0.5 and the water value 0.023;
 * the water figure survives unchanged on all three true-water rows, which is the anchor
 * the whole maritime lag was measured against. Decision `0026`.
 */

/**
 * Neighbour exchange rate per day — the κ of `T += kappa * (mean(T_neighbours) - T)`.
 *
 * ★ THIS IS A LAPLACIAN, AND THE FORM IS THE WHOLE POINT. Spec `2915cb06-2` prototyped
 * neighbour coupling as a blend toward the mean ANOMALY, `target = H + m*ā`. In a
 * spatially uniform region `ā = a`, so that collapses to `T += alpha*(1-m)*(H-T)`: the
 * coupling weight multiplies the GLOBAL time constant by `1/(1-m)`, slowing down every
 * tile on the map whether or not it sits on a gradient. Measured on `garden` at m=0.9:
 * sea-ice annual max fell 36.3 -> 31.3 against `ICE_THAW` 28, 18.01% of sea-ice tiles
 * never thawed in a year, and invariant 8 latched at frozensea 2.53% / forest 2.30%
 * against a 2.00% limit.
 *
 * `mean(T_nb) - T` cannot do that. In a uniform field it is EXACTLY ZERO, so it cannot
 * multiply any time constant; it acts only where a spatial gradient actually exists.
 * That is a different operator, not a retune of the one that failed.
 *
 * ★ IT IS ALSO A MAX-PRINCIPLE UPDATE, WHICH IS THE REAL STABILITY ARGUMENT. The new
 * value is a convex combination of `T` and the neighbour mean whenever `0 <= kappa <= 1`,
 * so the field can never leave the range it started the day in — no oscillation, no
 * divergence, no matter how sharp the coastline. The stricter `alpha + kappa <= 1` bound
 * below is for the two terms applied TOGETHER, and it is checked per biome at module
 * evaluation rather than asserted in a comment.
 *
 * ★ AND IT IS SHORT-RANGE BY CONSTRUCTION. Steady-state penetration into land is
 * `~sqrt(kappa/alpha)` hexes — at 0.30 against a land alpha near 0.4 that is under one
 * hex, and the measured shoreline reach is 3. It IS the requested "temperature relative
 * to its direct neighbours", and it is also what replaced the maritime BFS below — see
 * the note under it for what that cost.
 */
export const THERMAL_KAPPA = 0.30;

/**
 * Temperate moisture retention on a 1-tile cell — the constant the hydrology comment
 * pins to "~0.02/tile" inland falloff. Heat raises the leak; see `moistureRetention`.
 */
export const MOISTURE_RETENTION_TEMPERATE = 0.9998;
const MOISTURE_LEAK_TEMPERATE = 1 - MOISTURE_RETENTION_TEMPERATE; // 0.0002
const MOISTURE_LEAK_PER_HEAT = 0.0006;

/**
 * How the moisture leak scales when one cell represents many fine tiles.
 *
 * Continuum 2D diffusion from `exp(-sqrt(2(1-r))·d)` implies power **2**
 * (`1-r_coarse = factor²·(1-r_fine)` → r≈0.9872 at factor 8). Measured on `still`
 * 240×144 seed 20260729 after 300d (spec `d53ccbb6-5`):
 *
 *   power 0 (unscaled)  arid  0.00%  meanM 97.2   ← decision 0030's bug
 *   power 1             arid 11.06%  meanM 61.9
 *   power 1.25          arid 22.54%  meanM 48.6   ← fine is 21.74% / 57
 *   power 2 (derived)   arid 62.85%  meanM 22.8   ← overshoots
 *
 * Power 2 fails because the fine inland moisture profile is not a coastal
 * exponential (ladder 5 of the LOD gate: fine reads 51→46→56→69→71→99 going
 * inland). Aridity is heat-driven, not coast-distance-driven, so matching the
 * 2D coastal length scale is matching the wrong thing. 1.25 is the measured
 * calibration that closes the ARID share; decision `0031`.
 */
export const MOISTURE_LEAK_GRID_POWER = 1.25;

/**
 * Moisture retention for one hydrology step on a cell that represents `cellSizeTiles`
 * fine tiles.
 *
 * ★ THE LEAK SCALES WITH `cellSize^MOISTURE_LEAK_GRID_POWER`, NOT WITH `cellSize²`.
 * See the constant above for the measurement that rejected the continuum derivation.
 * The heat term is part of the leak, so it scales with the same power — scaling the
 * base alone and leaving heat fixed leaves coarse arid share at 0% (measured).
 * The `max(0.5, …)` floor is unchanged from the fine tier.
 */
export function moistureRetention(heat: number, cellSizeTiles = 1): number {
  const heatLeak = Math.max(0, heat - 52) * MOISTURE_LEAK_PER_HEAT;
  const leak =
    (MOISTURE_LEAK_TEMPERATE + heatLeak) *
    Math.pow(cellSizeTiles, MOISTURE_LEAK_GRID_POWER);
  return Math.max(0.5, 1 - leak);
}

/**
 * How cycle moisture-push amplitudes shrink on a coarse cell.
 *
 * Spec 6 measured: after the leak scales up (`MOISTURE_LEAK_GRID_POWER`), the
 * seasons moisture sinusoid on the coarse tier is net-drying — summer drought
 * (moisture lags heat by half a year) compounds with the scaled heat leak and
 * clips against the floor. Dividing push amplitudes by `cellSize^(1/3)`
 * (= 2 at factor 8) brings garden/crucible arid within ~10 pp of fine without
 * moving `still`. Decision `0032`.
 */
export const MOISTURE_PUSH_COARSE_POWER = 1 / 3;

export function moisturePushCoarseScale(cellSizeTiles = 1): number {
  return 1 / Math.pow(cellSizeTiles, MOISTURE_PUSH_COARSE_POWER);
}

/**
 * Neighbour-exchange weight for a cell of the given size.
 *
 * Penetration is `~sqrt(κ/α)` in *cells* (`THERMAL_KAPPA`'s own comment). Holding
 * tile-scale reach fixed therefore needs `κ_coarse = κ_fine / factor²`. Decision
 * `0030` listed this as a candidate (coarse land 2–3 units cooler); spec
 * `d53ccbb6-5` co-ships it as the same class of bug as the hydrology leak.
 */
export function thermalKappaFor(cellSizeTiles = 1): number {
  return THERMAL_KAPPA / (cellSizeTiles * cellSizeTiles);
}

/**
 * The stability bound, checked once at module evaluation rather than asserted in prose.
 *
 * An explicit two-term scheme `T += alpha*(H-T) + kappa*(mean(T_nb)-T)` needs
 * `alpha + kappa <= 1` or the tile overshoots its own target every step, and an
 * overshoot that exceeds 1 in magnitude compounds — it oscillates, then diverges. There
 * is no run in which that looks like a subtle bias; it looks like a world of NaN. This
 * throws at import, so a biome table that breaks the bound cannot reach a simulation at
 * all, let alone one whose numbers someone then records.
 *
 * Checked against the fine-tier constant (`cellSizeTiles = 1`). A coarse world uses a
 * *smaller* kappa, so the bound is strictly easier there.
 */
(() => {
  const bad = BIOMES.filter((d) => d.thermalAlpha + THERMAL_KAPPA > 1 || d.thermalAlpha <= 0);
  if (bad.length > 0) {
    throw new Error(
      `Thermal scheme is unstable: ${bad.map((d) => `${d.key} alpha=${d.thermalAlpha}`).join(', ')} ` +
        `against THERMAL_KAPPA=${THERMAL_KAPPA}. Every biome needs 0 < thermalAlpha <= ${1 - THERMAL_KAPPA}.`,
    );
  }
})();

/**
 * ★ THE PER-DAY MARITIME BFS IS GONE — `WATER_COUPLING` 0.6, `WATER_COUPLING_FOLD` 2,
 * `WATER_REACH` 6, the `waterDist` / `waterAnomaly` fields and `refreshWaterField()`.
 *
 * It existed for exactly one reason: neighbour diffusion had been rejected, so distance
 * falloff had to be manufactured. `THERMAL_KAPPA` produces falloff emergently, and the
 * field was then measured to add NOTHING on top of it. Coastal seasonal amplitude at
 * d=1 against the d=6..12 plateau, `garden` 160×96 seed 20260729, 1200d settle + 1 year:
 *
 *     BFS only (as shipped)   -33.45%   reach 4 hexes
 *     Laplacian + BFS         -23.44%   reach 3 hexes
 *     Laplacian, no BFS       -23.60%   reach 3 hexes     <- what runs now
 *
 * 0.16 pp between the last two is what sixty lines and a whole-map BFS were buying.
 *
 * ★ AND THE 10 pp BETWEEN THE FIRST TWO IS A REAL COST, PAID TO THE LAPLACIAN, NOT TO
 * THE DELETION. It is not recoverable by turning kappa up: at kappa 0.40 the shoreline
 * reads -22.62% and the reach is still 3 — WEAKER, not stronger. That is the structural
 * claim the old field's comment made, confirmed from the other side: in a
 * nearest-neighbour scheme reach and inertia are the same knob, so the coupling weight
 * cannot buy reach. Decision `0026`.
 */

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
  /**
   * How many fine tiles one cell of this world represents. Default 1.
   *
   * The coarse tier passes `COARSE_FACTOR` (8) so hydrology retention and
   * `THERMAL_KAPPA` keep the same *tile-scale* length as the fine tier (decision
   * `0031`). A fine world must leave this at 1 — anything else would move the
   * goldens, and specs 1–5 require they do not move.
   */
  cellSizeTiles?: number;
}

export class World {
  readonly grid: HexTorus;
  readonly seed: number;
  /**
   * Fine tiles represented by one cell of this grid. 1 for a fine world;
   * `COARSE_FACTOR` for a coarse one. Drives `moistureRetention` and the instance
   * thermal kappa — see `WorldOptions.cellSizeTiles`.
   */
  readonly cellSizeTiles: number;
  /** `thermalKappaFor(cellSizeTiles)` — cached so the day exchange does not recompute. */
  private readonly thermalKappa: number;

  readonly biome: Uint8Array;
  readonly moisture: Float32Array;
  /**
   * Stored temperature — the state the thermal filter relaxes. This is what a rule
   * reads as `TileContext.heat` (plus any ACUTE cycle heat, which bypasses the filter).
   */
  readonly temperature: Float32Array;
  /**
   * The equilibrium heat `H` as of each tile's last visit. Diagnostic only.
   *
   * ★ IT NO LONGER HAS A READER IN THE STEPPING PATH, and that is deliberate rather than
   * an oversight. It was stored so the maritime BFS could take a water tile's anomaly
   * `T - H` without a second whole-sea neighbour gather; that field is gone. It is kept
   * because `T - H` is still the one number that says whether a tile is ahead of or
   * behind its own climate, which is what every thermal probe this spec needed had to
   * reconstruct — 4 bytes/tile is a cheap price for a field that answers that directly.
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
  /**
   * Where the crust is live, 0..1. Static worldgen geography — WRITTEN ONCE AND NEVER
   * AGAIN, the same discipline as `elevation` and for a related but distinct reason.
   *
   * ★ WHAT IT IS FOR. Permanent mineral geography. The economy separates harvest flows
   * from permanent geology (`ARCHITECTURE.md#7.1`), and regional materials are the supply
   * curve the trade game rests on. Mineral country that is re-rolled every time the beam
   * passes is not geology, so the field that decides it must be one the simulation cannot
   * touch. Independent of `elevation` on purpose: height and crustal activity are separate
   * facts, so a world may hold a high dead plateau and a low active belt.
   *
   * ★ WHY IT IS EXPOSED RAW WHEN ELEVATION IS NOT — read this before adding a third static
   * channel, because the elevation precedent points the other way. Decision `0018` hides
   * elevation behind derived fields because elevation feeds `heatOffset`, so a rule
   * thresholding it sits one step from a self-reinforcing loop. `tectonic` feeds nothing.
   * Nothing in the stepping path writes here and no transition, cycle or feedback can move
   * it, so a raw threshold on it satisfies decision `0021` exactly: a gate may read what
   * the feature cannot create. That is a property of THIS field, not of static fields in
   * general.
   *
   * Read by no rule today (spec `d53ccbb6-2` ships the channel unread, so the golden
   * hashes cannot move). 4 bytes/tile, as `elevation`.
   */
  readonly tectonic: Float32Array;
  /** Static per-tile climate offsets from worldgen (elevation, prevailing damp). */
  private readonly heatOffset: Float32Array;
  private readonly moistOffset: Float32Array;

  /**
   * The frozen field the daily neighbour-exchange pass READS. See `diffuseTemperature`.
   *
   * ★ IT EXISTS BECAUSE THE SWEEP IS BANDED, AND THIS IS THE "temperature chain" THE
   * INTENT NAMES. `step()` evaluates tiles in bands that drift (decision `0006`), so a
   * neighbour-reading update that read the live array would read partially updated
   * values: heat would propagate arbitrarily far in the sweep direction inside a single
   * day, and the artifact would MOVE as the bands move — not even a consistent bias.
   * Copying into this buffer first is what makes the pass a function of yesterday alone.
   *
   * A copy rather than a pointer swap on purpose: `temperature` is a public `readonly`
   * field that the viewer and the probes hold references to, and 138 KiB memcpy at
   * 240×144 is far below the cost of the pass that follows it.
   */
  private readonly temperatureSnapshot: Float32Array;

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

    const cellSize = opts.cellSizeTiles ?? 1;
    if (!Number.isInteger(cellSize) || cellSize < 1) {
      throw new Error(
        `cellSizeTiles must be an integer >= 1 (got ${cellSize}). A fine world uses 1; ` +
          `the coarse tier passes COARSE_FACTOR.`,
      );
    }
    this.cellSizeTiles = cellSize;
    this.thermalKappa = thermalKappaFor(cellSize);

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
    this.temperatureSnapshot = new Float32Array(n);
    this.heatBase = new Float32Array(n);
    this.elevation = new Float32Array(n);
    this.tectonic = new Float32Array(n);
    this.heatOffset = new Float32Array(n);
    this.moistOffset = new Float32Array(n);

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
    return latitudeHeat(row, this.grid.height);
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
   * Exchange heat with the six neighbours, once a day, from a frozen snapshot.
   *
   *   T[i] <- T[i] + kappa * (mean(T_neighbours) - T[i])
   *
   * The other half of the filter — the pull toward the tile's own equilibrium,
   * `alpha_i * (H_i - T[i])` — stays in `evaluateTile`, because `H` is only knowable
   * there: it needs the tile's neighbour composition and today's `ambientHeat`, and
   * resolving cycles per tile is exactly what `invariants.ts` §9 counts to measure the
   * sweep. So the day is: exchange (here, from a snapshot), then relax (in the sweep).
   *
   * ★ SNAPSHOT, NOT IN-PLACE. See `temperatureSnapshot`. This is the requirement the
   * intent states as "based on a snapshot of the whole map, this way we dont get like a
   * temperature chain", and under a banded sweep it is a real defect class rather than a
   * theoretical one.
   *
   * ★ WHY IT CANNOT LATCH THE WORLD, which is the thing the previous attempt did. The
   * term is `mean(T_nb) - T`, so in a spatially uniform region it is EXACTLY ZERO and the
   * tile relaxes at its own `alpha` unchanged. The rejected form blended toward the mean
   * ANOMALY, which does not vanish in a uniform region and therefore multiplied every
   * tile's time constant — see `THERMAL_KAPPA`.
   *
   * ★ DETERMINISM (R-004). Ascending index scan, six neighbours in fixed direction order,
   * every read from the frozen buffer. Nothing here depends on evaluation order, which is
   * the property a double-buffer bug destroys first.
   */
  private diffuseTemperature(): void {
    const { grid, temperature, temperatureSnapshot, thermalKappa } = this;
    const n = grid.size;
    temperatureSnapshot.set(temperature);
    for (let i = 0; i < n; i++) {
      const t = temperatureSnapshot[i]!;
      let sum = 0;
      for (let k = 0; k < 6; k++) sum += temperatureSnapshot[grid.neighbourAt(i, k)]!;
      temperature[i] = t + thermalKappa * (sum / 6 - t);
    }
  }

  /**
   * Everything that is resolved once per day, before the sweep touches a tile.
   *
   * The order is not arbitrary: the exchange pass reads `temperature` as it stood at
   * the end of yesterday, and the cycle states are what today's tiles will be evaluated
   * against. Both are snapshots, which is what keeps the day's result independent of
   * where the gaze happens to be when a question is asked.
   */
  private beginDay(day: number): void {
    this.diffuseTemperature();
    this.refreshCycles(day);
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
    //   (at the day boundary, from a snapshot — `diffuseTemperature`)
    //   T     += kappa * (mean(T_neighbours) - T)  exchange with the six neighbours
    //   (here, once per tile per day)
    //   H      = heatAt(...) + ambientHeat        today's equilibrium
    //   T     += (H - T) * alpha_i                ★ PER BIOME — `BiomeDef.thermalAlpha`
    //   heat   = T + effect.heat                  ★ ACUTE cycle heat BYPASSES the filter
    //
    // Two terms, not three. The maritime `w(d) * A` distance-falloff term is gone with
    // the BFS field it read — the exchange line above is what carries the sea inland now.
    //
    // ★ THE LAST LINE IS NOT A SHORTCUT. `Focus` dwell under the blob beam is exactly
    // one day and carries heat 70 + focusHeat 45 = +115 against `melting`'s
    // `heat > MOLTEN (120)` gate. At alpha 0.5 a one-day +115 impulse delivers +57.5 and
    // nothing on the world ever melts again — no lava, so no basalt, no glass, no
    // fertile soil. Seasons THROUGH the filter is what delivers maritime climate; the
    // beam through the filter deletes a third of the chemistry. That is what the two
    // channels on `CycleEffect` are for.
    const equilibrium = this.heatAt(i, current, counts, openWaterNeighbours, iceNeighbours, effect.ambientHeat);

    // Thermal mass is per biome now, not two classes. Water is still the slow one and is
    // still what makes the anomaly exist at all; the land side is no longer one number,
    // so sand and basalt no longer settle at the same rate. `BiomeDef.thermalAlpha`.
    const alpha = def.thermalAlpha;
    const t = this.temperature[i]!;
    const nextT = t + (equilibrium - t) * alpha;
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
      //
      // ★ AND `r` IS PER CELL, NOT PER TILE. On a coarse world one step is `factor`
      // tiles of ground, so the leak scales with `factor^MOISTURE_LEAK_GRID_POWER`
      // — see `moistureRetention` and decision `0031`. Hard-coding 0.9998 here is
      // what made every coarse continent a swamp (decision `0030`). The continuum
      // factor² derivation overshot; 1.25 is the measured calibration.
      const neighbourAvg = moistureSum / 6;
      const retention = moistureRetention(heat, this.cellSizeTiles);
      let target = neighbourAvg * retention;
      // Wetland — and now river — neighbours push the diffusion target up. A river is
      // standing fresh water, so a valley floor beside one is humid; this is the channel
      // through which the biome is "wet" at all, and it is a LAND-side channel. It moves
      // moisture, never the coastline.
      target += 2 * (counts[Biome.Marsh]! + counts[Biome.Swamp]! + counts[Biome.River]!) +
        this.moistOffset[i]! * 0.05;
      // Cycle moisture enters as an additive push on the diffusion TARGET — the same
      // channel marsh neighbours use — never as a change to the retention constant.
      // Bug #1 (retention 0.9998) and bug #2 (heat is a multiplicative decay, not a
      // flat sink) live in moistureRetention and must stay out of reach of cycles.
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
      tectonic: this.tectonic[i]!,
      cellSizeTiles: this.cellSizeTiles,
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
   * Where every sun is today — orientation for anything that draws the world.
   *
   * ★ THIS IS NOT HOW THE BEAM IS MEANT TO BE FOLLOWED. The path a player reads is the
   * SCAR: the glass, ash, lava and desert the beam drags behind it, which is a property
   * of the simulation and visible in any render of the biome grid. This call exists only
   * so a viewer can mark where the sun is right now and a reader can check that the trail
   * and the sun agree. Decision `0025` records why there is no forward track here.
   *
   * ★ ALL of them, not the first one. A world may carry several beams out of phase;
   * `this.beam` answers a different, older question and keeps answering it.
   */
  sky(): WorldSky {
    const day = Math.floor(this.day);
    const beams: BeamSighting[] = [];
    for (const cycle of this.cycles) {
      if (!(cycle instanceof SolarBeam)) continue;
      const s = cycle.sighting(day);
      if (s !== null) beams.push(s);
    }
    return { day, beams };
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
   * ★ `Infinity` IS AN ANSWER, not a failure. A blob's track retraces itself after a
   * GREAT YEAR (`greatYearTraverses` traverses), and the forecast horizon is one, so
   * `Infinity` now means "this tile is outside the track's reach entirely" — which an
   * amplitude below 1.0 still produces. Callers must render "never", not "not yet".
   */
  daysUntilBeam(col: number, row: number): number {
    return this.beam?.forecast(col, row, this.day, undefined, this.worldView)?.daysUntil ?? Infinity;
  }

  // -------------------------------------------------------------------------
  // Worldgen
  // -------------------------------------------------------------------------

  /**
   * A loop over `worldgenAt`, and nothing more. The maths lives in `worldgen.ts` so a
   * caller can generate one tile — or one region's 64 — without building a world
   * (`ARCHITECTURE.md#4.3`). One scratch object for the whole grid, not one per tile.
   */
  private generate(seaLevel: number): void {
    const { grid } = this;
    const cfg = worldgenConfig(this.seed, grid.width, grid.height, seaLevel);
    const t = makeWorldgenTile();

    for (let row = 0; row < grid.height; row++) {
      for (let col = 0; col < grid.width; col++) {
        const i = row * grid.width + col;
        worldgenAt(cfg, col, row, t);

        // The ONE write to `elevation`, for the life of the world. See the field.
        this.elevation[i] = t.elevation;
        this.tectonic[i] = t.tectonic;
        this.heatOffset[i] = t.heatOffset;
        this.moistOffset[i] = t.moistOffset;
        this.biome[i] = t.biome;
        this.moisture[i] = t.moisture;
      }
    }
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
