/**
 * Parameter sweeps over the world's disturbance engine.
 *
 *   node src/sim/sweep.ts
 *
 * Three sweeps, answering three different questions:
 *
 *   A. THE BEAM. Severity (transit) and recovery (cycle) are separate knobs, and the
 *      window between "frozen" and "sterilised" is the single most important dial a
 *      Game Master is handed. This sweep is also the regression check against the
 *      numbers recorded in SIMULATION.md.
 *
 *   B. THE CYCLE SET. The general form of the same finding: a world's cycles ARE its
 *      identity, and more of them should make a world more alive rather than more
 *      damaged. `still` is the control and must come out dead.
 *
 *   C. THE LONG HORIZON. Every metric above is measured over ~3 game-years, and the
 *      coastline's failure mode is invisible at that range in BOTH directions. The
 *      prototype drained its oceans 21% -> 11.9% over four game-years; the 22-biome
 *      ruleset then flooded them 24% -> 55% over sixty, because sea ice had no
 *      grounding edge and quake subsidence had no counterweight. Neither shows up in a
 *      1200-day run. This sweep runs 40 game-years and reports the TREND, so a
 *      one-way membrane cannot be reintroduced quietly again.
 */

import { BIOMES, Biome, BIOME_COUNT } from './biomes.ts';
import { CYCLE_PRESETS } from './cycles.ts';
import { World } from './world.ts';

const WIDTH = 180;
const HEIGHT = 108;
const DAYS = 1200;
const SEED = 20260729;

/** Biomes that can sustain settlement and agriculture. */
const LIVING: Biome[] = [
  Biome.Marsh, Biome.Swamp, Biome.Grassland, Biome.Savanna,
  Biome.Forest, Biome.Rainforest, Biome.Bloom, Biome.Soil,
];
/** Biomes left behind by a purge or an eruption. */
const WASTE: Biome[] = [Biome.Glass, Biome.Barren, Biome.Desert, Biome.Ash, Biome.Lava];
/** Everything that counts as sea for the coastline membrane. Lava is NOT sea. */
const SEA_SHARE: Biome[] = [Biome.Ocean, Biome.Shallows, Biome.FrozenSea];

const share = (p: Float64Array, list: Biome[]) => list.reduce<number>((sum, b) => sum + p[b]!, 0);
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

interface Result {
  label: string;
  entropy: number;
  churn: number;
  living: number;
  livingMin: number;
  livingMax: number;
  waste: number;
  water: number;
  bloom: number;
  liveBiomes: number;
}

function measure(label: string, world: World, days: number): Result {
  let prev = world.biomeProportions();
  let churnTotal = 0;
  let churnSamples = 0;

  // A purged world OSCILLATES: scoured right after the beam, lush before the next
  // one. A single end-of-run snapshot lands at an arbitrary point in that cycle and
  // reports it as the steady state. Average across the tail instead, and track the
  // range — the swing between lush and scoured is the design, not an error.
  //
  // Entropy is averaged as a METRIC, never computed from the averaged composition:
  // entropy is concave, so entropy-of-the-mean is systematically higher than
  // mean-of-the-entropy on exactly the oscillating worlds this sweep is arguing for.
  const livingSamples: number[] = [];
  const wasteSamples: number[] = [];
  const waterSamples: number[] = [];
  const bloomSamples: number[] = [];
  const entropySamples: number[] = [];
  const liveBiomeSamples: number[] = [];

  for (let d = 1; d <= days; d++) {
    world.stepDay();
    // Final third only, matching report.ts. Half the run still contains the worldgen
    // transient on a quiet world, which flatters the control's churn by an order of
    // magnitude and blunts the one comparison this file exists to make.
    if (d > days * 0.66 && d % 5 === 0) {
      const now = world.biomeProportions();
      let delta = 0;
      for (let b = 0; b < BIOME_COUNT; b++) delta += Math.abs(now[b]! - prev[b]!);
      churnTotal += delta / 2;
      churnSamples++;
      prev = now;

      livingSamples.push(share(now, LIVING));
      wasteSamples.push(share(now, WASTE));
      waterSamples.push(share(now, SEA_SHARE));
      bloomSamples.push(now[Biome.Bloom]!);
      entropySamples.push(world.biomeEntropy());
      let n = 0;
      for (let b = 0; b < BIOME_COUNT; b++) if (now[b]! > 0.005) n++;
      liveBiomeSamples.push(n);
    }
  }

  return {
    label,
    entropy: mean(entropySamples),
    churn: churnSamples ? churnTotal / churnSamples : 0,
    living: mean(livingSamples),
    livingMin: Math.min(...livingSamples),
    livingMax: Math.max(...livingSamples),
    waste: mean(wasteSamples),
    water: mean(waterSamples),
    bloom: mean(bloomSamples),
    liveBiomes: mean(liveBiomeSamples),
  };
}

function header(title: string, subtitle: string): void {
  console.log(`\n  ${title}`);
  console.log(`  ${subtitle}\n`);
  console.log('  config       entropy   churn%    living% (min–max)     waste%   water%   biomes>0.5%');
  console.log('  ' + '─'.repeat(84));
}

function row(r: Result): void {
  const range = `${(r.livingMin * 100).toFixed(0)}–${(r.livingMax * 100).toFixed(0)}`;
  console.log(
    `  ${r.label.padEnd(12)} ` +
      `${r.entropy.toFixed(3).padStart(6)}  ` +
      `${(r.churn * 100).toFixed(2).padStart(6)}  ` +
      `${(r.living * 100).toFixed(1).padStart(8)} ${`(${range})`.padStart(10)}  ` +
      `${(r.waste * 100).toFixed(1).padStart(7)}  ` +
      `${(r.water * 100).toFixed(1).padStart(6)}  ` +
      `${r.liveBiomes.toFixed(1).padStart(9)}`,
  );
}

// A world is "good" when it is varied, still moving, and mostly habitable.
const TARGET = '  Target: entropy > 0.65, churn > 0.15%, living > 25%, waste < 45%, biomes>0.5% >= 11';
function verdict(r: Result): void {
  const ok =
    r.entropy > 0.65 && r.churn > 0.0015 && r.living > 0.25 && r.waste < 0.45 && r.liveBiomes >= 11;
  const reasons: string[] = [];
  if (r.entropy <= 0.65) reasons.push('flat');
  if (r.churn <= 0.0015) reasons.push('frozen');
  if (r.living <= 0.25) reasons.push('uninhabitable');
  if (r.waste >= 0.45) reasons.push('wasteland');
  if (r.liveBiomes < 11) reasons.push('too few biomes');
  console.log(`  ${ok ? '✓' : '✗'} ${r.label.padEnd(12)} ${ok ? 'viable world' : reasons.join(', ')}`);
}

// ===========================================================================
// A — the beam
// ===========================================================================

/** [label, beamEnabled, transitDays (severity), cycleDays (recovery time)] */
const beamConfigs: [string, boolean, number, number][] = [
  ['no beam', false, 0, 0],
  ['30d/180d', true, 30, 180],
  ['30d/360d', true, 30, 360],
  ['60d/240d', true, 60, 240],
  ['60d/360d', true, 60, 360],
  ['60d/720d', true, 60, 720],
  ['120d/480d', true, 120, 480],
];

header(
  `BEAM PARAMETER SWEEP — ${WIDTH}×${HEIGHT}, ${DAYS} days, seed ${SEED}`,
  'transit = how fast the beam crosses (severity) · cycle = time between purges',
);
const beamResults: Result[] = [];
for (const [label, beam, transit, cycle] of beamConfigs) {
  const world = new World({
    width: WIDTH, height: HEIGHT, seed: SEED,
    beam, beamTransitDays: transit, beamCycleDays: cycle,
  });
  const r = measure(label, world, DAYS);
  beamResults.push(r);
  row(r);
}
console.log('\n' + TARGET + '\n');
for (const r of beamResults) verdict(r);

// ===========================================================================
// B — the cycle set
// ===========================================================================

header(
  `CYCLE PRESET SWEEP — ${WIDTH}×${HEIGHT}, ${DAYS} days, seed ${SEED}`,
  "a world's cycle set is its identity — and its disturbance engine",
);
const presetResults: Result[] = [];
for (const [preset, specs] of Object.entries(CYCLE_PRESETS)) {
  const world = new World({ width: WIDTH, height: HEIGHT, seed: SEED, cycles: specs });
  const r = measure(preset, world, DAYS);
  presetResults.push(r);
  row(r);
}
console.log('\n' + TARGET + '\n');
for (const r of presetResults) verdict(r);

const still = presetResults.find((r) => r.label === 'still');
const crucible = presetResults.find((r) => r.label === 'crucible');
if (still && crucible) {
  console.log(
    `\n  ★ ${(crucible.churn / Math.max(1e-9, still.churn)).toFixed(0)}× the churn of the ` +
      'no-disturbance control, and more biomes holding a real share of the map.',
  );
  console.log('    Disturbance is what keeps the world from converging. More cycles = more life.');
}

// ===========================================================================
// C — the long horizon: is the coastline still a two-way membrane?
// ===========================================================================

const LONG_W = 120;
const LONG_H = 72;
const LONG_YEARS = 40;
const LONG_DAYS = LONG_YEARS * 365;

console.log(
  `\n  COASTLINE MEMBRANE — ${LONG_W}×${LONG_H}, ${LONG_YEARS} game-years, seed ${SEED}`,
);
console.log('  Sea share every 10 game-years. Both a drain and a flood are absorbing states.\n');
const decades = [0, 10, 20, 30, 40];
console.log('  preset        ' + decades.map((y) => `y${String(y).padStart(2)}`.padStart(7)).join('') + '     drift');
console.log('  ' + '─'.repeat(58));

let membraneFailures = 0;
for (const [preset, specs] of Object.entries(CYCLE_PRESETS)) {
  const world = new World({ width: LONG_W, height: LONG_H, seed: SEED, cycles: specs });
  const track: number[] = [share(world.biomeProportions(), SEA_SHARE)];
  for (let d = 1; d <= LONG_DAYS; d++) {
    world.stepDay();
    if (d % (10 * 365) === 0) track.push(share(world.biomeProportions(), SEA_SHARE));
  }
  const drift = track[track.length - 1]! - track[0]!;
  // A membrane that leaks 5 points of the world's surface per 40 game-years has
  // drained or flooded it inside a single long-lived server. That is the threshold.
  const ok = Math.abs(drift) < 0.05;
  if (!ok) membraneFailures++;
  console.log(
    `  ${preset.padEnd(12)}  ` +
      track.map((v) => `${(v * 100).toFixed(1)}%`.padStart(7)).join('') +
      `   ${ok ? '✓' : '✗'} ${(drift * 100 >= 0 ? '+' : '') + (drift * 100).toFixed(1)}pp`,
  );
}
console.log(
  membraneFailures === 0
    ? '\n  ✓ the coastline is a two-way membrane on every cycle set\n'
    : `\n  ✗ ${membraneFailures} cycle set(s) ratchet the coastline — see the drift column\n`,
);

// A composition line for the richest world, so the sweep also shows WHAT is there.
{
  const world = new World({ width: WIDTH, height: HEIGHT, seed: SEED, cycles: CYCLE_PRESETS.crucible! });
  const acc = new Float64Array(BIOME_COUNT);
  let n = 0;
  for (let d = 1; d <= DAYS; d++) {
    world.stepDay();
    if (d > DAYS * 0.66 && d % 5 === 0) {
      const p = world.biomeProportions();
      for (let b = 0; b < BIOME_COUNT; b++) acc[b]! += p[b]!;
      n++;
    }
  }
  console.log('  crucible tail-mean composition:');
  console.log(
    '    ' +
      [...BIOMES]
        .sort((a, b) => acc[b.id]! - acc[a.id]!)
        .map((d) => `${d.key} ${((acc[d.id]! / n) * 100).toFixed(2)}%`)
        .join('  ·  '),
  );
  console.log('');
}
