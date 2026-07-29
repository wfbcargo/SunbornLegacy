/**
 * Terminal reporting for the terrain sim: map render, biome-proportion history,
 * entropy tracking, and the two tests that matter —
 *
 *   1. Does the world stay varied, or does it converge on an absorbing state?
 *   2. Does every region have something worth exporting? ("every start is a niche")
 */

import { BIOME_COUNT, BIOMES, type Biome } from './biomes.ts';
import type { World } from './world.ts';

const COLOUR = process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb';

const fg = (c: number, s: string) => (COLOUR ? `\x1b[38;5;${c}m${s}\x1b[0m` : s);
const bg = (c: number, s: string) => (COLOUR ? `\x1b[48;5;${c}m${s}\x1b[0m` : s);
const dim = (s: string) => (COLOUR ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s: string) => (COLOUR ? `\x1b[1m${s}\x1b[0m` : s);

export interface Sample {
  day: number;
  proportions: Float64Array;
  entropy: number;
}

export function sample(world: World): Sample {
  return { day: world.day, proportions: world.biomeProportions(), entropy: world.biomeEntropy() };
}

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------

export function renderMap(world: World, maxWidth = 118, maxHeight = 44): string {
  const { grid } = world;
  const stepX = Math.max(1, Math.ceil(grid.width / maxWidth));
  const stepY = Math.max(1, Math.ceil(grid.height / maxHeight));
  const lines: string[] = [];

  for (let row = 0; row < grid.height; row += stepY) {
    let line = '';
    for (let col = 0; col < grid.width; col += stepX) {
      const b = world.biome[row * grid.width + col]! as Biome;
      const def = BIOMES[b]!;
      line += fg(def.colour, def.glyph);
    }
    lines.push(line);
  }
  return lines.join('\n');
}

export function legend(): string {
  return BIOMES.map((d) => `${fg(d.colour, d.glyph)} ${d.name}`).join('   ');
}

// ---------------------------------------------------------------------------
// Biome proportions over time — a stacked area chart in the terminal
// ---------------------------------------------------------------------------

export function renderHistory(samples: Sample[], width = 96, rows = 28): string {
  const out: string[] = [];
  const stride = Math.max(1, Math.floor(samples.length / rows));

  out.push(bold('  day  │ biome composition') + dim('  (each column = 1% of the world)') + '  │ entropy');
  out.push('  ─────┼' + '─'.repeat(width) + '┼────────');

  for (let s = 0; s < samples.length; s += stride) {
    const smp = samples[s]!;
    let bar = '';
    let used = 0;
    for (let b = 0; b < BIOME_COUNT; b++) {
      const n = Math.round(smp.proportions[b]! * width);
      if (n <= 0) continue;
      bar += bg(BIOMES[b]!.colour, ' '.repeat(n));
      used += n;
    }
    if (used < width) bar += ' '.repeat(width - used);

    const day = String(Math.round(smp.day)).padStart(5);
    const ent = smp.entropy.toFixed(3).padStart(6);
    out.push(`  ${day}  │${bar}│  ${ent}`);
  }
  return out.join('\n');
}

export function renderComposition(world: World): string {
  const p = world.biomeProportions();
  const order = [...BIOMES].sort((a, b) => p[b.id]! - p[a.id]!);
  return order
    .filter((d) => p[d.id]! > 0.0005)
    .map((d) => {
      const pct = (p[d.id]! * 100).toFixed(1).padStart(5);
      const bar = bg(d.colour, ' '.repeat(Math.max(1, Math.round(p[d.id]! * 60))));
      return `  ${fg(d.colour, d.glyph)} ${d.name.padEnd(10)} ${pct}%  ${bar}`;
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Test 1 — heat death
// ---------------------------------------------------------------------------

export interface StabilityVerdict {
  startEntropy: number;
  /** MEAN entropy across the tail. See the Jensen note in assessStability. */
  endEntropy: number;
  minEntropy: number;
  /** Largest share held by any single biome, averaged across the tail. */
  dominance: number;
  dominantBiome: string;
  /** How much composition still moves late in the run. THE test for heat death. */
  lateChurn: number;
  liveBiomes: number;
  alive: boolean;
  notes: string[];
}

/** Test-1 thresholds. A world must clear all four to count as alive. */
export const ALIVE_ENTROPY = 0.65;
export const ALIVE_MAX_DOMINANCE = 0.4;
export const ALIVE_MIN_CHURN = 0.0015;
export const ALIVE_MIN_BIOMES = 8;

export function assessStability(samples: Sample[]): StabilityVerdict {
  const first = samples[0]!;

  let minEntropy = Infinity;
  for (const s of samples) if (s.entropy < minEntropy) minEntropy = s.entropy;

  // A purged world OSCILLATES, so every late-run metric is a tail mean, never an
  // end-of-run snapshot that lands at an arbitrary phase of the cycle.
  const tail = samples.slice(Math.floor(samples.length * 0.66));

  // ★ MEAN OF THE TAIL'S ENTROPY, not the entropy of the tail's mean composition.
  // Entropy is concave, so an oscillating world's AVERAGE composition is more even
  // than any instant of it and Jensen's inequality inflates the score — measured at
  // +0.072 for a fully-cycled world and +0.000 for a frozen one, i.e. the error is
  // largest exactly where the design is trying to prove a point. Averaging the metric
  // instead of metricising the average removes it.
  let entropySum = 0;
  for (const s of tail) entropySum += s.entropy;
  const meanEntropy = entropySum / Math.max(1, tail.length);

  const meanShare = new Float64Array(BIOME_COUNT);
  for (const s of tail) for (let b = 0; b < BIOME_COUNT; b++) meanShare[b]! += s.proportions[b]!;
  for (let b = 0; b < BIOME_COUNT; b++) meanShare[b]! /= Math.max(1, tail.length);

  let dominance = 0;
  let dominantBiome = '';
  for (let b = 0; b < BIOME_COUNT; b++) {
    if (meanShare[b]! > dominance) {
      dominance = meanShare[b]!;
      dominantBiome = BIOMES[b]!.name;
    }
  }

  // Mean absolute change in composition across the final third of the run.
  let churn = 0;
  for (let i = 1; i < tail.length; i++) {
    let d = 0;
    for (let b = 0; b < BIOME_COUNT; b++) {
      d += Math.abs(tail[i]!.proportions[b]! - tail[i - 1]!.proportions[b]!);
    }
    churn += d / 2;
  }
  const lateChurn = tail.length > 1 ? churn / (tail.length - 1) : 0;

  let liveBiomes = 0;
  for (let b = 0; b < BIOME_COUNT; b++) if (meanShare[b]! > 0.01) liveBiomes++;

  const notes: string[] = [];
  if (meanEntropy < ALIVE_ENTROPY) notes.push('Entropy is low — the world has flattened.');
  if (dominance > ALIVE_MAX_DOMINANCE) {
    notes.push(`${dominantBiome} holds ${(dominance * 100).toFixed(0)}% of the map.`);
  }
  // ★ THE CHURN TERM IS THE POINT OF THIS TEST.
  //
  // The 12-biome version gated on entropy, dominance and biome count alone, and at 22
  // biomes that stopped separating a living world from a dead one: a no-disturbance
  // control measured entropy 0.707 with 99.7% of its tiles holding zero live
  // out-rules, while a fully-cycled world measured 0.703 — the FROZEN world scored
  // HIGHER, and both were reported alive. Recalibrating the entropy threshold cannot
  // fix that, because the two worlds land on the same number. Variety is a snapshot
  // property; being alive is a property of MOTION, and only churn measures motion.
  if (lateChurn < ALIVE_MIN_CHURN) {
    notes.push(
      `Composition has stopped moving (${(lateChurn * 100).toFixed(2)}%/sample) — heat death.`,
    );
  }
  if (liveBiomes < ALIVE_MIN_BIOMES) {
    notes.push(`Only ${liveBiomes} biomes hold more than 1% of the map.`);
  }

  const alive =
    meanEntropy >= ALIVE_ENTROPY &&
    dominance <= ALIVE_MAX_DOMINANCE &&
    lateChurn >= ALIVE_MIN_CHURN &&
    liveBiomes >= ALIVE_MIN_BIOMES;
  if (alive) notes.push('Composition stays varied and keeps moving. No heat death.');

  return {
    startEntropy: first.entropy,
    endEntropy: meanEntropy,
    minEntropy,
    dominance,
    dominantBiome,
    lateChurn,
    liveBiomes,
    alive,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Test 2 — every start is a niche
// ---------------------------------------------------------------------------

export interface RegionReport {
  col: number;
  row: number;
  materials: string[];
  /** Fraction of the region that is dry land. */
  land: number;
  /** Global availability of this region's rarest material. Lower = more distinctive. */
  rarest: number;
  rarestMaterial: string;
}

export interface NicheVerdict {
  /** Regions with enough dry land to settle — the only ones that are spawn candidates. */
  habitable: RegionReport[];
  openWater: RegionReport[];
  generic: RegionReport[];
  thin: RegionReport[];
  medianMaterials: number;
  passes: boolean;
}

/** A biome must hold at least this share of a region to count as an export. */
export const EXPORT_THRESHOLD = 0.03;
/** Global availability above which a material is too common to be a trade identity. */
export const GENERIC_ABOVE = 0.25;
/** Fewer materials than this and a region cannot sustain meaningful industry. */
export const THIN_BELOW = 6;

/**
 * Accumulates region composition across many days, so the niche test measures what a
 * region RELIABLY produces rather than what it happened to look like on one day.
 *
 * This matters more at 22 biomes than it did at 12, and for the same reason
 * SIMULATION.md's fifth bug mattered: a purged world oscillates, so a single end-of-run
 * snapshot lands at an arbitrary phase of the cycle. Measured on the last day of a
 * crucible run — which is a day or two after a beam pass — marsh held 4.2% of the
 * WORLD and was an export in ZERO regions, because the beam had just burned the
 * coastal ribbon to ash. Reed, peat and clay would have been reported as leaving the
 * economy on the strength of a snapshot taken at the worst possible moment.
 *
 * An economy is built on what a place produces over a season, not over an afternoon.
 */
export class NicheSampler {
  readonly regionsX: number;
  readonly regionsY: number;
  private readonly regionCounts: Float64Array;
  private readonly globalCounts: Float64Array;
  private samples = 0;

  constructor(regionsX = 12, regionsY = 8) {
    this.regionsX = regionsX;
    this.regionsY = regionsY;
    this.regionCounts = new Float64Array(regionsX * regionsY * BIOME_COUNT);
    this.globalCounts = new Float64Array(BIOME_COUNT);
  }

  add(world: World): void {
    const { grid } = world;
    const cellW = Math.ceil(grid.width / this.regionsX);
    const cellH = Math.ceil(grid.height / this.regionsY);
    for (let row = 0; row < grid.height; row++) {
      const ry = Math.min(this.regionsY - 1, Math.floor(row / cellH));
      for (let col = 0; col < grid.width; col++) {
        const rx = Math.min(this.regionsX - 1, Math.floor(col / cellW));
        const b = world.biome[row * grid.width + col]!;
        this.regionCounts[(ry * this.regionsX + rx) * BIOME_COUNT + b]!++;
        this.globalCounts[b]!++;
      }
    }
    this.samples++;
  }

  get sampleCount(): number {
    return this.samples;
  }

  assess(): NicheVerdict {
    let worldTotal = 0;
    for (let b = 0; b < BIOME_COUNT; b++) worldTotal += this.globalCounts[b]!;

    // Global availability per material: fraction of the world that can produce it.
    const availability = new Map<string, number>();
    for (let b = 0; b < BIOME_COUNT; b++) {
      const share = this.globalCounts[b]! / Math.max(1, worldTotal);
      for (const m of BIOMES[b]!.materials) {
        availability.set(m, (availability.get(m) ?? 0) + share);
      }
    }

    const regions: RegionReport[] = [];
    for (let ry = 0; ry < this.regionsY; ry++) {
      for (let rx = 0; rx < this.regionsX; rx++) {
        const base = (ry * this.regionsX + rx) * BIOME_COUNT;
        let total = 0;
        let landTiles = 0;
        for (let b = 0; b < BIOME_COUNT; b++) {
          const n = this.regionCounts[base + b]!;
          total += n;
          // Lava is water:true because it FLOWS, not because it is sea. Counting it as
          // ocean here makes an erupting province read as uninhabitable open water and
          // drops it out of the niche test entirely — the opposite of the truth, since
          // a lava field is a fortnight away from being the best farmland on the world.
          if (!BIOMES[b]!.water || BIOMES[b]!.molten) landTiles += n;
        }
        if (total === 0) continue;

        const materials = new Set<string>();
        for (let b = 0; b < BIOME_COUNT; b++) {
          if (this.regionCounts[base + b]! / total >= EXPORT_THRESHOLD) {
            for (const m of BIOMES[b]!.materials) materials.add(m);
          }
        }

        let rarest = 1;
        let rarestMaterial = '—';
        for (const m of materials) {
          const a = availability.get(m) ?? 0;
          if (a < rarest) {
            rarest = a;
            rarestMaterial = m;
          }
        }

        regions.push({
          col: rx, row: ry, materials: [...materials],
          land: landTiles / total, rarest, rarestMaterial,
        });
      }
    }

    // Open ocean is not a spawn candidate, so it is not held to the niche test.
    const habitable = regions.filter((r) => r.land >= 0.25);
    const openWater = regions.filter((r) => r.land < 0.25);

    const counts = habitable.map((r) => r.materials.length).sort((a, b) => a - b);
    const medianMaterials = counts[Math.floor(counts.length / 2)] ?? 0;

    // "Generic" = nothing it produces is globally scarce, so it has no trade identity.
    const generic = habitable.filter((r) => r.rarest > GENERIC_ABOVE);
    // "Thin" = too few materials to sustain meaningful industry.
    const thin = habitable.filter((r) => r.materials.length < THIN_BELOW);

    return {
      habitable,
      openWater,
      generic,
      thin,
      medianMaterials,
      passes: generic.length === 0 && thin.length === 0,
    };
  }
}

/** Single-snapshot niche assessment. Prefer NicheSampler on an oscillating world. */
export function assessNiches(world: World, regionsX = 12, regionsY = 8): NicheVerdict {
  const s = new NicheSampler(regionsX, regionsY);
  s.add(world);
  return s.assess();
}

export function renderNiches(v: NicheVerdict): string {
  const out: string[] = [];
  out.push(`  habitable regions     ${v.habitable.length}` + dim(`   (${v.openWater.length} open water, not spawn candidates)`));
  out.push(`  median materials      ${v.medianMaterials}`);
  out.push(
    `  generic regions       ${v.generic.length}` +
      dim('   (nothing globally scarce to export)'),
  );
  out.push(`  thin regions          ${v.thin.length}` + dim('   (fewer than 6 materials)'));

  const distinctive = [...v.habitable].sort((a, b) => a.rarest - b.rarest).slice(0, 6);
  out.push('');
  out.push(dim('  most distinctive regions:'));
  for (const r of distinctive) {
    out.push(
      `    (${String(r.col).padStart(2)},${String(r.row).padStart(2)})  ` +
        `${r.rarestMaterial.padEnd(11)} ${dim(`${(r.rarest * 100).toFixed(1)}% of world`)}  ` +
        dim(`${r.materials.length} materials`),
    );
  }
  return out.join('\n');
}

export { bold, dim, fg };
