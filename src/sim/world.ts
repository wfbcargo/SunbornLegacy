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
  CycleEffect, CycleFlag, SolarBeam, makeCycle,
  type CycleForecast, type CycleSpec, type WorldCycle,
} from './cycles.ts';

export const TICKS_PER_DAY = 14_400;

/**
 * Default columns evaluated per sweep step.
 *
 * `width` does NOT have to be a multiple of this. `stepDay()` runs
 * `ceil(width / bandWidth)` steps and the day's LAST band is short rather than a full
 * band that wraps — see `step()`. Any width ages evenly; decision `0006`.
 */
export const DEFAULT_BAND_WIDTH = 8;

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
  /** Static per-tile climate offsets from worldgen (elevation, prevailing damp). */
  private readonly heatOffset: Float32Array;
  private readonly moistOffset: Float32Array;

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
            transitDays: opts.beamTransitDays ?? 60,
            cycleDays: opts.beamCycleDays ?? 360,
            widthCols: opts.beamWidth ?? 8,
          }]
        : []);
    this.cycles = specs.map((s) =>
      (typeof (s as WorldCycle).dayState === 'function' ? (s as WorldCycle) : makeCycle(s as CycleSpec))
        .bind(opts.width, opts.height, opts.seed),
    );
    this.refreshCycles(0);

    const n = this.grid.size;
    this.biome = new Uint8Array(n);
    this.moisture = new Float32Array(n);
    this.heatOffset = new Float32Array(n);
    this.moistOffset = new Float32Array(n);

    this.generate(opts.seaLevel ?? 0.44);
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
   * `cycleHeat` is the summed contribution of every active cycle for this tile today.
   * It replaces the old hardcoded `if (underBeam) heat += 70`, which is now the
   * SolarBeam cycle's own parameter. Cycle heat is deliberately a separate term from
   * albedo: albedo is a FEEDBACK (desert heats its neighbours, which makes more
   * desert) and is capped at 1.2 for that reason, whereas cycle heat is externally
   * scheduled and cannot amplify itself, so it can be large and transient.
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
    cycleHeat: number,
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

    return heat + cycleHeat;
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
      const state = cycle.dayState(day);
      if (state === null) continue;
      this.activeCycles.push(cycle);
      this.cycleStates.push(state);
    }
    this.cycleStatesDay = day;
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
    if (day !== this.cycleStatesDay) this.refreshCycles(day);

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
   * Note this recomputes moisture rather than reading it: it is a read-only preview of
   * what `evaluateTile` would see, so calling it never perturbs the simulation.
   */
  inspect(index: number): TileContext {
    const day = Math.floor(this.day);
    if (day !== this.cycleStatesDay) this.refreshCycles(day);
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
   * Gather neighbours, resolve climate, and (when `commit`) relax this tile's moisture.
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

    for (let d = 0; d < 6; d++) {
      const nb = this.grid.neighbourAt(i, d);
      const nbBiome = biome[nb]! as Biome;
      const def = BIOMES[nbBiome]!;
      counts[nbBiome]!++;
      // TRUE water only. Lava is water:true so that it flows, but counting it here
      // would let a lava field irrigate and cool the desert around it — the exact
      // opposite of what a lava field does.
      if (def.water && !def.molten) {
        waterNeighbours++;
        if (nbBiome === Biome.FrozenSea) iceNeighbours++;
        else openWaterNeighbours++;
      }
      moistureSum += moisture[nb]!;
    }

    const current = biome[i]! as Biome;
    const def = BIOMES[current]!;
    const heat = this.heatAt(i, current, counts, openWaterNeighbours, iceNeighbours, effect.heat);

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
      target += 2 * (counts[Biome.Marsh]! + counts[Biome.Swamp]!) + this.moistOffset[i]! * 0.05;
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
      const f = cycle.forecast(col, row, this.day, horizonDays);
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
   * Real days until the beam next reaches a column — the warning a player gets.
   * Legible in real-world units and safe to expose through the API.
   */
  daysUntilBeam(col: number): number {
    return this.beam?.forecast(col, 0, this.day)?.daysUntil ?? Infinity;
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

        // Elevation cools, and adds regional variety beyond pure latitude.
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
