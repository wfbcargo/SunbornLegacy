/**
 * Golden-world regression test.
 *
 *   node src/sim/golden.ts              # check against the checked-in hashes
 *   node src/sim/golden.ts --update     # print fresh hashes to paste in
 *
 * WHAT THIS IS FOR
 * ----------------
 * `invariants.ts` proves things about the ruleset as a GRAPH: that it is one strongly
 * connected component, that no rule is dead, that nothing latches. All of that can hold
 * perfectly while the simulation quietly produces a different world than it did
 * yesterday — a changed constant, a reordered array, a rule renamed, a refactor that
 * looked equivalent and was not. Those are the changes that invalidate every recorded
 * number in SIMULATION.md, and none of them announce themselves.
 *
 * So this file asks the one question the graph checks cannot: **is the world still bit
 * for bit the world we measured?** Fixed seed, fixed size, fixed preset, fixed day
 * count, hash the biome array, compare. It is deliberately dumb. A golden test that
 * tried to be clever about which differences matter would be back to trusting a
 * judgement call, and the entire point is not to have to.
 *
 * A FAILURE HERE IS NOT NECESSARILY A BUG. It means the world changed. If you changed
 * the ruleset on purpose, the correct response is `--update`, a re-run of `npm run sim`,
 * and updating the numbers in SIMULATION.md and README.md in the same commit — because
 * those numbers now describe a world that no longer exists. What must never happen is
 * updating the hash without re-measuring; that converts this file from a tripwire into
 * a rubber stamp.
 *
 * TWO CASES, CHOSEN SO A FAILURE LOCALISES
 * ----------------------------------------
 * `still` has no cycles at all, so it exercises worldgen, the hydrology and the
 * climate-gated rules and nothing else. `crucible` runs all five cycles. If both drift,
 * suspect worldgen or the hydrology; if only `crucible` does, suspect the cycles or the
 * cycle-gated rules. One hash tells you something broke; two tell you roughly where.
 *
 * ★ SCOPE OF THE GUARANTEE. This pins the simulation against ITSELF on a given
 * JavaScript engine — it is a regression test, not a cross-platform conformance test.
 * `Math.cos` and `Math.pow` are used by the latitude band, the noise and
 * `medianToProbability`, and ECMA-262 explicitly does not require them to be correctly
 * rounded, so a different engine (or a sufficiently different version of this one) may
 * legitimately produce a different hash without anything being wrong. Everything else
 * here is exactly specified: integer ops, Float32Array/Float64Array arithmetic, and the
 * evaluation order of the sweep. If this ever needs to hold across engines, the fix is
 * to replace those two calls with polynomial approximations of our own, not to loosen
 * the test.
 */

import { World } from './world.ts';
import { CYCLE_PRESETS } from './cycles.ts';

interface GoldenCase {
  readonly name: string;
  readonly preset: string;
  readonly width: number;
  readonly height: number;
  readonly seed: number;
  readonly days: number;
  /** Expected `worldHash` of `world.biome`. Regenerate with `--update`. */
  readonly hash: string;
}

/**
 * The pinned worlds.
 *
 * Sized for a test that people will actually run: both cases together take a couple of
 * seconds, against ~10-30s for `npm run sim`. 500 days is not arbitrary — it clears the
 * `crucible` beam's full 420-day cycle plus a transit, a full 360-day year of seasons
 * and monsoon, and several 64-day tectonic/volcanic epochs, so every cycle in the set
 * has both fired and gone dormant at least once before the hash is taken. A shorter run
 * would leave whole cycles unexercised and pin a world that had not happened yet.
 */
const CASES: readonly GoldenCase[] = [
  {
    name: 'still',
    preset: 'still',
    width: 160,
    height: 96,
    seed: 20260729,
    days: 500,
    hash: 'ea1caa9f367a0453',
  },
  {
    name: 'crucible',
    preset: 'crucible',
    width: 160,
    height: 96,
    seed: 20260729,
    days: 500,
    hash: 'f4bece63b740b9e2',
  },
];

/**
 * 64-bit fingerprint of the biome array, as 16 hex characters.
 *
 * Two independent 32-bit lanes rather than one. A single 32-bit hash is a ~1-in-4-billion
 * chance of missing any given drift, which sounds like plenty until you remember this
 * file's whole job is to be believed when it says nothing changed. The second lane also
 * mixes the INDEX, so it is sensitive to a pure permutation of the array — a bug that
 * moved tiles around without changing the biome histogram would slip past lane A's
 * accumulator far more easily than past both.
 *
 * Length is folded in at the end so a truncated array cannot collide with a full one.
 */
export function worldHash(biome: Uint8Array): string {
  let a = 0x811c9dc5;
  let b = 0x9dc5811c;
  for (let i = 0; i < biome.length; i++) {
    const v = biome[i]!;
    a = Math.imul(a ^ v, 0x01000193);
    b = Math.imul(b ^ (v + i), 0x85ebca6b);
    b ^= b >>> 13;
  }
  a = Math.imul(a ^ biome.length, 0x01000193);
  b = Math.imul(b ^ biome.length, 0x85ebca6b);
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, '0');
  return hex(a) + hex(b);
}

/** Build one case's world from scratch and fingerprint it. */
function runCase(c: GoldenCase): string {
  const cycles = CYCLE_PRESETS[c.preset];
  if (cycles === undefined) throw new Error(`Unknown cycle preset "${c.preset}"`);
  const world = new World({ width: c.width, height: c.height, seed: c.seed, cycles });
  for (let d = 0; d < c.days; d++) world.stepDay();
  return worldHash(world.biome);
}

// ---------------------------------------------------------------------------

const COLOUR = process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb';
const bold = (s: string) => (COLOUR ? `\x1b[1m${s}\x1b[0m` : s);
const dim = (s: string) => (COLOUR ? `\x1b[2m${s}\x1b[0m` : s);
const red = (s: string) => (COLOUR ? `\x1b[31m${s}\x1b[0m` : s);
const green = (s: string) => (COLOUR ? `\x1b[32m${s}\x1b[0m` : s);

const update = process.argv.includes('--update');

console.log(bold('\n  GOLDEN WORLD HASHES\n'));
if (update) {
  console.log(dim('  --update: regenerating. Paste these into CASES, then RE-RUN `npm run sim`'));
  console.log(dim('  and update SIMULATION.md / README.md — the old numbers are now stale.\n'));
}

const failures: string[] = [];

for (const c of CASES) {
  const label = `${c.name} ${c.width}×${c.height} seed ${c.seed} ${c.days}d`;
  const actual = runCase(c);

  // Determinism (R-004) is checked here rather than assumed, because this is the one
  // place in the codebase that already has two identically-configured worlds in reach.
  // A second build from the same seed must agree bit for bit; if it does not, the drift
  // check below is meaningless — a hash that moves on its own cannot certify anything.
  const repeat = runCase(c);
  if (repeat !== actual) {
    failures.push(
      `${c.name}: NOT DETERMINISTIC — two runs of an identical config disagree ` +
        `(${actual} vs ${repeat}). Something in the stepping path reads a clock, ` +
        'Math.random(), or an unordered structure.',
    );
    console.log(`  ${red('✗')} ${label}\n      ${red('non-deterministic')}  ${actual} ≠ ${repeat}`);
    continue;
  }

  if (update) {
    console.log(`  ${label}\n      hash: '${actual}',`);
    continue;
  }

  if (c.hash === '') {
    failures.push(`${c.name}: no expected hash recorded. Run \`npm run sim:golden -- --update\`.`);
    console.log(`  ${red('✗')} ${label}\n      ${red('no expected hash recorded')}  actual ${actual}`);
  } else if (c.hash === actual) {
    console.log(`  ${green('✓')} ${label}\n      ${dim(`${actual}  (deterministic across two builds)`)}`);
  } else {
    failures.push(`${c.name}: expected ${c.hash}, got ${actual}`);
    console.log(
      `  ${red('✗')} ${label}\n` +
        `      expected  ${c.hash}\n` +
        `      actual    ${red(actual)}`,
    );
  }
}

console.log('');
if (update) {
  console.log(dim('  Nothing was verified — --update only prints.\n'));
  process.exit(0);
}
if (failures.length === 0) {
  console.log(`  ${green(`✓ ${CASES.length} golden worlds unchanged`)}\n`);
  process.exit(0);
}
for (const f of failures) console.log(`  ${red('✗')} ${f}`);
console.log(
  '\n  ' +
    red(`${failures.length} golden world(s) drifted`) +
    dim(
      '\n  If this was intentional: `npm run sim:golden -- --update`, paste the hashes,' +
        '\n  then RE-RUN `npm run sim` and update SIMULATION.md and README.md in the same' +
        '\n  commit. Those numbers describe a world that no longer exists.\n',
    ),
);
process.exit(1);
