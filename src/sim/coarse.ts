/**
 * The coarse tier: the same world at 1/8 resolution.
 *
 * `ARCHITECTURE.md#4.1` is emphatic that this is a REAL cellular automaton and not a
 * per-region biome-proportion vector, and the reason is measured rather than aesthetic:
 * every land/water rule in `biomes.ts` is a THRESHOLD on `waterNeighbours` (`>=3`, `>=4`,
 * `<=2`) and the real neighbour distribution is extreme-bimodal. Over 200 regions,
 * mean-field predicted 9,702 tiles eligible for "sea takes it" where the true count was
 * **0** — Jensen's inequality against a hard threshold, and the error is not drift, it is
 * zero versus thousands. A coarse CA keeps the thresholds meaningful because each coarse
 * cell holds ONE biome and has SIX neighbours, exactly like a tile.
 *
 * ★ THE COARSE WORLD IS AN ORDINARY `World`. It is not a second stepping loop, and that is
 * deliberate: two implementations of the same rules drift, and this repo has already been
 * bitten twice by a second implementation of the beam's geometry drifting from the first.
 * Everything here is coordinate and parameter mapping; the simulation is `stepDay()`.
 *
 * ★ WHY THE SAME SEED GIVES THE SAME GROUND. `periodicNoise` normalises by grid size
 * (`worldgen.ts`), so coarse cell `(c, r)` samples the continuous field at exactly the
 * point fine tile `(8c, 8r)` does, and `latitudeHeat` agrees because
 * `26·cos(2π·8r/height) = 26·cos(2π·r/(height/8))`. The coarse world is a point sample of
 * the same world, not a different one.
 *
 * ⚠️ A point sample at the block's CORNER — not the block's average. `projectBiome` below
 * computes the average (modal) view, and the two are not the same thing. Spec
 * `d53ccbb6-4` measures how far apart they run; nothing here should assume it is small.
 */

import { World, type WorldOptions } from './world.ts';
import { BIOME_COUNT, type Biome } from './biomes.ts';
import { cycleCatalogueEntry, type CycleSpec } from './cycles.ts';

/**
 * Tiles per coarse cell edge. 8, from `ARCHITECTURE.md#4.1` — 64 tiles per cell, 16 cells
 * per 32×32 region.
 */
export const COARSE_FACTOR = 8;

/**
 * How a cycle parameter behaves under a change of resolution.
 *
 * ★ EVERY SPATIAL PARAMETER IS CLASSIFIED EXPLICITLY, and an unclassified one is a bug
 * rather than a default. A parameter silently left unscaled is a cycle whose geometry is
 * 8x too big on the coarse tier, which would show up in spec 4 as "the tiers disagree"
 * with no indication that the cause was a forgotten field name.
 *
 *   length — measured in tiles, rows or columns. Scales with resolution.
 *   count  — how many of a thing exist in the WHOLE WORLD. The world is the same world at
 *            either resolution, so these do NOT scale. Ten vents are ten vents.
 *   time   — days. The coarse tier steps once per day exactly as the fine tier does, and
 *            `medianToProbability` is a per-day rate, so these do NOT scale.
 */
const LENGTH_UNITS: ReadonlySet<string> = new Set(['tiles', 'hexes', 'columns', 'rows']);

/**
 * Units that describe something other than a distance across the map: time, counts of
 * repetitions, phases, and the unitless intensities (heat, moisture, probabilities). None
 * of them change when the grid does.
 */
const INVARIANT_UNITS: ReadonlySet<string> = new Set([
  'days', 'quarter-years', 'traverses', 'turns',
]);

/** Spec keys that are not cycle parameters at all. */
const NON_PARAM_KEYS: ReadonlySet<string> = new Set(['kind', 'key']);

/**
 * Is this parameter a distance across the map?
 *
 * ★ DERIVED FROM THE CATALOGUE'S `unit`, NEVER HAND-ENUMERATED — the same discipline
 * `world.ts`'s `TERRAIN_CLASS` applies to biome predicates, and for the same reason: a
 * hand-written list of "which parameters are lengths" is a parameter that silently stops
 * scaling the day someone adds one, and the symptom would be a coarse cycle 8x the size it
 * should be with nothing to say so.
 *
 * This was in fact written as a hand list first, and the catalogue caught **two** omissions
 * in it immediately: `solarbeam.homeRow` (unit `rows`) and `weather.sampleSpread` (unit
 * `hexes`) were both missing, so both would have thrown here rather than scaling — which is
 * the good failure, but only because the fallback throws. Deriving removes the question.
 *
 * ⚠️ ONE KNOWN CATALOGUE GAP. `monsoon.startRow` carries NO unit, while `solarbeam.homeRow`
 * carries `rows` — the two are the same kind of quantity, so one of them is mis-declared in
 * `cycles.ts`. Treated as invariant here because that is what the catalogue says, and this
 * spec is not authorised to edit `cycles.ts`. Impact is nil at the shipped default of 0
 * (`coarseLength` returns 0 unchanged) and is confined to a GM who sets a non-zero start
 * row, whose coarse monsoon would then begin at a different latitude than the fine one.
 */
function unitOf(kind: string, param: string): string {
  const entry = cycleCatalogueEntry(kind);
  const found = entry.params.find((p) => p.name === param);
  if (found === undefined) {
    throw new Error(
      `Cycle "${kind}" has no catalogue entry for parameter "${param}". Either the spec is ` +
        `malformed or CYCLE_CATALOGUE is out of date with the params interface.`,
    );
  }
  return found.unit ?? '';
}

function scalesWithGrid(kind: string, param: string): boolean {
  const unit = unitOf(kind, param);
  if (LENGTH_UNITS.has(unit)) return true;
  if (unit === '' || INVARIANT_UNITS.has(unit)) return false;
  throw new Error(
    `Cycle parameter "${kind}.${param}" has unit "${unit}", which coarse.ts does not ` +
      `classify. Add it to LENGTH_UNITS or INVARIANT_UNITS — guessing is how a cycle ends ` +
      `up 8x too big on the coarse tier with nothing to say so.`,
  );
}

/**
 * A length in tiles, expressed in coarse cells.
 *
 * ★ THE `max(1, ...)` CLAMP IS THE MOST CONSEQUENTIAL LINE IN THIS FILE. Sub-cell features
 * cannot be represented at all: the beam's `focusRadiusHexes` is 2 tiles, which is a
 * QUARTER of one coarse cell. Rounding it honestly gives 0 and the feature disappears —
 * and `Focus` is the flag gating `the core boils it dry` (decision `0027`), `sand to
 * glass` and `stone fuses`, i.e. the beam's entire chemistry. A coarse tier that cannot
 * raise Focus simulates a different world.
 *
 * Clamping to 1 keeps the feature alive at the cost of making it far too big: a radius-2
 * disc is ~19 tiles; one coarse cell of radius 1 is ~7 cells = ~448 tiles, an
 * over-representation of about 24x by area. Neither choice is correct. The clamp is the
 * less wrong of the two, and `coarseDistortion()` reports the damage so spec 4 knows where
 * to look first rather than discovering it as an unexplained divergence.
 */
export function coarseLength(tiles: number, factor = COARSE_FACTOR): number {
  if (tiles <= 0) return tiles;
  return Math.max(1, Math.round(tiles / factor));
}

export interface CoarseDims {
  readonly width: number;
  readonly height: number;
}

/**
 * Coarse dimensions for a fine world. Rejects rather than rounds, which is `limits.ts`'s
 * established stance — a world silently resized is a world whose recorded numbers describe
 * something else.
 */
export function coarseDims(width: number, height: number, factor = COARSE_FACTOR): CoarseDims {
  if (width % factor !== 0 || height % factor !== 0) {
    throw new Error(
      `A ${width}x${height} world has no ${factor}x${factor} coarse tier: both dimensions ` +
        `must divide by ${factor} (got ${width % factor} and ${height % factor} left over). ` +
        `Nearest usable: ${Math.round(width / factor) * factor}x${Math.round(height / factor) * factor}.`,
    );
  }
  return { width: width / factor, height: height / factor };
}

/**
 * A cycle spec with every length parameter expressed in coarse cells.
 *
 * ★ IT SCALES THE EFFECTIVE PARAMETERS, NOT THE WRITTEN ONES, AND THE DIFFERENCE IS A BUG
 * THIS FILE SHIPPED WITH FOR ONE ITERATION. A preset spec names almost nothing —
 * `anvil` is `[{ kind: 'solarbeam', transitDays: 60 }]` — and `radiusHexes: 8` arrives from
 * the constructor's defaults. Walking `Object.entries(spec)` therefore scales *none* of the
 * geometry, and the coarse world silently reads `radiusHexes: 8` as EIGHT COARSE CELLS,
 * i.e. 64 tiles: on a 30x18 coarse world, a beam wider than the world. The first smoke run
 * measured `crucible` at 4.4% cell-for-cell agreement and 83.15% composition distance, and
 * that number was an artefact of this, not a fact about LOD.
 *
 * So defaults are merged in from `CYCLE_CATALOGUE` first, and the result is explicit about
 * every length. The catalogue is the right source because it is the same one the
 * constructors use, so an instance and this cannot disagree.
 */
export function coarseCycleSpec(spec: CycleSpec, factor = COARSE_FACTOR): CycleSpec {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(effectiveSpec(spec))) {
    out[k] =
      !NON_PARAM_KEYS.has(k) && typeof v === 'number' && scalesWithGrid(spec.kind, k)
        ? coarseLength(v, factor)
        : v;
  }
  return out as CycleSpec;
}

/**
 * A spec with catalogue defaults filled in, still in TILE units.
 *
 * `CycleCatalogueEntry.params` is an ARRAY of `{name, default, unit, …}` descriptors, not a
 * keyed record — spreading it directly produced a spec with keys `"0"`, `"1"`, … and every
 * cycle then threw. Worth stating because the declared type reads
 * `Readonly<Record<string, …>>`, which is what made the wrong shape look right.
 */
export function effectiveSpec(spec: CycleSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of cycleCatalogueEntry(spec.kind).params) {
    if (p.default !== undefined) out[p.name] = p.default;
  }
  return { ...out, ...spec };
}

/**
 * The coarse world for a fine one: same seed, same rules, same cycles, 1/8 the resolution.
 *
 * Cycle INSTANCES are rejected — only plain specs can be re-parameterised, and a bound
 * `WorldCycle` carries the fine world's geometry inside it.
 */
export function makeCoarseWorld(opts: WorldOptions, factor = COARSE_FACTOR): World {
  const dims = coarseDims(opts.width, opts.height, factor);
  const specs = opts.cycles ?? [];
  const coarseSpecs = specs.map((s) => {
    if (typeof (s as { dayState?: unknown }).dayState === 'function') {
      throw new Error(
        'makeCoarseWorld needs plain CycleSpec objects, not bound WorldCycle instances: an ' +
          'instance already carries the fine world\'s width, height and geometry.',
      );
    }
    return coarseCycleSpec(s as CycleSpec, factor);
  });

  return new World({
    width: dims.width,
    height: dims.height,
    seed: opts.seed,
    seaLevel: opts.seaLevel,
    cycles: coarseSpecs,
    // ★ THE FIELD-PHYSICS TWIN OF `coarseCycleSpec`. Cycle lengths were scaled here from
    // day one; hydrology retention and THERMAL_KAPPA lived in world.ts and were not, so
    // one coarse step carried moisture eight tiles' worth of ground and every dry
    // transition went silent (decision `0030`). Passing the factor makes world.ts scale
    // the moisture leak by `factor^MOISTURE_LEAK_GRID_POWER` and `κ` by `1/factor²`
    // (decision `0031`).
    cellSizeTiles: factor,
  });
}

/**
 * Modal biome per coarse cell — the projection `ARCHITECTURE.md#4.1` requires whenever a
 * region is materialized, so the two tiers cannot drift precisely where players live.
 *
 * Ties break toward the LOWEST biome id, deterministically (R-004). An arbitrary tie-break
 * would make the projection depend on iteration order, and a projection that is not a pure
 * function of the tiles is not a projection.
 */
export function projectBiome(fine: World, factor = COARSE_FACTOR): Uint8Array {
  const { width, height } = fine.grid;
  const dims = coarseDims(width, height, factor);
  const out = new Uint8Array(dims.width * dims.height);
  const counts = new Int32Array(BIOME_COUNT);

  for (let cr = 0; cr < dims.height; cr++) {
    for (let cc = 0; cc < dims.width; cc++) {
      counts.fill(0);
      for (let dr = 0; dr < factor; dr++) {
        for (let dc = 0; dc < factor; dc++) {
          counts[fine.biome[(cr * factor + dr) * width + (cc * factor + dc)]!]!++;
        }
      }
      let best = 0;
      let bestCount = -1;
      for (let b = 0; b < BIOME_COUNT; b++) {
        if (counts[b]! > bestCount) { bestCount = counts[b]!; best = b; }
      }
      out[cr * dims.width + cc] = best as Biome;
    }
  }
  return out;
}

/** Mean moisture per coarse cell. */
export function projectMoisture(fine: World, factor = COARSE_FACTOR): Float32Array {
  const { width, height } = fine.grid;
  const dims = coarseDims(width, height, factor);
  const out = new Float32Array(dims.width * dims.height);
  const per = factor * factor;

  for (let cr = 0; cr < dims.height; cr++) {
    for (let cc = 0; cc < dims.width; cc++) {
      let sum = 0;
      for (let dr = 0; dr < factor; dr++) {
        for (let dc = 0; dc < factor; dc++) {
          sum += fine.moisture[(cr * factor + dr) * width + (cc * factor + dc)]!;
        }
      }
      out[cr * dims.width + cc] = sum / per;
    }
  }
  return out;
}

export interface DistortionRow {
  readonly cycle: string;
  readonly param: string;
  readonly tiles: number;
  readonly cells: number;
  /** Area the coarse feature covers, in TILES, against the area it should cover. */
  readonly areaTiles: number;
  readonly trueAreaTiles: number;
  readonly ratio: number;
}

/**
 * How badly each length parameter is misrepresented at coarse resolution.
 *
 * Hex disc of radius `r` covers `1 + 3r(r+1)` cells. A coarse cell is `factor²` tiles, so a
 * coarse radius of `r'` covers `(1 + 3r'(r'+1)) · factor²` tiles against the fine
 * `1 + 3r(r+1)`. Reported so spec 4 has a ranked list of suspects before it starts.
 */
export function coarseDistortion(
  specs: readonly CycleSpec[], factor = COARSE_FACTOR,
): DistortionRow[] {
  const disc = (r: number) => 1 + 3 * r * (r + 1);
  const rows: DistortionRow[] = [];
  for (const spec of specs) {
    for (const [k, v] of Object.entries(effectiveSpec(spec))) {
      if (typeof v !== 'number' || v <= 0 || NON_PARAM_KEYS.has(k) || !scalesWithGrid(spec.kind, k)) continue;
      const cells = coarseLength(v, factor);
      const areaTiles = disc(cells) * factor * factor;
      const trueAreaTiles = disc(v);
      rows.push({
        cycle: spec.kind, param: k, tiles: v, cells,
        areaTiles, trueAreaTiles, ratio: areaTiles / trueAreaTiles,
      });
    }
  }
  return rows.sort((a, b) => b.ratio - a.ratio);
}
