/**
 * THE LOD GATE — does the coarse tier behave like the tile tier?
 *
 * `ARCHITECTURE.md#13` Phase 1: *"Proves or kills the entire storage model. If the coarse
 * tier does not agree with the tile tier on rule activation and spatial statistics,
 * everything downstream — lazy materialization, the beam forecast, `world_metric`, the
 * supply model — is built on fiction."*
 *
 * ★ THIS FILE IS A HARNESS, NOT STEPPING CODE. It is a caller, so R-007's no-I/O rule does
 * not bind it (spec `d53ccbb6-4` acceptance criterion 1 says so explicitly). It reads the
 * two tiers and prints; it writes nothing into `world.ts`, `biomes.ts` or `coarse.ts`.
 *
 * ★ EVERY THRESHOLD IN THIS FILE WAS FIXED IN THE SPEC BEFORE ANY NUMBER WAS MEASURED, and
 * the constants below carry the spec's own words. A criterion written after seeing the
 * numbers is not a criterion, it is a justification. If one of them is wrong, the spec's
 * instruction is to argue it in writing and escalate — never to move it quietly. Two of
 * them turned out to need that argument; see `THRESHOLD-01` and `THRESHOLD-02` below and
 * `.wiki/decisions/0030`.
 *
 * ★ CELL-FOR-CELL AGREEMENT IS NOT A CRITERION AND MUST NOT BE READ AS ONE. Both tiers are
 * stochastic CAs drawing from `rollAt`, so a coarse cell and its 64 tiles never share a
 * roll stream and the two decorrelate no matter how well the physics matches. It is
 * printed as context only.
 *
 *   node src/sim/lod.ts                        # every preset, the shipped window
 *   node src/sim/lod.ts --preset still         # the ladder's first rung on its own
 *   node src/sim/lod.ts --burn-in 100 --window 40 --width 80 --height 48   # while iterating
 */

import { World, type WorldOptions } from './world.ts';
import {
  ARID, BIOMES, BIOME_COUNT, RULES, RULE_FIRINGS, enableFluxLedger, resetFluxLedger,
  type Biome,
} from './biomes.ts';
import { CYCLE_PRESETS, type CycleSpec } from './cycles.ts';
import type { HexTorus } from './hex.ts';
import {
  COARSE_FACTOR, coarseDims, coarseDistortion, makeCoarseWorld, projectBiome, projectMoisture,
} from './coarse.ts';
import { bold, dim } from './report.ts';

// ---------------------------------------------------------------------------
// THE THRESHOLDS — spec `d53ccbb6-4`, fixed before measurement.
// ---------------------------------------------------------------------------

/** M1: "PASS if the median ratio is within `0.5x-2.0x`". */
const RATE_MEDIAN_LO = 0.5;
const RATE_MEDIAN_HI = 2.0;
/** M1: "and no more than **10%** of firing rules fall outside `0.2x-5.0x`". */
const RATE_OUTLIER_LO = 0.2;
const RATE_OUTLIER_HI = 5.0;
const RATE_OUTLIER_MAX_FRACTION = 0.10;

/** M2: "the median patch size agrees within **3x**". */
const PATCH_TOLERANCE = 3.0;
/** M2: "for every biome holding >=1% of the world". */
const BIOME_MIN_SHARE = 0.01;

/** M3: "the correlation length ... agrees within **2x**". */
const CORRELATION_TOLERANCE = 2.0;
/** M3: "`P(same biome | separation d)` for `d = 1...8` cells". */
const CORRELATION_D_MAX = 8;
/**
 * `THRESHOLD-03` — the companion M3 needs in order to be answerable at all. NOT a
 * replacement for the criterion, which is applied exactly as written.
 *
 * ⚠️ `P(same biome | d)` DOES NOT DECAY TO ZERO. It decays to `sum(p_b^2)`, the chance two
 * unrelated cells share a biome, which on a world holding two biomes at ~30% is ~0.20. If
 * `C(1)/e` sits BELOW that floor the curve never crosses it and the correlation length is
 * not "long", it is UNRESOLVED — a different statement, and one the raw criterion has no
 * way to make. That is what the first smoke run produced on both tiers at once, so the
 * criterion could not discriminate between them even in principle.
 *
 * The textbook fix is the CONNECTED correlation `C(d) - C(inf)`, which does decay to zero
 * and therefore always has a `1/e` point. It is reported alongside, labelled, and argued in
 * `.wiki/decisions/0030`. The spec's own number is still reported and still decides.
 *
 * ★ AND THE CURVE CANNOT BE EXTENDED PAST `d = 8` TO CHASE THE CROSSING. The coarse torus
 * is 30x18, so separations above `min(w, h) / 2 = 9` WRAP: `d = 16` on an 18-row torus is
 * a distance of 2 wearing a 16, and the first draft of this file duly measured correlation
 * RISING at d=6 on a 10x6 test torus. The guard below refuses the measurement rather than
 * reporting an aliased curve.
 */
const wrapSafeSeparation = (grid: HexTorus) => Math.floor(Math.min(grid.width, grid.height) / 2);

/**
 * `THRESHOLD-01` — context for M1's hard fail, deliberately NOT a relaxation of it.
 *
 * The coarse tier has 1/64 the cells, so over the same window it draws 1/64 the samples. A
 * rule firing 40 times on the fine tier has an EXPECTED coarse count of 0.6, and observing
 * zero is then the single most likely outcome — which is a sampling fact, not evidence that
 * "the coarse world cannot see the transition". The spec's hard fail is reported exactly as
 * written; this constant only splits the one-sided rules into those whose silence is
 * explicable by sample size and those whose silence is not. The second group is the one
 * that carries the spec's meaning.
 */
const ONE_SIDED_SAMPLING_FLOOR = 3;

/**
 * `THRESHOLD-02` — an operationalisation, not a new threshold.
 *
 * M2's second clause, "the coarse tier is not systematically single-patch where the fine
 * tier is fragmented", names no number. Read literally it is untestable, so it is made
 * testable here in the most conservative way available: a biome trips it when the coarse
 * tier holds at most ONE component while the fine tier holds at least THREE. Stated in the
 * open because a criterion whose operationalisation is buried is a criterion nobody can
 * check.
 */
const SINGLE_PATCH_COARSE_MAX = 1;
const SINGLE_PATCH_FINE_MIN = 3;

// ---------------------------------------------------------------------------
// The measured world.
// ---------------------------------------------------------------------------

/**
 * Spec: "All at 240x144 fine / 30x18 coarse, seed 20260729, measured across a **tail
 * window** never a final frame (a purged world oscillates, and an end-of-run snapshot lands
 * at an arbitrary phase — the bug `SIMULATION.md` records)."
 */
const DEFAULT_WIDTH = 240;
const DEFAULT_HEIGHT = 144;
const DEFAULT_SEED = 20260729;
/** Days run before the window opens. Spec 3's smoke test measured at 300. */
const DEFAULT_BURN_IN = 300;
/** Length of the tail window. Every rate below is a per-cell-per-day rate over it. */
const DEFAULT_WINDOW = 100;
/** Spatial snapshots taken inside the window, evenly spaced. Patch sizes and correlation
 *  are pooled across them so no single frame's phase decides the answer. */
const DEFAULT_SNAPSHOTS = 5;

const PRESET_ORDER: readonly string[] = ['still', 'anvil', 'garden', 'kiln', 'crucible'];

// ---------------------------------------------------------------------------
// Small statistics.
// ---------------------------------------------------------------------------

function median(xs: readonly number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function mean(xs: readonly number[]): number {
  if (xs.length === 0) return NaN;
  let t = 0;
  for (const x of xs) t += x;
  return t / xs.length;
}

/** Biome share vector for a grid of cells. */
function shares(biome: Uint8Array): Float64Array {
  const out = new Float64Array(BIOME_COUNT);
  for (let i = 0; i < biome.length; i++) out[biome[i]!] = out[biome[i]!]! + 1;
  for (let b = 0; b < BIOME_COUNT; b++) out[b] = out[b]! / biome.length;
  return out;
}

/**
 * Total-variation distance between two composition vectors: `0.5 * sum |p - q|`.
 *
 * Stated rather than assumed because spec 3 reported a "composition distance" from a
 * throwaway script that is not in the tree, and two different conventions (L1 and L1/2)
 * differ by exactly 2x — which is the size of one of this spec's thresholds.
 */
function compositionDistance(a: Float64Array, b: Float64Array): number {
  let t = 0;
  for (let i = 0; i < BIOME_COUNT; i++) t += Math.abs(a[i]! - b[i]!);
  return t / 2;
}

function cellAgreement(a: Uint8Array, b: Uint8Array): number {
  let same = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++;
  return same / a.length;
}

/**
 * Connected components per biome, six-neighbour on the torus.
 *
 * Iterative with a preallocated stack: a 34,560-tile world of one biome would blow a
 * recursive fill's call stack, and `still` gets closer to that than is comfortable.
 */
function componentSizes(biome: Uint8Array, grid: HexTorus): number[][] {
  const size = grid.size;
  const seen = new Uint8Array(size);
  const stack = new Int32Array(size);
  const out: number[][] = Array.from({ length: BIOME_COUNT }, () => []);
  for (let start = 0; start < size; start++) {
    if (seen[start] === 1) continue;
    const b = biome[start]!;
    seen[start] = 1;
    let top = 0;
    stack[top++] = start;
    let count = 0;
    while (top > 0) {
      const i = stack[--top]!;
      count++;
      for (let d = 0; d < 6; d++) {
        const n = grid.neighbourAt(i, d);
        if (seen[n] === 0 && biome[n] === b) {
          seen[n] = 1;
          stack[top++] = n;
        }
      }
    }
    out[b]!.push(count);
  }
  return out;
}

/**
 * `P(same biome | separation d)` for each requested separation.
 *
 * ★ EXACT SEPARATIONS, NOT SAMPLED PAIRS. Walking `neighbourAt(i, dir)` `d` times in a
 * fixed direction lands exactly `d` hexes away, so every pair counted is at the separation
 * it is filed under — no distance approximation and no random sampling, which also means no
 * RNG to make the number irreproducible (R-004's spirit; this is a harness, but a harness
 * whose answer moves between runs is not evidence).
 *
 * All six directions are walked and pooled, so an anisotropic world (a beam scar runs along
 * columns) is not read as a shorter correlation length than it has.
 */
function correlationCurve(
  biome: Uint8Array, grid: HexTorus, seps: readonly number[],
): number[] {
  const maxSep = seps[seps.length - 1]!;
  const slot = new Map<number, number>();
  seps.forEach((s, i) => slot.set(s, i));
  const same = new Float64Array(seps.length);
  const total = new Float64Array(seps.length);
  const size = grid.size;
  const cur = new Int32Array(size);

  for (let dir = 0; dir < 6; dir++) {
    for (let i = 0; i < size; i++) cur[i] = i;
    for (let s = 1; s <= maxSep; s++) {
      for (let i = 0; i < size; i++) cur[i] = grid.neighbourAt(cur[i]!, dir);
      const idx = slot.get(s);
      if (idx === undefined) continue;
      let hit = 0;
      for (let i = 0; i < size; i++) if (biome[i] === biome[cur[i]!]) hit++;
      same[idx] = same[idx]! + hit;
      total[idx] = total[idx]! + size;
    }
  }
  return seps.map((_, i) => same[i]! / total[i]!);
}

/**
 * The `d` at which the curve falls to `1/e` of its first value, linearly interpolated
 * between the two bracketing samples. `null` means it never falls that far inside the
 * measured range — UNRESOLVED, which is not the same as "long".
 */
function correlationLength(seps: readonly number[], curve: readonly number[]): number | null {
  const target = curve[0]! / Math.E;
  for (let i = 1; i < curve.length; i++) {
    if (curve[i]! <= target) {
      const x0 = seps[i - 1]!;
      const x1 = seps[i]!;
      const y0 = curve[i - 1]!;
      const y1 = curve[i]!;
      if (y0 === y1) return x1;
      return x0 + ((y0 - target) * (x1 - x0)) / (y0 - y1);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Running a tier.
// ---------------------------------------------------------------------------

interface TierRun<T> {
  /** Firings per rule inside the window only — the burn-in is reset away. */
  readonly firings: Int32Array;
  readonly samples: readonly T[];
}

/**
 * Burn in, then step the window, capturing at the snapshot days.
 *
 * ⚠️ `RULE_FIRINGS` IS A MODULE GLOBAL SHARED BY BOTH TIERS, so the two runs cannot be
 * interleaved and the counts must be copied out before the next `resetFluxLedger()`. This
 * is why the fine and coarse worlds are stepped one after the other rather than in step.
 */
function runTier<T>(
  world: World, burnIn: number, windowDays: number, snapshots: number, capture: (w: World) => T,
): TierRun<T> {
  for (let d = 0; d < burnIn; d++) world.stepDay();
  resetFluxLedger();
  const samples: T[] = [];
  const every = Math.max(1, Math.floor(windowDays / snapshots));
  for (let d = 1; d <= windowDays; d++) {
    world.stepDay();
    if (d % every === 0 && samples.length < snapshots) samples.push(capture(world));
  }
  if (samples.length === 0) samples.push(capture(world));
  return { firings: Int32Array.from(RULE_FIRINGS), samples };
}

interface FineSample {
  readonly biome: Uint8Array;
  readonly projected: Uint8Array;
  readonly moisture: Float32Array;
  readonly temperature: Float32Array;
}
interface CoarseSample {
  readonly biome: Uint8Array;
  readonly moisture: Float32Array;
  readonly temperature: Float32Array;
}

/** How far inland the moisture profile is followed, in TILES, on both tiers alike. */
const WATER_PROFILE_TILES = 64;

// ---------------------------------------------------------------------------
// Measurement 1 — per-rule activation counts.
// ---------------------------------------------------------------------------

interface RuleRow {
  readonly key: string;
  readonly from: Biome;
  readonly fineFirings: number;
  readonly coarseFirings: number;
  readonly fineRate: number;
  readonly coarseRate: number;
  /** `null` when one tier never fired it — a hard fail, and a ratio nobody can form. */
  readonly ratio: number | null;
  /** Firings the fine tier's rate predicts for the coarse tier's cell-days, and vice versa. */
  readonly expectedCoarse: number;
  readonly expectedFine: number;
}

interface ActivationResult {
  readonly rows: readonly RuleRow[];
  readonly firingRules: number;
  readonly bothFiring: number;
  readonly medianRatio: number;
  readonly outliers: number;
  readonly outlierFraction: number;
  readonly oneSided: readonly RuleRow[];
  /** One-sided rules whose silence sample size does NOT explain (`THRESHOLD-01`). */
  readonly oneSidedStructural: readonly RuleRow[];
  readonly medianPass: boolean;
  readonly outlierPass: boolean;
  readonly hardFail: boolean;
  readonly pass: boolean;
}

function measureActivation(
  fine: Int32Array, coarse: Int32Array, fineCellDays: number, coarseCellDays: number,
): ActivationResult {
  const rows: RuleRow[] = [];
  for (let i = 0; i < RULES.length; i++) {
    const f = fine[i]!;
    const c = coarse[i]!;
    if (f === 0 && c === 0) continue;
    const fineRate = f / fineCellDays;
    const coarseRate = c / coarseCellDays;
    rows.push({
      key: RULES[i]!.key,
      from: RULES[i]!.from,
      fineFirings: f,
      coarseFirings: c,
      fineRate,
      coarseRate,
      ratio: f > 0 && c > 0 ? coarseRate / fineRate : null,
      expectedCoarse: fineRate * coarseCellDays,
      expectedFine: coarseRate * fineCellDays,
    });
  }

  const ratios = rows.filter((r) => r.ratio !== null).map((r) => r.ratio!);
  const oneSided = rows.filter((r) => r.ratio === null);
  // A one-sided rule counts as OUTSIDE the band — an undefined ratio is not a passing one.
  const outliers =
    ratios.filter((r) => r < RATE_OUTLIER_LO || r > RATE_OUTLIER_HI).length + oneSided.length;
  const medianRatio = median(ratios);
  const outlierFraction = rows.length === 0 ? 0 : outliers / rows.length;
  const oneSidedStructural = oneSided.filter((r) =>
    r.fineFirings === 0
      ? r.expectedFine >= ONE_SIDED_SAMPLING_FLOOR
      : r.expectedCoarse >= ONE_SIDED_SAMPLING_FLOOR,
  );

  const medianPass = medianRatio >= RATE_MEDIAN_LO && medianRatio <= RATE_MEDIAN_HI;
  const outlierPass = outlierFraction <= RATE_OUTLIER_MAX_FRACTION;
  const hardFail = oneSided.length > 0;
  return {
    rows, firingRules: rows.length, bothFiring: ratios.length, medianRatio, outliers,
    outlierFraction, oneSided, oneSidedStructural, medianPass, outlierPass, hardFail,
    pass: medianPass && outlierPass && !hardFail,
  };
}

// ---------------------------------------------------------------------------
// Measurement 2 — patch-size distribution.
// ---------------------------------------------------------------------------

interface PatchRow {
  readonly biome: Biome;
  readonly fineShare: number;
  readonly coarseShare: number;
  /** Median component size, both tiers in COARSE CELLS — fine sizes divided by `factor^2`. */
  readonly fineMedianCells: number;
  readonly coarseMedianCells: number;
  /** `THRESHOLD-04`'s companion: the median patch a randomly chosen CELL belongs to. */
  readonly fineWeightedCells: number;
  readonly coarseWeightedCells: number;
  readonly fineComponents: number;
  readonly coarseComponents: number;
  readonly ratio: number | null;
  readonly weightedRatio: number | null;
  readonly within: boolean;
  readonly weightedWithin: boolean;
  readonly singlePatch: boolean;
  /** The biome exists on one tier and not the other. Reported apart from a size mismatch. */
  readonly absent: boolean;
}

interface PatchResult {
  readonly rows: readonly PatchRow[];
  readonly pass: boolean;
  readonly weightedPass: boolean;
}

/**
 * `THRESHOLD-04` — the companion M2 needs, for the same reason M3 needed one. NOT a
 * replacement: the spec's plain median is still computed and still decides.
 *
 * ⚠️ THE PLAIN MEDIAN COMPONENT SIZE COMPARES QUANTISATION, NOT PHYSICS, AND IT DOES SO BY
 * CONSTRUCTION. A biome's component-size distribution is dominated in count by its smallest
 * fragments, and the smallest representable fragment is ONE CELL on either tier — which is
 * 1 tile on the fine tier and 64 tiles' worth on the coarse one. So the median ratio starts
 * at 64x before any physics happens, and the first smoke run duly reported 64.00x, 64.00x,
 * 96.00x and 128.00x: the same number over and over, which is the signature of a metric
 * measuring its own units. A 3x threshold on it cannot be met by ANY coarse tier, correct
 * or not, and a criterion no implementation can pass is not a gate — it is a constant.
 *
 * The area-weighted median — the size of the patch a randomly chosen CELL sits in — has no
 * such floor, because a world made of one big patch plus a thousand specks reads as "big"
 * on it at either resolution. It is what "do the two worlds look alike" actually means.
 */
function weightedMedian(sizes: readonly number[]): number {
  if (sizes.length === 0) return NaN;
  const s = [...sizes].sort((a, b) => a - b);
  let total = 0;
  for (const x of s) total += x;
  let acc = 0;
  for (const x of s) {
    acc += x;
    if (acc >= total / 2) return x;
  }
  return s[s.length - 1]!;
}

function measurePatches(
  fineSamples: readonly FineSample[], coarseSamples: readonly CoarseSample[],
  fineGrid: HexTorus, coarseGrid: HexTorus, factor: number,
): PatchResult {
  const per = factor * factor;
  const fineSizes: number[][] = Array.from({ length: BIOME_COUNT }, () => []);
  const coarseSizes: number[][] = Array.from({ length: BIOME_COUNT }, () => []);
  const fineCounts: number[][] = Array.from({ length: BIOME_COUNT }, () => []);
  const coarseCounts: number[][] = Array.from({ length: BIOME_COUNT }, () => []);
  const fineShare = new Float64Array(BIOME_COUNT);
  const coarseShare = new Float64Array(BIOME_COUNT);

  for (const s of fineSamples) {
    const comps = componentSizes(s.biome, fineGrid);
    const sh = shares(s.biome);
    for (let b = 0; b < BIOME_COUNT; b++) {
      for (const size of comps[b]!) fineSizes[b]!.push(size / per);
      fineCounts[b]!.push(comps[b]!.length);
      fineShare[b] = fineShare[b]! + sh[b]! / fineSamples.length;
    }
  }
  for (const s of coarseSamples) {
    const comps = componentSizes(s.biome, coarseGrid);
    const sh = shares(s.biome);
    for (let b = 0; b < BIOME_COUNT; b++) {
      for (const size of comps[b]!) coarseSizes[b]!.push(size);
      coarseCounts[b]!.push(comps[b]!.length);
      coarseShare[b] = coarseShare[b]! + sh[b]! / coarseSamples.length;
    }
  }

  const rows: PatchRow[] = [];
  for (let b = 0; b < BIOME_COUNT; b++) {
    // "for every biome holding >=1% of the world" — on EITHER tier. A biome the coarse tier
    // invents at 4% is as much a disagreement as one it loses.
    if (fineShare[b]! < BIOME_MIN_SHARE && coarseShare[b]! < BIOME_MIN_SHARE) continue;
    const fm = median(fineSizes[b]!);
    const cm = median(coarseSizes[b]!);
    const fw = weightedMedian(fineSizes[b]!);
    const cw = weightedMedian(coarseSizes[b]!);
    const fc = mean(fineCounts[b]!);
    const cc = mean(coarseCounts[b]!);
    const within = (x: number | null) =>
      x !== null && x >= 1 / PATCH_TOLERANCE && x <= PATCH_TOLERANCE;
    const safeRatio = (f: number, c: number) =>
      Number.isFinite(f) && Number.isFinite(c) && f > 0 && c > 0 ? c / f : null;
    const ratio = safeRatio(fm, cm);
    const weightedRatio = safeRatio(fw, cw);
    rows.push({
      biome: b as Biome,
      fineShare: fineShare[b]!,
      coarseShare: coarseShare[b]!,
      fineMedianCells: fm,
      coarseMedianCells: cm,
      fineWeightedCells: fw,
      coarseWeightedCells: cw,
      fineComponents: fc,
      coarseComponents: cc,
      ratio,
      weightedRatio,
      within: within(ratio),
      weightedWithin: within(weightedRatio),
      singlePatch: cc <= SINGLE_PATCH_COARSE_MAX && fc >= SINGLE_PATCH_FINE_MIN,
      absent: (fineShare[b]! === 0) !== (coarseShare[b]! === 0),
    });
  }
  return {
    rows,
    pass: rows.every((r) => r.within && !r.singlePatch),
    weightedPass: rows.every((r) => r.weightedWithin && !r.singlePatch),
  };
}

// ---------------------------------------------------------------------------
// Measurement 3 — two-point correlation.
// ---------------------------------------------------------------------------

interface CorrelationResult {
  readonly seps: readonly number[];
  readonly fineCurve: readonly number[];
  readonly coarseCurve: readonly number[];
  /** The asymptote each curve decays to, `sum(p_b^2)`, averaged over the window. */
  readonly fineFloor: number;
  readonly coarseFloor: number;
  /** Correlation lengths in COARSE CELLS. `null` = unresolved inside `d = 1...8`. */
  readonly fineLength: number | null;
  readonly coarseLength: number | null;
  readonly ratio: number | null;
  readonly pass: boolean;
  readonly unresolved: boolean;
  /** `THRESHOLD-03`'s companion: the same lengths on the CONNECTED curve `C(d) - C(inf)`. */
  readonly fineConnected: number | null;
  readonly coarseConnected: number | null;
  readonly connectedRatio: number | null;
  readonly connectedWithin: boolean;
}

/** `sum(p_b^2)` — the chance two unrelated cells share a biome. */
function correlationFloor(biome: Uint8Array): number {
  const p = shares(biome);
  let t = 0;
  for (let b = 0; b < BIOME_COUNT; b++) t += p[b]! * p[b]!;
  return t;
}

function measureCorrelation(
  fineSamples: readonly FineSample[], coarseSamples: readonly CoarseSample[],
  fineGrid: HexTorus, coarseGrid: HexTorus, factor: number,
): CorrelationResult {
  const safe = Math.min(wrapSafeSeparation(coarseGrid), Math.floor(wrapSafeSeparation(fineGrid) / factor));
  if (safe < CORRELATION_D_MAX) {
    throw new Error(
      `A ${coarseGrid.width}x${coarseGrid.height} coarse torus cannot carry the spec's ` +
        `d = 1...${CORRELATION_D_MAX} correlation curve: separations above ${safe} wrap, and a ` +
        `wrapped pair is filed under a distance it is not at. Measure at 240x144 or larger, ` +
        `or the curve rises with d instead of falling.`,
    );
  }
  const coarseSeps = Array.from({ length: CORRELATION_D_MAX }, (_, i) => i + 1);
  const fineSeps = coarseSeps.map((d) => d * factor);

  const fineAcc = new Float64Array(coarseSeps.length);
  const coarseAcc = new Float64Array(coarseSeps.length);
  let fineFloor = 0;
  let coarseFloor = 0;
  for (const s of fineSamples) {
    const c = correlationCurve(s.biome, fineGrid, fineSeps);
    for (let i = 0; i < c.length; i++) fineAcc[i] = fineAcc[i]! + c[i]! / fineSamples.length;
    fineFloor += correlationFloor(s.biome) / fineSamples.length;
  }
  for (const s of coarseSamples) {
    const c = correlationCurve(s.biome, coarseGrid, coarseSeps);
    for (let i = 0; i < c.length; i++) coarseAcc[i] = coarseAcc[i]! + c[i]! / coarseSamples.length;
    coarseFloor += correlationFloor(s.biome) / coarseSamples.length;
  }

  const fine = [...fineAcc];
  const coarse = [...coarseAcc];
  const fl = correlationLength(coarseSeps, fine);
  const cl = correlationLength(coarseSeps, coarse);
  const ratio = fl !== null && cl !== null && fl > 0 ? cl / fl : null;

  const fc = correlationLength(coarseSeps, fine.map((v) => v - fineFloor));
  const cc = correlationLength(coarseSeps, coarse.map((v) => v - coarseFloor));
  const connectedRatio = fc !== null && cc !== null && fc > 0 ? cc / fc : null;

  return {
    seps: coarseSeps,
    fineCurve: fine,
    coarseCurve: coarse,
    fineFloor,
    coarseFloor,
    fineLength: fl,
    coarseLength: cl,
    ratio,
    pass: ratio !== null && ratio >= 1 / CORRELATION_TOLERANCE && ratio <= CORRELATION_TOLERANCE,
    unresolved: fl === null || cl === null,
    fineConnected: fc,
    coarseConnected: cc,
    connectedRatio,
    connectedWithin:
      connectedRatio !== null &&
      connectedRatio >= 1 / CORRELATION_TOLERANCE &&
      connectedRatio <= CORRELATION_TOLERANCE,
  };
}

// ---------------------------------------------------------------------------
// LADDER RUNG 5 — the rung the spec did not have, and the one that turned out to
// carry the whole result.
//
// ★ THE LADDER'S FOUR RUNGS WERE ALL MEASURED AND ALL CAME BACK MINOR. Corner sampling
// costs 2.78% composition at day 0 and reseeding the coarse world from the fine
// projection does not help it. The failing biomes are Desert, Savanna and Barren —
// large contiguous provinces, not the filaments rung 3 predicted. And `still` carries
// no cycles at all, so rung 4 cannot apply to the preset that fails hardest.
//
// What every preset does show is one shape: THE COARSE TIER IS SYSTEMATICALLY WETTER
// AND ITS DRY BIOMES DISAPPEAR. So the thing to measure is the moisture field itself,
// and specifically its DECAY LENGTH — `world.ts`'s hydrology is a nearest-neighbour
// diffusion whose retention `0.9998 - max(0, heat - 52) * 0.0006` is applied ONCE PER
// GRID STEP. Its own comment fixes the scale in tiles: "moisture falls off as
// exp(-sqrt(2(1-r))·distance)". A coarse grid step is 8 tiles of world, so the same
// constant carries moisture eight times farther across the same world.
//
// That is a hypothesis until it is measured, and this is the measurement: mean moisture
// against distance from open water, plotted in TILES on both tiers so the two curves
// are over the same ground.
// ---------------------------------------------------------------------------

interface FieldStats {
  readonly landMeanMoisture: number;
  readonly landAridFraction: number;
  readonly landMeanTemperature: number;
  /** Mean land moisture at each distance from a moisture source, distance in TILES. */
  readonly profile: readonly { readonly tiles: number; readonly moisture: number }[];
  /**
   * Land-moisture percentiles.
   *
   * ⚠️ NOT A `1/e` DECAY LENGTH, WHICH IS WHAT THIS FIELD HELD FIRST AND WHY IT DOES NOT
   * NOW. The measured inland profile is NOT monotonic — the fine tier reads 51, 46, 56, 69,
   * 71, 99 going inland — because the retention penalty only bites above heat 52, so a cold
   * high-latitude interior stays wet however far from the sea it is. Distance from water is
   * therefore not a proxy for dryness, and an exponential fit to that curve would have been
   * a number with no referent. The percentiles say the same thing without the fiction:
   * whether the world has dry ground on it at all.
   */
  readonly p10: number;
  readonly p50: number;
  readonly p90: number;
  /** Spread of the inland profile — the "wet coasts, arid hearts" gradient, or its absence. */
  readonly profileRange: number;
}

function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[i]!;
}

/** Ring distance in CELLS from the nearest moisture source; 0 on the sources themselves. */
function distanceFromWater(biome: Uint8Array, grid: HexTorus): Int32Array {
  const size = grid.size;
  const dist = new Int32Array(size).fill(-1);
  const queue = new Int32Array(size);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < size; i++) {
    if (BIOMES[biome[i]!]!.moistureSource > 0) {
      dist[i] = 0;
      queue[tail++] = i;
    }
  }
  while (head < tail) {
    const i = queue[head++]!;
    const d = dist[i]! + 1;
    for (let k = 0; k < 6; k++) {
      const n = grid.neighbourAt(i, k);
      if (dist[n] === -1) {
        dist[n] = d;
        queue[tail++] = n;
      }
    }
  }
  return dist;
}

function measureFields(
  samples: readonly { biome: Uint8Array; moisture: Float32Array; temperature: Float32Array }[],
  grid: HexTorus, factor: number, maxRings: number,
): FieldStats {
  const sum = new Float64Array(maxRings + 1);
  const count = new Float64Array(maxRings + 1);
  let landMoisture = 0;
  let landTemperature = 0;
  let landCells = 0;
  let arid = 0;
  const landValues: number[] = [];

  for (const s of samples) {
    const dist = distanceFromWater(s.biome, grid);
    for (let i = 0; i < grid.size; i++) {
      const d = dist[i]!;
      if (d <= 0) continue; // a source is not land, and -1 is a world with no water at all
      landCells++;
      landMoisture += s.moisture[i]!;
      landTemperature += s.temperature[i]!;
      landValues.push(s.moisture[i]!);
      if (s.moisture[i]! < ARID) arid++;
      if (d <= maxRings) {
        sum[d] = sum[d]! + s.moisture[i]!;
        count[d] = count[d]! + 1;
      }
    }
  }

  const profile: { tiles: number; moisture: number }[] = [];
  for (let d = 1; d <= maxRings; d++) {
    if (count[d]! === 0) continue;
    profile.push({ tiles: d * factor, moisture: sum[d]! / count[d]! });
  }
  landValues.sort((a, b) => a - b);
  const ms = profile.map((p) => p.moisture);

  return {
    landMeanMoisture: landCells === 0 ? NaN : landMoisture / landCells,
    landAridFraction: landCells === 0 ? NaN : arid / landCells,
    landMeanTemperature: landCells === 0 ? NaN : landTemperature / landCells,
    profile,
    p10: percentile(landValues, 0.10),
    p50: percentile(landValues, 0.50),
    p90: percentile(landValues, 0.90),
    profileRange: ms.length === 0 ? NaN : Math.max(...ms) - Math.min(...ms),
  };
}

// ---------------------------------------------------------------------------
// The diagnostic ladder, rung 2 — corner point sample vs modal projection at day 0.
// ---------------------------------------------------------------------------

interface SamplingFloor {
  readonly agreement: number;
  readonly composition: number;
  readonly worst: readonly { readonly biome: Biome; readonly corner: number; readonly modal: number }[];
}

/**
 * The floor under every later number, and free to compute: `coarse.ts` seeds a coarse cell
 * from `worldgenAt` at the block's CORNER while `projectBiome` takes the MODE of its 64
 * tiles. Measured before a single step, so nothing here is stepping divergence.
 */
function measureSamplingFloor(cornerDay0: Uint8Array, modalDay0: Uint8Array): SamplingFloor {
  const a = shares(cornerDay0);
  const b = shares(modalDay0);
  const worst = Array.from({ length: BIOME_COUNT }, (_, i) => ({
    biome: i as Biome, corner: a[i]!, modal: b[i]!,
  }))
    .filter((r) => Math.abs(r.corner - r.modal) > 0.005)
    .sort((x, y) => Math.abs(y.corner - y.modal) - Math.abs(x.corner - x.modal));
  return { agreement: cellAgreement(cornerDay0, modalDay0), composition: compositionDistance(a, b), worst };
}

// ---------------------------------------------------------------------------
// Formatting.
// ---------------------------------------------------------------------------

const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
const num = (x: number, dp = 3) => (Number.isFinite(x) ? x.toFixed(dp) : '—');
const times = (x: number | null, dp = 2) => (x === null ? '—' : `${x.toFixed(dp)}x`);
const verdict = (ok: boolean) => (ok ? bold('PASS') : bold('FAIL'));

/**
 * M3's verdict is three-valued, and the third value was forced by the factor-1 control.
 *
 * ★ AT `--factor 1` THE TWO TIERS ARE THE SAME WORLD, BIT FOR BIT, AND M3 STILL REPORTED
 * FAIL. Both curves were identical and both were unresolved, so the ratio was `null` and a
 * `null` is not "within 2x". A criterion that fails a tier which IS the fine tier is not
 * discriminating between tiers at all.
 *
 * That does not license moving the threshold, and it is not moved: UNRESOLVED is NOT-PASS
 * and the overall verdict treats it exactly as a failure, so the gate is not softened by
 * one basis point. What changes is only that the reader can tell "the coarse tier's
 * structure is the wrong size" apart from "this measurement could not be made", which the
 * two-valued version silently merged. Argued in `.wiki/decisions/0030`.
 */
const verdict3 = (r: CorrelationResult) =>
  r.unresolved ? bold('UNRESOLVED') : verdict(r.pass);
const bname = (b: Biome) => BIOMES[b]!.name;

function rule(label: string): string {
  return '\n' + bold(`-- ${label} `) + dim('-'.repeat(Math.max(0, 78 - label.length)));
}

// ---------------------------------------------------------------------------
// One preset, end to end.
// ---------------------------------------------------------------------------

interface PresetVerdict {
  readonly preset: string;
  readonly activation: ActivationResult;
  readonly patches: PatchResult;
  readonly correlation: CorrelationResult;
  readonly floor: SamplingFloor;
  readonly cellForCell: number;
  readonly composition: number;
  readonly seededCellForCell: number;
  readonly seededComposition: number;
  readonly seededActivationMedian: number;
  readonly seededCorrelationRatio: number | null;
  readonly pass: boolean;
}

function runPreset(
  presetName: string, width: number, height: number, seed: number,
  burnIn: number, windowDays: number, snapshots: number, factor: number,
): PresetVerdict {
  const specs: readonly CycleSpec[] = CYCLE_PRESETS[presetName]!;
  const opts: WorldOptions = { width, height, seed, cycles: [...specs] };
  const dims = coarseDims(width, height, factor);

  const fine = new World(opts);
  const coarse = makeCoarseWorld(opts, factor);
  // ★ THE RESEEDED CONTROL. Same coarse world, but its day-0 state replaced by the fine
  // world's modal projection. Its whole job is to separate "the corner sample started
  // somewhere else" from "the coarse stepping goes somewhere else" — the ladder's rung 2.
  // Moisture is projected too: leaving it at the corner sample would confound the very
  // thing being isolated.
  const seeded = makeCoarseWorld(opts, factor);

  const cornerDay0 = coarse.biome.slice();
  const modalDay0 = projectBiome(fine, factor);
  const floor = measureSamplingFloor(cornerDay0, modalDay0);
  seeded.biome.set(modalDay0);
  seeded.moisture.set(projectMoisture(fine, factor));

  const fineRun = runTier<FineSample>(fine, burnIn, windowDays, snapshots, (w) => ({
    biome: w.biome.slice(), projected: projectBiome(w, factor),
    moisture: w.moisture.slice(), temperature: w.temperature.slice(),
  }));
  const coarseRun = runTier<CoarseSample>(coarse, burnIn, windowDays, snapshots, (w) => ({
    biome: w.biome.slice(), moisture: w.moisture.slice(), temperature: w.temperature.slice(),
  }));
  const seededRun = runTier<CoarseSample>(seeded, burnIn, windowDays, snapshots, (w) => ({
    biome: w.biome.slice(), moisture: w.moisture.slice(), temperature: w.temperature.slice(),
  }));

  const fineCellDays = width * height * windowDays;
  const coarseCellDays = dims.width * dims.height * windowDays;

  const activation = measureActivation(fineRun.firings, coarseRun.firings, fineCellDays, coarseCellDays);
  const patches = measurePatches(fineRun.samples, coarseRun.samples, fine.grid, coarse.grid, factor);
  const correlation = measureCorrelation(
    fineRun.samples, coarseRun.samples, fine.grid, coarse.grid, factor,
  );

  // Context only — see the header. Averaged across the window's snapshots.
  const cellForCell = mean(
    fineRun.samples.map((f, i) => cellAgreement(coarseRun.samples[i]!.biome, f.projected)),
  );
  const composition = mean(
    fineRun.samples.map((f, i) => compositionDistance(shares(coarseRun.samples[i]!.biome), shares(f.projected))),
  );
  const seededCellForCell = mean(
    fineRun.samples.map((f, i) => cellAgreement(seededRun.samples[i]!.biome, f.projected)),
  );
  const seededComposition = mean(
    fineRun.samples.map((f, i) => compositionDistance(shares(seededRun.samples[i]!.biome), shares(f.projected))),
  );
  const seededActivation = measureActivation(
    fineRun.firings, seededRun.firings, fineCellDays, coarseCellDays,
  );
  const seededCorrelation = measureCorrelation(
    fineRun.samples, seededRun.samples, fine.grid, coarse.grid, factor,
  );

  const fineFields = measureFields(fineRun.samples, fine.grid, 1, WATER_PROFILE_TILES);
  const coarseFields = measureFields(
    coarseRun.samples, coarse.grid, factor, Math.max(1, Math.floor(WATER_PROFILE_TILES / factor)),
  );

  report(presetName, activation, patches, correlation, floor, cellForCell, composition,
    seededCellForCell, seededComposition, seededActivation, seededCorrelation, specs, factor,
    fineFields, coarseFields);

  return {
    preset: presetName, activation, patches, correlation, floor, cellForCell, composition,
    seededCellForCell, seededComposition,
    seededActivationMedian: seededActivation.medianRatio,
    seededCorrelationRatio: seededCorrelation.ratio,
    pass: activation.pass && patches.pass && correlation.pass,
  };
}

function report(
  presetName: string, activation: ActivationResult, patches: PatchResult,
  correlation: CorrelationResult, floor: SamplingFloor, cellForCell: number, composition: number,
  seededCellForCell: number, seededComposition: number, seededActivation: ActivationResult,
  seededCorrelation: CorrelationResult, specs: readonly CycleSpec[], factor: number,
  fineFields: FieldStats, coarseFields: FieldStats,
): void {
  console.log(rule(`preset ${presetName}`));

  // -- Ladder rung 2, before anything else: the floor under every later number.
  console.log(dim('\n  ladder 2 — corner point sample vs modal projection, DAY 0, unstepped'));
  console.log(
    `    cell-for-cell ${pct(floor.agreement)}   composition distance ${bold(pct(floor.composition))}`,
  );
  for (const w of floor.worst.slice(0, 6)) {
    console.log(
      `      ${bname(w.biome).padEnd(12)} corner ${pct(w.corner).padStart(7)}   ` +
        `modal ${pct(w.modal).padStart(7)}   Δ ${((w.corner - w.modal) * 100).toFixed(2)} pp`,
    );
  }

  // -- Measurement 1.
  console.log(dim('\n  M1 — per-rule activation, rate per cell per day, coarse / fine'));
  console.log(
    `    firing rules ${activation.firingRules} (both tiers ${activation.bothFiring})   ` +
      `median ratio ${bold(times(activation.medianRatio))} ` +
      `[${RATE_MEDIAN_LO}-${RATE_MEDIAN_HI}x] ${verdict(activation.medianPass)}`,
  );
  console.log(
    `    outside ${RATE_OUTLIER_LO}-${RATE_OUTLIER_HI}x: ${activation.outliers}/${activation.firingRules} = ` +
      `${bold(pct(activation.outlierFraction))} [<=${pct(RATE_OUTLIER_MAX_FRACTION)}] ${verdict(activation.outlierPass)}`,
  );
  console.log(
    `    one-sided (hard fail if any): ${bold(String(activation.oneSided.length))}   ` +
      `of which sample size does NOT explain: ${bold(String(activation.oneSidedStructural.length))}`,
  );
  for (const r of [...activation.oneSidedStructural]
    .sort((a, b) => Math.max(b.expectedCoarse, b.expectedFine) - Math.max(a.expectedCoarse, a.expectedFine))
    .slice(0, 12)) {
    const silent = r.coarseFirings === 0 ? 'coarse' : 'fine';
    const expect = r.coarseFirings === 0 ? r.expectedCoarse : r.expectedFine;
    console.log(
      `      ${silent} silent, expected ${expect.toFixed(1)}   ` +
        `${r.key}  (from ${bname(r.from)})`,
    );
  }
  const worstRatios = activation.rows
    .filter((r) => r.ratio !== null)
    .sort((a, b) => Math.abs(Math.log(b.ratio!)) - Math.abs(Math.log(a.ratio!)))
    .slice(0, 6);
  for (const r of worstRatios) {
    console.log(
      `      ${times(r.ratio).padStart(9)}  fine ${String(r.fineFirings).padStart(7)}  ` +
        `coarse ${String(r.coarseFirings).padStart(6)}   ${r.key}`,
    );
  }

  // -- Measurement 2.
  console.log(dim('\n  M2 — patch size, median connected component in COARSE CELLS'));
  console.log(
    dim('    biome         fine%   coarse%   med f/c            ratio   area-wt f/c        ratio  comps f/c'),
  );
  for (const r of patches.rows) {
    const flags = [
      r.within ? '' : 'size',
      r.singlePatch ? 'single-patch' : '',
      r.absent ? 'ABSENT' : '',
    ].filter(Boolean).join(' ');
    console.log(
      `    ${bname(r.biome).padEnd(12)} ${pct(r.fineShare).padStart(7)} ${pct(r.coarseShare).padStart(8)}   ` +
        `${num(r.fineMedianCells, 2).padStart(7)}/${num(r.coarseMedianCells, 2).padEnd(7)} ${times(r.ratio).padStart(8)}   ` +
        `${num(r.fineWeightedCells, 1).padStart(7)}/${num(r.coarseWeightedCells, 1).padEnd(7)} ${times(r.weightedRatio).padStart(8)}   ` +
        `${r.fineComponents.toFixed(0).padStart(4)}/${r.coarseComponents.toFixed(0).padEnd(4)} ` +
        (flags === '' ? bold('PASS') : bold('FAIL') + ' ' + flags),
    );
  }
  console.log(
    `    measurement 2 (spec's plain median): ${verdict(patches.pass)}   ` +
      `area-weighted companion (THRESHOLD-04, NOT the criterion): ${verdict(patches.weightedPass)}`,
  );

  // -- Measurement 3.
  console.log(dim('\n  M3 — two-point correlation, P(same biome | separation), d in coarse cells'));
  const head = correlation.seps.map((d) => String(d).padStart(6)).join('');
  console.log(dim(`    d       ${head}      floor`));
  console.log(
    `    fine    ${correlation.fineCurve.map((v) => v.toFixed(3).padStart(6)).join('')}   ` +
      `${correlation.fineFloor.toFixed(3)}`,
  );
  console.log(
    `    coarse  ${correlation.coarseCurve.map((v) => v.toFixed(3).padStart(6)).join('')}   ` +
      `${correlation.coarseFloor.toFixed(3)}`,
  );
  const unres = (x: number | null) => (x === null ? bold('unresolved') : x.toFixed(2));
  console.log(
    `    correlation length — fine ${unres(correlation.fineLength)}   ` +
      `coarse ${unres(correlation.coarseLength)}   ` +
      `ratio ${bold(times(correlation.ratio))} [<=${CORRELATION_TOLERANCE}x] ${verdict3(correlation)}`,
  );
  if (correlation.unresolved) {
    console.log(
      dim(`      unresolved = C(1)/e sits below the sum(p^2) floor, so the raw curve never ` +
        `crosses it inside d <= ${CORRELATION_D_MAX}.`),
    );
  }
  console.log(
    dim(`    connected C(d)-C(inf) (THRESHOLD-03, NOT the criterion) — `) +
      `fine ${unres(correlation.fineConnected)}   coarse ${unres(correlation.coarseConnected)}   ` +
      `ratio ${bold(times(correlation.connectedRatio))} ${verdict(correlation.connectedWithin)}`,
  );

  // -- Ladder rung 2's second half, and the context numbers.
  console.log(dim('\n  ladder 2 — how much of the divergence was the SEEDING rather than the stepping'));
  console.log(
    `    coarse as built     cell-for-cell ${pct(cellForCell)}   composition ${pct(composition)}   ` +
      `M1 median ${times(activation.medianRatio)}   M3 ratio ${times(correlation.ratio)}`,
  );
  console.log(
    `    coarse reseeded     cell-for-cell ${pct(seededCellForCell)}   composition ${pct(seededComposition)}   ` +
      `M1 median ${times(seededActivation.medianRatio)}   M3 ratio ${times(seededCorrelation.ratio)}`,
  );
  console.log(
    dim('    (reseeded = same coarse world, day-0 biome and moisture replaced by the fine ' +
      'world\'s projection)'),
  );

  // -- Ladder rung 3: are the failures the small/filamentary biomes?
  console.log(dim('\n  ladder 3 — small-biome representability'));
  const small = patches.rows.filter((r) => r.fineShare < 0.10);
  for (const r of small) {
    console.log(
      `    ${bname(r.biome).padEnd(12)} fine ${pct(r.fineShare).padStart(7)}  coarse ${pct(r.coarseShare).padStart(7)}  ` +
        `area-weighted fine patch ${(r.fineWeightedCells * factor * factor).toFixed(0).padStart(7)} tiles  ` +
        `${r.coarseShare === 0 ? bold('ABSENT from the coarse tier') : ''}`,
    );
  }
  const byBiome = new Map<Biome, number>();
  for (const r of activation.oneSidedStructural) byBiome.set(r.from, (byBiome.get(r.from) ?? 0) + 1);
  if (byBiome.size > 0) {
    console.log(dim('    structurally one-sided rules by source biome, against that biome\'s fine share:'));
    const shareOf = new Map(patches.rows.map((r) => [r.biome, r.fineShare]));
    for (const [b, n] of [...byBiome].sort((x, y) => y[1] - x[1]).slice(0, 8)) {
      const s = shareOf.get(b);
      console.log(
        `      ${bname(b).padEnd(12)} ${String(n).padStart(3)} rules   fine share ` +
          `${s === undefined ? dim('<1%') : pct(s)}`,
      );
    }
  }

  // -- Ladder rung 4: only now, the cycles.
  if (specs.length > 0) {
    console.log(dim('\n  ladder 4 — cycle geometry distortion (spec 3\'s ranked suspects, this preset)'));
    for (const d of coarseDistortion(specs, factor).slice(0, 5)) {
      console.log(
        `    ${d.cycle}.${d.param.padEnd(20)} ${String(d.tiles).padStart(4)} tiles -> ` +
          `${d.cells} cells   area ${d.areaTiles} vs ${d.trueAreaTiles} tiles   ${bold(times(d.ratio, 1))}`,
      );
    }
  } else {
    console.log(dim('\n  ladder 4 — no cycles in this preset. Nothing here can be cycle scaling.'));
  }

  // -- Rung 5: the moisture field, which is where the answer turned out to be.
  console.log(dim('\n  ladder 5 — the moisture field, and the length its decay is measured in'));
  console.log(
    `    land mean moisture   fine ${num(fineFields.landMeanMoisture, 1)}   ` +
      `coarse ${bold(num(coarseFields.landMeanMoisture, 1))}      ` +
      `land below ARID(${ARID})   fine ${pct(fineFields.landAridFraction)}   ` +
      `coarse ${bold(pct(coarseFields.landAridFraction))}`,
  );
  console.log(
    `    land mean temperature   fine ${num(fineFields.landMeanTemperature, 1)}   ` +
      `coarse ${num(coarseFields.landMeanTemperature, 1)}`,
  );
  const at = (f: FieldStats, tiles: number) => {
    const p = f.profile.find((x) => x.tiles === tiles);
    return p === undefined ? '   —' : p.moisture.toFixed(0).padStart(4);
  };
  const cols = [8, 16, 24, 32, 40, 48, 56, 64].filter((t) => t % factor === 0);
  console.log(dim(`    mean moisture at TILES inland from open water`));
  console.log(dim(`      tiles   ${cols.map((c) => String(c).padStart(4)).join(' ')}`));
  console.log(`      fine    ${cols.map((c) => at(fineFields, c)).join(' ')}`);
  console.log(`      coarse  ${cols.map((c) => at(coarseFields, c)).join(' ')}`);
  console.log(
    `    land moisture p10/p50/p90   fine ${num(fineFields.p10, 0)}/${num(fineFields.p50, 0)}/${num(fineFields.p90, 0)}` +
      `   coarse ${bold(`${num(coarseFields.p10, 0)}/${num(coarseFields.p50, 0)}/${num(coarseFields.p90, 0)}`)}` +
      `      inland gradient (max-min of the row above)   fine ${num(fineFields.profileRange, 0)}   ` +
      `coarse ${bold(num(coarseFields.profileRange, 0))}`,
  );
  console.log(
    dim('      The hydrology\'s retention is applied ONCE PER GRID STEP (`world.ts` ~:773) and ' +
      'its own comment fixes the scale in\n      tiles: "moisture falls off as ' +
      'exp(-sqrt(2(1-r))·distance)".' +
      (factor === 1
        ? ' At factor 1 a step IS a tile, so the two rows must agree exactly.'
        : ` One coarse step is ${factor} tiles of world, so the\n      same constant carries ` +
          `moisture ~${factor}x farther and the interior never dries — which is what a flat ` +
          'coarse row is.')),
  );
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

function arg(name: string, fallback: number): number {
  const i = process.argv.lastIndexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : fallback;
}

function main(): void {
  const width = arg('width', DEFAULT_WIDTH);
  const height = arg('height', DEFAULT_HEIGHT);
  const seed = arg('seed', DEFAULT_SEED);
  const burnIn = arg('burn-in', DEFAULT_BURN_IN);
  const windowDays = arg('window', DEFAULT_WINDOW);
  const snapshots = arg('snapshots', DEFAULT_SNAPSHOTS);
  /**
   * ★ THE CONTROL THAT PROVES THIS GATE CAN PASS, and the reason it is a flag rather than a
   * constant. `--factor 1` builds the "coarse" tier at FULL resolution from the same seed —
   * two worlds that genuinely agree — and every measurement must then read 1.00x with an
   * overall PASS. A gate that reports FAIL on a tier which is literally the same world is
   * not measuring LOD, it is measuring a bug in the harness, and this repo has already
   * shipped one check that could not fail (spec 1's first agreement check compared
   * `worldgenAt` against a `generate()` that calls it). The control is run and recorded.
   *
   * It also does the work the spec's remedy option 1 needs: `--factor 2` and `--factor 4`
   * say how much of the disagreement is the ratio itself, which is the difference between
   * "shrink `COARSE_FACTOR`" being a fix and being a wish.
   */
  const factor = arg('factor', COARSE_FACTOR);

  const pi = process.argv.lastIndexOf('--preset');
  const only = pi === -1 ? null : process.argv[pi + 1] ?? null;
  if (only !== null && !(only in CYCLE_PRESETS)) {
    throw new Error(`Unknown preset "${only}". Known: ${Object.keys(CYCLE_PRESETS).join(', ')}`);
  }
  const presets = only === null ? PRESET_ORDER : [only];

  const dims = coarseDims(width, height, factor);
  console.log(bold('\n  SUNBORN LEGACY — THE LOD GATE\n'));
  if (factor !== COARSE_FACTOR) {
    console.log(bold(`  CONTROL RUN at factor ${factor}, not the shipped ${COARSE_FACTOR}. Not the gate.`));
  }
  console.log(
    dim(
      `  ${width}x${height} fine (${(width * height).toLocaleString()} tiles)  ·  ` +
        `${dims.width}x${dims.height} coarse (${(dims.width * dims.height).toLocaleString()} cells, 1/${factor})  ·  ` +
        `seed ${seed}\n  burn-in ${burnIn}d, tail window ${windowDays}d, ${snapshots} snapshots  ·  ` +
        `presets: ${presets.join(', ')}`,
    ),
  );
  console.log(
    dim('  Thresholds are spec `d53ccbb6-4`\'s, fixed before measurement. Cell-for-cell ' +
      'agreement is CONTEXT, not a criterion.'),
  );

  // One-way and idempotent by design (`biomes.ts`), and verified there not to move the
  // golden hashes. Enabled before any stepping so both tiers are instrumented identically.
  enableFluxLedger();

  const verdicts: PresetVerdict[] = [];
  for (const p of presets) {
    verdicts.push(runPreset(p, width, height, seed, burnIn, windowDays, snapshots, factor));
  }

  console.log(rule('verdict'));
  console.log(dim('    preset      M1 activation      M2 patch size   M3 correlation   overall'));
  for (const v of verdicts) {
    console.log(
      `    ${v.preset.padEnd(10)} ${verdict(v.activation.pass).padEnd(18)} ` +
        `${verdict(v.patches.pass).padEnd(15)} ${verdict3(v.correlation).padEnd(16)} ${verdict(v.pass)}`,
    );
  }
  const loadBearing = verdicts.filter((v) => v.preset === 'still' || v.preset === 'garden' || v.preset === 'crucible');
  const overall = verdicts.every((v) => v.pass);
  console.log(
    `\n  ${bold('THE GATE:')} ${verdict(overall)} — ` +
      `${verdicts.filter((v) => v.pass).length}/${verdicts.length} presets, ` +
      `${loadBearing.filter((v) => v.pass).length}/${loadBearing.length} of the load-bearing three ` +
      `(still, garden, crucible).`,
  );
  console.log(
    dim('  A negative verdict is the most valuable outcome this epic can produce and must ' +
      'not be softened.\n  It lands before any database exists. See `.wiki/decisions/0030`.\n'),
  );
}

main();
