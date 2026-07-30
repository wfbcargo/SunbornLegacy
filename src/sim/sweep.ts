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

import {
  BIOMES, Biome, BIOME_COUNT, SEA, RULES, RULE_FIRINGS,
  enableFluxLedger, resetFluxLedger,
} from './biomes.ts';
import { CYCLE_PRESETS } from './cycles.ts';
import { World } from './world.ts';

// Section C reports a per-rule flux ledger alongside the stock, so the getters have to
// be in place before any world is built. See `enableFluxLedger` in biomes.ts: it is a
// counting getter on `Rule.to`, which world.ts reads only on a winning roll, so it
// costs one property read on the ~0.1% of tile-visits that actually transition and
// cannot perturb the dice. Both golden hashes are unchanged with it enabled.
enableFluxLedger();

const WIDTH = 180;
const HEIGHT = 108;
const DAYS = 1200;
const SEED = 20260729;

/** Days between tail samples. Also the interval churn is reported per — see `measure`. */
const SAMPLE_DAYS = 5;
/** Fraction of the run skipped before sampling starts, matching report.ts's tail. */
const TAIL_FROM = 0.66;

/** Biomes that can sustain settlement and agriculture. */
const LIVING: Biome[] = [
  Biome.Marsh, Biome.Swamp, Biome.Grassland, Biome.Savanna,
  Biome.Forest, Biome.Rainforest, Biome.Bloom, Biome.Soil,
];
/** Biomes left behind by a purge or an eruption. */
const WASTE: Biome[] = [Biome.Glass, Biome.Barren, Biome.Desert, Biome.Ash, Biome.Lava];
/**
 * Everything that counts as sea for the coastline membrane. Lava is NOT sea.
 *
 * ★ DERIVED, NOT HAND-ENUMERATED. This used to be `[Ocean, Shallows, FrozenSea]`
 * written out here, which is precisely the "trap factory" `biomes.ts` refuses to build
 * for its own biome sets: the one instrument in the repo that exists to catch a
 * one-way coastline would have silently ignored any water-ish biome added after it was
 * written, and reported a flat sea while the sea drained into the biome it could not
 * see. `SEA` is `water && !molten`, so a new biome joins this measurement the moment it
 * joins BIOMES.
 */
const SEA_SHARE: readonly Biome[] = SEA;

const share = (p: Float64Array, list: readonly Biome[]) =>
  list.reduce<number>((sum, b) => sum + p[b]!, 0);

/** Sea membership as a lookup, for classifying a rule's two endpoints. */
const IS_SEA: boolean[] = Array.from({ length: BIOME_COUNT }, (_, b) => SEA.includes(b as Biome));
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
  // ★ CHURN IS A RATE, SO IT IS DIVIDED BY THE INTERVAL IT ACTUALLY MEASURED.
  //
  // This used to seed `prev` with the day-0 composition and then average every delta as
  // though each spanned one sampling interval. The first tail sample does not: at 1200
  // days it lands on day 795 and its delta covers 795 days of worldgen transient, not 5.
  // Averaged in as one 5-day sample among 82, that single term reported the `still`
  // control at 0.572%/sample against a true 0.047% — a 12× overstatement, enough to lift
  // it over this file's own `churn > 0.15%` liveness gate. A control that must fail was
  // passing because of the instrument, which is exactly what R-005 exists to prevent.
  //
  // Two things keep that from recurring, and both are needed:
  //   1. `prevDay` makes the divisor EXPLICIT. The old code coupled the divisor to the
  //      sampling cadence implicitly — correct only while every gap happened to be
  //      `SAMPLE_DAYS` — so any change to the cadence or the tail boundary would have
  //      silently re-inflated the column. Now the interval is measured, not assumed.
  //   2. The first tail snapshot is a BASELINE, not a sample. It has no predecessor
  //      inside the tail, and a rate averaged over the transient is not a late-run rate
  //      however honestly it is divided. This is what report.ts's `assessStability` does
  //      (its tail loop starts at `i = 1`), and that instrument was never wrong.
  let prev: Float64Array | undefined;
  let prevDay = 0;
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
    if (d > days * TAIL_FROM && d % SAMPLE_DAYS === 0) {
      const now = world.biomeProportions();
      if (prev) {
        let delta = 0;
        for (let b = 0; b < BIOME_COUNT; b++) delta += Math.abs(now[b]! - prev[b]!);
        // Half the total absolute change is the share of the map that moved. Divided by
        // the days actually elapsed since `prev`, then restated per SAMPLE_DAYS so the
        // column stays comparable with report.ts's per-sample churn and its threshold.
        churnTotal += ((delta / 2) / (d - prevDay)) * SAMPLE_DAYS;
        churnSamples++;
      }
      prev = now;
      prevDay = d;

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
console.log(
  '  preset        ' + decades.map((y) => `y${String(y).padStart(2)}`.padStart(7)).join('') +
    '     drift    late pp/y   → y200',
);
console.log('  ' + '─'.repeat(82));

/** Land→sea and sea→land firings, in pp of world per game-year, plus the per-rule split. */
interface Flux {
  landToSea: number;
  seaToLand: number;
  rows: { label: string; fires: number; pp: number; toSea: boolean }[];
}

function readLedger(tiles: number, gameYears: number): Flux {
  const flux: Flux = { landToSea: 0, seaToLand: 0, rows: [] };
  for (let i = 0; i < RULES.length; i++) {
    const fires = RULE_FIRINGS[i]!;
    if (fires === 0) continue;
    const rule = RULES[i]!;
    // ★ `rule.from` and `rule.to` — reading `to` here increments the counter it is
    // classifying, which is harmless because the ledger is only read after the run.
    const fromSea = IS_SEA[rule.from]!;
    const toSea = IS_SEA[rule.to]!;
    if (fromSea === toSea) continue;
    const pp = ((fires / tiles) * 100) / gameYears;
    if (toSea) flux.landToSea += pp;
    else flux.seaToLand += pp;
    flux.rows.push({ label: `${BIOMES[rule.from]!.key}→${BIOMES[rule.to]!.key}  ${rule.label}`, fires, pp, toSea });
  }
  flux.rows.sort((a, b) => b.pp - a.pp);
  return flux;
}

let membraneFailures = 0;
const fluxes: [string, Flux][] = [];
for (const [preset, specs] of Object.entries(CYCLE_PRESETS)) {
  const world = new World({ width: LONG_W, height: LONG_H, seed: SEED, cycles: specs });
  resetFluxLedger();
  const track: number[] = [share(world.biomeProportions(), SEA_SHARE)];
  for (let d = 1; d <= LONG_DAYS; d++) {
    world.stepDay();
    if (d % (10 * 365) === 0) track.push(share(world.biomeProportions(), SEA_SHARE));
  }
  fluxes.push([preset, readLedger(LONG_W * LONG_H, LONG_YEARS)]);
  const drift = track[track.length - 1]! - track[0]!;
  // A membrane that leaks 5 points of the world's surface per 40 game-years has
  // drained or flooded it inside a single long-lived server. That is the threshold.
  const ok = Math.abs(drift) < 0.05;
  if (!ok) membraneFailures++;
  // ★ DRIFT ALONE CANNOT TELL "converged" FROM "draining forever". Most of the drift
  // above is the worldgen transient, which is spent inside the first decade and is not
  // a ratchet. What matters for a server that runs for centuries is the rate AFTER the
  // transient — so the last two decades are reported separately and extrapolated. A
  // world drifting 0.12 pp/y passes the ±5 pp test at y40 and is dry at y200.
  const late = ((track[4]! - track[2]!) / 20) * 100;
  const proj = track[4]! * 100 + late * 160;
  console.log(
    `  ${preset.padEnd(12)}  ` +
      track.map((v) => `${(v * 100).toFixed(1)}%`.padStart(7)).join('') +
      `   ${ok ? '✓' : '✗'} ${((drift * 100 >= 0 ? '+' : '') + (drift * 100).toFixed(1) + 'pp').padStart(7)}` +
      `${((late >= 0 ? '+' : '') + late.toFixed(3)).padStart(11)}` +
      `${(proj <= 0 || proj >= 100 ? '⚠ ' : '  ') + `${proj.toFixed(0)}%`.padStart(6)}`,
  );
}
console.log(
  membraneFailures === 0
    ? '\n  ✓ the coastline is a two-way membrane on every cycle set'
    : `\n  ✗ ${membraneFailures} cycle set(s) ratchet the coastline — see the drift column`,
);
console.log(
  '  "late pp/y" is the y20→y40 rate, with the worldgen transient excluded; "→ y200"\n' +
    '  extrapolates it. A drain that is slow enough to pass the ±5 pp drift test still\n' +
    '  empties the world, so the rate is reported next to the stock, not instead of it.',
);

// ---------------------------------------------------------------------------
// C2 — the same 40 game-years, read as GROSS FLUX rather than as a stock.
//
// The stock is blind by construction: two edges moving 5 pp/game-year in opposite
// directions net to zero and never move the number above. That is not hypothetical —
// this ruleset's whole coastline is a pair of large opposed flows whose NET is a few
// percent of either side, so "the sea share barely moved" is compatible with a rule
// that is doing an enormous amount of work, and with a rule that is doing none.
//
// This costs nothing extra: the counters were filled by the runs above.
// ---------------------------------------------------------------------------
console.log('\n  COASTLINE GROSS FLUX — same runs, per rule, pp of world per game-year\n');
for (const [preset, flux] of fluxes) {
  const net = flux.landToSea - flux.seaToLand;
  console.log(
    `  ${preset.padEnd(10)} land→sea ${flux.landToSea.toFixed(3).padStart(7)}   ` +
      `sea→land ${flux.seaToLand.toFixed(3).padStart(7)}   ` +
      `net ${((net >= 0 ? '+' : '') + net.toFixed(3)).padStart(7)}   ` +
      `(net is ${(Math.abs(net) / Math.max(1e-9, flux.landToSea + flux.seaToLand) * 100).toFixed(1)}% of gross)`,
  );
  for (const r of flux.rows) {
    console.log(
      `      ${r.toSea ? '→sea' : 'sea→'} ${r.label.padEnd(42)}` +
        `${String(r.fires).padStart(8)}  ${r.pp.toFixed(4).padStart(8)} pp/y`,
    );
  }
}
console.log('');

// A composition line for the richest world, so the sweep also shows WHAT is there.
{
  const world = new World({ width: WIDTH, height: HEIGHT, seed: SEED, cycles: CYCLE_PRESETS.crucible! });
  const acc = new Float64Array(BIOME_COUNT);
  let n = 0;
  for (let d = 1; d <= DAYS; d++) {
    world.stepDay();
    if (d > DAYS * TAIL_FROM && d % SAMPLE_DAYS === 0) {
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
