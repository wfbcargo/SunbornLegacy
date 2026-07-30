/**
 * Headless terrain simulator.
 *
 * Answers the question the whole design rests on: does a stochastic terrain CA with
 * a solar sweep produce a world that stays varied and alive over years of game time,
 * or does it converge on a featureless absorbing state?
 *
 *   node src/sim/run.ts                                   # crucible, the full cycle set
 *   node src/sim/run.ts --days 3000 --cycles garden
 *   node src/sim/run.ts --days 2000 --cycles still        # the frozen control
 *   node src/sim/run.ts --width 400 --height 240 --seed 7 --beam --beam-transit 30
 */

import { World, TICKS_PER_DAY } from './world.ts';
import { BIOME_COUNT } from './biomes.ts';
import { CYCLE_PRESETS } from './cycles.ts';
import {
  ALIVE_ENTROPY, ALIVE_MAX_DOMINANCE, ALIVE_MIN_BIOMES, ALIVE_MIN_CHURN,
  assessStability, bold, dim, legend, NicheSampler, renderComposition,
  renderHistory, renderMap, renderNiches, sample, type Sample,
} from './report.ts';

// `lastIndexOf`, not `indexOf`: the LAST occurrence of a repeated flag wins, which is what
// every other CLI does and what a person editing the end of a long command line means.
// With `indexOf`, `--days 300 --days 500` silently ran 300 — the same class of quiet
// wrongness as an npm-swallowed flag, and in this repo that one has already invalidated
// recorded evidence once.
function arg(name: string, fallback: number): number {
  const i = process.argv.lastIndexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const width = arg('width', 240);
const height = arg('height', 144);
const days = arg('days', 1200);
const seed = arg('seed', 20260729);
const beam = flag('beam');
// Severity and recovery are SEPARATE knobs. See SIMULATION.md: collapsing them into a
// single "period" makes a longer period mean a slower beam, so each tile bakes longer
// and the world sterilises. At a single-knob 900-day period, water reached 0%.
const beamTransitDays = arg('beam-transit', 60);
const beamCycleDays = arg('beam-cycle', 360);

// A world's cycle set is its identity and its difficulty. `--cycles crucible` runs
// beam + seasons + monsoon + tectonics + volcanism together, and is the default:
// the whole finding this file exists to demonstrate is that MORE cycles produce a
// MORE alive world, so the representative world is the one with all of them. Use
// `--cycles still` for the no-disturbance control, or `--beam` for the legacy
// single-beam configuration the original SIMULATION.md numbers were taken with.
const presetIdx = process.argv.lastIndexOf('--cycles');
const presetName =
  presetIdx !== -1 ? process.argv[presetIdx + 1] ?? null : beam ? null : 'crucible';
if (presetName !== null && !(presetName in CYCLE_PRESETS)) {
  throw new Error(`Unknown cycle preset "${presetName}". Known: ${Object.keys(CYCLE_PRESETS).join(', ')}`);
}
const cycles = presetName === null ? undefined : CYCLE_PRESETS[presetName]!;

const rule = (label: string) => '\n' + bold(`── ${label} `) + dim('─'.repeat(Math.max(0, 76 - label.length)));

console.log(bold('\n  SUNBORN LEGACY — terrain simulation\n'));
console.log(
  dim(
    `  ${width}×${height} torus (${(width * height).toLocaleString()} tiles)  ·  ` +
      `${days} days  ·  seed ${seed}  ·  ` +
        (presetName !== null
          ? `cycles: ${presetName}`
          : `beam ${beam ? `on, ${beamTransitDays}d transit / ${beamCycleDays}d cycle` : 'off'}`),
  ),
);
console.log(
  dim(
    `  1 day = 1 solar revolution = ${TICKS_PER_DAY.toLocaleString()} ticks  ·  ` +
      `simulating ${(days / 365).toFixed(1)} game-years`,
  ),
);

const t0 = performance.now();
const world = new World({ width, height, seed, beam, beamTransitDays, beamCycleDays, cycles });

console.log(rule('day 0 — after worldgen'));
console.log(renderMap(world));
console.log('\n' + renderComposition(world));

const samples: Sample[] = [sample(world)];
const sampleEvery = Math.max(1, Math.floor(days / 200));

// Both tests are measured across the TAIL, never on the final frame. A purged world
// oscillates, so an end-of-run snapshot lands at an arbitrary phase of the cycle and
// reports it as the steady state — the measurement bug SIMULATION.md recorded, and it
// bites the niche test at least as hard as the stability one.
const niching = new NicheSampler();
const tailFrom = Math.floor(days * 0.66);

for (let d = 1; d <= days; d++) {
  world.stepDay();
  if (d % sampleEvery === 0 || d === days) samples.push(sample(world));
  if (d > tailFrom && d % sampleEvery === 0) niching.add(world);
}

const elapsed = performance.now() - t0;

console.log(rule(`day ${days} — after ${(days / 365).toFixed(1)} game-years`));
console.log(renderMap(world));
console.log('\n' + renderComposition(world));

console.log(rule('composition over time'));
console.log(renderHistory(samples));
console.log('\n  ' + legend());

console.log(rule('test 1 — is the world still alive?'));
const stability = assessStability(samples);
console.log(
  `  entropy          ${stability.startEntropy.toFixed(3)} → ${stability.endEntropy.toFixed(3)}` +
    `   ${dim(`(tail mean, min ${stability.minEntropy.toFixed(3)}; needs ≥ ${ALIVE_ENTROPY})`)}`,
);
console.log(
  `  largest biome    ${stability.dominantBiome} at ${(stability.dominance * 100).toFixed(1)}%` +
    dim(`   (needs ≤ ${(ALIVE_MAX_DOMINANCE * 100).toFixed(0)}%)`),
);
console.log(
  `  late churn       ${(stability.lateChurn * 100).toFixed(2)}% of the map changing per sample` +
    dim(`   (needs ≥ ${(ALIVE_MIN_CHURN * 100).toFixed(2)}%)`),
);
console.log(
  `  biomes > 1%      ${stability.liveBiomes}` + dim(`   (needs ≥ ${ALIVE_MIN_BIOMES} of ${BIOME_COUNT})`),
);
console.log('');
for (const n of stability.notes) console.log(`  ${stability.alive ? '✓' : '✗'} ${n}`);

console.log(rule('test 2 — is every start a niche?'));
const niches = niching.assess();
console.log(
  dim(`  averaged over ${niching.sampleCount} samples across the final third of the run`),
);
console.log(renderNiches(niches));
console.log('');
console.log(`  ${niches.passes ? '✓' : '✗'} ${niches.passes
  ? 'Every region has a scarce export and enough materials to build with.'
  : `${niches.generic.length} generic and ${niches.thin.length} thin regions — some spawns would have no trade identity.`}`);

console.log(rule('performance'));
const evals = days * width * height;
console.log(`  ${evals.toLocaleString()} tile evaluations in ${(elapsed / 1000).toFixed(2)}s`);
console.log(`  ${Math.round(evals / (elapsed / 1000)).toLocaleString()} tile-evals/sec`);
console.log(
  dim(
    `  a live world of this size needs ${((width * height) / (TICKS_PER_DAY * 6)).toFixed(1)} evals/sec — ` +
      `${Math.round(evals / (elapsed / 1000) / ((width * height) / (TICKS_PER_DAY * 6))).toLocaleString()}× headroom`,
  ),
);
console.log('');
