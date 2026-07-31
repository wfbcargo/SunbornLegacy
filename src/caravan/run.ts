/**
 * Headless caravan harness — prints the starting loadout.
 *
 *   npm run caravan
 *   npm run caravan -- --seed demo
 *   npm run caravan -- --settle
 *   npm run caravan -- --path 0,0:1,0:2,0 --at 12
 */

import { commitLeg, formatTile, positionAt } from './legs.ts';
import { makeStartingCaravan } from './loadout.ts';
import { parsePath } from './path.ts';
import { formatCaravan, formatRefunds } from './report.ts';
import { mobilise, settle } from './settle.ts';

function parseSeed(argv: string[]): string {
  const i = argv.lastIndexOf('--seed');
  if (i >= 0 && argv[i + 1]) return argv[i + 1]!;
  return 'start';
}

function parseAt(argv: string[]): number {
  const i = argv.lastIndexOf('--at');
  if (i >= 0 && argv[i + 1]) {
    const n = Number(argv[i + 1]);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  return 0;
}

function parsePathArg(argv: string[]): string | null {
  const i = argv.lastIndexOf('--path');
  if (i >= 0 && argv[i + 1]) return argv[i + 1]!;
  return null;
}

const argv = process.argv.slice(2);
const seed = parseSeed(argv);
const at = parseAt(argv);
const doSettle = argv.includes('--settle');
const doMobilise = argv.includes('--mobilise');
const pathArg = parsePathArg(argv);

const caravan = makeStartingCaravan(seed);
console.log(`seed=${seed}`);

if (pathArg) {
  const parsed = parsePath(pathArg);
  if ('error' in parsed) {
    console.error(`path failed: ${parsed.error}`);
    process.exit(1);
  }
  const r = commitLeg(caravan, parsed, 0);
  if (!r.ok) {
    console.error(`commitLeg failed: ${r.reason}`);
    process.exit(1);
  }
  console.log(
    `committed leg #${r.leg.seq} tpt=${r.leg.ticksPerTile} ` +
      `${r.leg.tiles.map(formatTile).join('→')}`,
  );
}

if (doSettle) {
  const r = settle(caravan, at);
  if (!r.ok) {
    console.error(`settle failed: ${r.reason}`);
    process.exit(1);
  }
  console.log('settled → outpost');
}

if (doMobilise) {
  if (!doSettle) {
    const s = settle(caravan, at);
    if (!s.ok) {
      console.error(`settle failed: ${s.reason}`);
      process.exit(1);
    }
  }
  const r = mobilise(caravan);
  if (!r.ok) {
    console.error(`mobilise failed: ${r.reason}`);
    process.exit(1);
  }
  console.log(`mobilised → caravan  refund=${formatRefunds(r.refunds)}`);
}

const pos = positionAt(caravan, at);
console.log(`at=${at} tile=${formatTile(pos.tile)} travelling=${pos.travelling}`);
console.log(formatCaravan(caravan, at));
