/**
 * Trace one disturbance cycle day by day to find where recovery stalls.
 *
 *   node src/sim/diagnose.ts                # the beam, 60d transit / 720d cycle
 *   node src/sim/diagnose.ts --cycles kiln  # any preset; traces one of its periods
 *
 * The sweep tells you WHETHER a configuration works. This tells you WHY: which biome
 * the scar gets stuck in, how long the moisture takes to come back, and whether the
 * living share is recovering or merely oscillating between two kinds of waste.
 */

import { Biome, BIOMES, BIOME_COUNT } from './biomes.ts';
import { CYCLE_PRESETS, flagNames } from './cycles.ts';
import { World } from './world.ts';

const presetIdx = process.argv.indexOf('--cycles');
const presetName = presetIdx === -1 ? null : process.argv[presetIdx + 1] ?? null;
if (presetName !== null && !(presetName in CYCLE_PRESETS)) {
  throw new Error(`Unknown preset "${presetName}". Known: ${Object.keys(CYCLE_PRESETS).join(', ')}`);
}

const PERIOD = 720;
const world = new World({
  width: 180, height: 108, seed: 20260729,
  ...(presetName === null
    ? { beam: true, beamTransitDays: 60, beamCycleDays: PERIOD }
    : { cycles: CYCLE_PRESETS[presetName]! }),
});

// Settle first, so we trace a representative cycle rather than the initial transient.
for (let d = 0; d < PERIOD; d++) world.stepDay();

const TRACKED: Biome[] = [
  Biome.Grassland, Biome.Forest, Biome.Marsh, Biome.Desert,
  Biome.Barren, Biome.Glass, Biome.Ash, Biome.Soil, Biome.Rock, Biome.Tundra,
];

console.log(
  `\n  ONE DISTURBANCE CYCLE — ${presetName ?? 'beam, 60d transit / 720d cycle'}\n`,
);
console.log(
  '   day  active  ' +
    TRACKED.map((b) => BIOMES[b]!.name.slice(0, 5).padStart(6)).join('') +
    '   avg moist   flags',
);
console.log('  ' + '─'.repeat(102));

for (let d = 0; d <= PERIOD; d++) {
  if (d % 20 === 0) {
    const p = world.biomeProportions();
    let moistSum = 0;
    let landTiles = 0;
    for (let i = 0; i < world.biome.length; i++) {
      const def = BIOMES[world.biome[i]! as Biome]!;
      if (!def.water || def.molten) {
        moistSum += world.moisture[i]!;
        landTiles++;
      }
    }
    // Sample the flags actually raised somewhere on the map today, so the trace shows
    // WHICH disturbance is driving each stage of the scar rather than just that one is.
    let flags = 0;
    for (let i = 0; i < world.biome.length; i += 37) flags |= world.inspect(i).flags;

    console.log(
      `  ${String(d).padStart(4)}  ${world.purgeActive ? ' ██  ' : '     '}  ` +
        TRACKED.map((b) => (p[b]! * 100).toFixed(1).padStart(6)).join('') +
        `   ${(moistSum / Math.max(1, landTiles)).toFixed(1).padStart(6)}    ` +
        (flagNames(flags).join(' ') || '—'),
    );
  }
  world.stepDay();
}

// Where did everything end up? A scar that has stalled shows as a biome that never
// comes back down.
const p = world.biomeProportions();
console.log('\n  final composition:');
console.log(
  '    ' +
    [...BIOMES]
      .sort((a, b) => p[b.id]! - p[a.id]!)
      .filter((d) => p[d.id]! > 0.0005)
      .map((d) => `${d.key} ${(p[d.id]! * 100).toFixed(2)}%`)
      .join('  ·  '),
);
console.log(`    ${BIOME_COUNT - BIOMES.filter((d) => p[d.id]! > 0.0005).length} biomes below 0.05%\n`);
