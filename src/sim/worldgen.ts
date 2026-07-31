/**
 * Worldgen as a pure function of position.
 *
 * A tile's day-0 state depends on nothing but `(seed, width, height, seaLevel, col, row)`.
 * This module holds that function so a caller can generate ONE tile — or one region's 64
 * tiles — without allocating a world. `World.generate()` is now a loop over it, and it is
 * the same loop it always was: extracting this changed no behaviour and moved no golden
 * hash (spec `d53ccbb6-1`).
 *
 * Two callers need it beyond `World`:
 *   - lazy materialization (`ARCHITECTURE.md#4.3`) generates a region's tiles on demand,
 *     and cannot afford to build the world to do it;
 *   - the coarse tier samples the SAME continuous noise field at 1/8 resolution, which
 *     works only because the field is normalised by grid size — see `periodicNoise`.
 *
 * ⚠️ `ARCHITECTURE.md#13` Phase 1 specifies `worldgenAt(seed, col, row)`. That signature
 * cannot reproduce this world: the noise is normalised by grid dimensions, so the same
 * `(seed, col, row)` yields different terrain at 240×144 than at 512×512. The dimensions
 * are therefore part of the config, not implied. This is a correction to that document.
 */

import { mulberry32, rollAt } from './rng.ts';
import {
  ARID, Biome, BIOMES, COLD, DRY, GLACIAL, MOIST, SCORCHING, WARM, WET,
} from './biomes.ts';

/**
 * Everything worldgen needs that is not the tile's own position.
 *
 * The three noise seeds are drawn ONCE from a `mulberry32` stream and cached here.
 * ★ Their draw order — elevation, moisture, roughness — is load-bearing: reorder it and
 * every seed shifts, every noise field changes, and every golden hash moves.
 */
export interface WorldgenConfig {
  readonly width: number;
  readonly height: number;
  readonly seaLevel: number;
  readonly elevSeed: number;
  readonly moistSeed: number;
  readonly roughSeed: number;
  readonly tectSeed: number;
}

/** One tile's day-0 state. Mutable so a caller can reuse a single scratch object. */
export interface WorldgenTile {
  elevation: number;
  heatOffset: number;
  moistOffset: number;
  biome: Biome;
  moisture: number;
  tectonic: number;
}

export function makeWorldgenTile(): WorldgenTile {
  return {
    elevation: 0, heatOffset: 0, moistOffset: 0, biome: Biome.Ocean, moisture: 0, tectonic: 0,
  };
}

/**
 * ★ `tectSeed` IS DRAWN LAST, AND THAT IS NOT COSMETIC. The first three draws must come
 * off this stream in the order they always have — appending a fourth leaves them
 * bit-identical, inserting one anywhere earlier shifts every seed after it and moves
 * every golden hash.
 */
export function worldgenConfig(
  seed: number, width: number, height: number, seaLevel: number,
): WorldgenConfig {
  const rand = mulberry32(seed ^ 0x5eed);
  const elevSeed = (rand() * 1e9) | 0;
  const moistSeed = (rand() * 1e9) | 0;
  const roughSeed = (rand() * 1e9) | 0;
  const tectSeed = (rand() * 1e9) | 0;
  return { width, height, seaLevel, elevSeed, moistSeed, roughSeed, tectSeed };
}

/**
 * How many octaves the tectonic field gets. Measured, not chosen — and the first guess
 * was wrong in the opposite direction to the obvious worry.
 *
 * The worry was salt-and-pepper: a high-octave field thresholding into speckles, so that
 * "this range has always been iron country" would be false at the scale a caravan
 * crosses. So this started at 2 octaves. Measured, 240×144 seed 20260729, counting
 * connected components of the above-threshold set on the hex torus:
 *
 *     oct  t=0.60                     t=0.70
 *      2   35.77%, 1 component        17.01%, 1 component
 *      3   31.69%, 2                  11.15%, 2  (3742, 112)
 *      4   30.70%, 3                   8.52%, 6  (1909, 877, 89)
 *      5   29.90%, 5                   7.10%, 9  (1537, 807, 55)
 *
 * The failure at 2 octaves is the mirror image of the one feared: not speckle but a
 * SUPERCONTINENT. A third of the world above threshold in ONE component means every
 * mineral province touches every other, and regional materials have no geography to be
 * regional about. Four octaves is where the field breaks into a large craton plus
 * genuinely separate smaller provinces.
 *
 * ★ ONE COMPONENT ALWAYS DOMINATES, AT EVERY OCTAVE COUNT, and that is a property of
 * thresholding fractal noise rather than a tuning failure — level sets of smooth noise
 * percolate. It also happens to be what continental crust looks like: a few big cratons
 * and a scatter of smaller ones. Anyone wanting many similar-sized provinces needs a
 * different construction (Worley cells, not fbm), not a different octave count.
 *
 * The threshold itself is deliberately NOT fixed here — it belongs to whichever rule
 * eventually reads the field, and today none does.
 */
const TECTONIC_OCTAVES = 4;

/**
 * A torus has no poles, so latitude is a smooth periodic band instead: one hot
 * equator at row 0 and one cold band at row H/2, continuous across the seam.
 */
export function latitudeHeat(row: number, height: number): number {
  return 26 * Math.cos((2 * Math.PI * row) / height);
}

/**
 * Day-0 state for one tile. Writes into `out` and returns it, so a whole-grid loop
 * allocates one object rather than one per tile.
 *
 * ★ THE TWO `Math.fround` CALLS ARE NOT DECORATION. In the original `World.generate()`,
 * `heatOffset` and `moistOffset` were written into `Float32Array`s and then READ BACK
 * OUT of them on the next two lines to compute `heat` and `moist`. That round-trip
 * rounds to float32, and the biome a tile receives depends on the rounded values.
 * `elev`, by contrast, was passed to `seedBiome` as the raw double and only stored
 * afterwards — so it must NOT be rounded here. Getting either backwards changes tiles
 * near a climate threshold and moves both golden hashes.
 */
export function worldgenAt(
  cfg: WorldgenConfig, col: number, row: number, out: WorldgenTile = makeWorldgenTile(),
): WorldgenTile {
  const { width, height } = cfg;

  const elev = fbm(col, row, cfg.elevSeed, 3, width, height);
  const damp = fbm(col, row, cfg.moistSeed, 4, width, height);
  const rough = fbm(col, row, cfg.roughSeed, 5, width, height);

  // Elevation cools, and adds regional variety beyond pure latitude. Note this is
  // lossy in both directions — clamped below 0.5 and mixed with `rough` above it —
  // which is exactly why the raw elevation field is stored rather than inverted from
  // here (decision `0018`).
  const heatOffset = Math.fround(-34 * Math.max(0, elev - 0.5) + (rough - 0.5) * 10);
  const moistOffset = Math.fround((damp - 0.5) * 26);

  const heat = 50 + latitudeHeat(row, height) + heatOffset;
  const moist = 45 + moistOffset + (damp - 0.5) * 30;

  const b = seedBiome(elev, heat, moist, cfg.seaLevel);

  // Seed from the SAME per-biome source the simulation uses, so day 0 is already
  // a consistent hydrological state. Reading `water ? 100` here while `evaluateTile`
  // reads `moistureSource` diverges the instant worldgen emits a frozen sea (source 55)
  // or a lava field (source 0), and the divergence shows up as a one-day pulse of
  // phantom moisture that is very hard to attribute.
  const source = BIOMES[b]!.moistureSource;

  out.elevation = elev;
  out.heatOffset = heatOffset;
  out.moistOffset = moistOffset;
  out.biome = b;
  out.moisture = source > 0 ? source : Math.max(0, Math.min(100, moist));
  // Independent of elevation on purpose: height and crustal activity are different facts
  // about a place, so a world may hold a high dead plateau and a low active belt. Read by
  // nothing today — see the field on `World` and `TileContext.tectonic`.
  out.tectonic = fbm(col, row, cfg.tectSeed, TECTONIC_OCTAVES, width, height);
  return out;
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
export function seedBiome(elev: number, heat: number, moist: number, seaLevel: number): Biome {
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
export function fbm(
  col: number, row: number, seed: number, octaves: number, width: number, height: number,
): number {
  let total = 0;
  let amplitude = 1;
  let norm = 0;
  let periodX = 4;
  let periodY = 3;

  for (let o = 0; o < octaves; o++) {
    total += amplitude * periodicNoise(col, row, periodX, periodY, seed + o * 7919, width, height);
    norm += amplitude;
    amplitude *= 0.5;
    periodX *= 2;
    periodY *= 2;
  }
  return total / norm;
}

/**
 * ★ THE NORMALISATION BY GRID SIZE IS WHY LOD WORKS. `gx` is a fraction of the world,
 * not a tile index, so a grid of `width/8 × height/8` sampling this function walks the
 * SAME continuous field at lower resolution rather than an unrelated one. The coarse
 * tier depends on that; so does the fact that the dimensions must be parameters.
 */
export function periodicNoise(
  col: number, row: number, periodX: number, periodY: number, seed: number,
  width: number, height: number,
): number {
  const gx = (col / width) * periodX;
  const gy = (row / height) * periodY;
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
