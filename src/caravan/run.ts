/**
 * Headless caravan harness.
 *
 *   npm run caravan -- --world
 *   npm run caravan -- --deploy --skirmish
 *   npm run caravan -- --equip scrap_vest
 *   npm run caravan -- --starve-at 201 --salvage
 */

import { resolveActivity, startSurvey, SURVEY_NOTES } from './activity.ts';
import { skirmish } from './bridge.ts';
import { spawnFromCatalog } from './catalog.ts';
import { autoDeployFront } from './deploy.ts';
import { salvage } from './derelict.ts';
import { equip, GearSlot } from './gear.ts';
import { feed, RATIONS, starveAt, produceAt } from './food.ts';
import { deposit, LOOSE, transfer } from './inventory.ts';
import { commitLeg, formatTile, positionAt } from './legs.ts';
import { makeStartingCaravan } from './loadout.ts';
import { parsePath } from './path.ts';
import { biomeAt, makeRegion, pathMaxCost } from './region.ts';
import { formatCaravan, formatRefunds } from './report.ts';
import { fertilityOf, biomeDef } from './terrain.ts';
import { mobilise, settle } from './settle.ts';
import { assign } from './staff.ts';
import { OccupantKind, type Caravan, type Occupant } from './types.ts';

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

function parseDeposit(argv: string[]): { materialId: string; qty: number } | null {
  const i = argv.lastIndexOf('--deposit');
  if (i < 0 || !argv[i + 1]) return null;
  const raw = argv[i + 1]!;
  const colon = raw.lastIndexOf(':');
  if (colon < 0) return null;
  const materialId = raw.slice(0, colon);
  const qty = Number(raw.slice(colon + 1));
  if (!materialId || !Number.isFinite(qty) || qty <= 0) return null;
  return { materialId, qty: Math.floor(qty) };
}

function parseStarveAt(argv: string[]): number | null {
  const i = argv.lastIndexOf('--starve-at');
  if (i < 0 || !argv[i + 1]) return null;
  const n = Number(argv[i + 1]);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

function parseEquip(argv: string[]): string | null {
  const i = argv.lastIndexOf('--equip');
  if (i >= 0 && argv[i + 1]) return argv[i + 1]!;
  return null;
}

function firstFitted(caravan: Caravan, kind: string): Occupant | null {
  for (const v of caravan.vehicles) {
    for (const s of v.slots) {
      if (s.occupant?.kind === kind) return s.occupant;
    }
  }
  return null;
}

const argv = process.argv.slice(2);
const seed = parseSeed(argv);
const at = parseAt(argv);
const doSettle = argv.includes('--settle');
const doMobilise = argv.includes('--mobilise');
const doStaff = argv.includes('--staff');
const doFeed = argv.includes('--feed');
const doTransfer = argv.includes('--transfer');
const doSurvey = argv.includes('--survey');
const doDeploy = argv.includes('--deploy');
const doSkirmish = argv.includes('--skirmish');
const doSalvage = argv.includes('--salvage');
const depositSpec = parseDeposit(argv);
const starveStep = parseStarveAt(argv);
const pathArg = parsePathArg(argv);
const equipId = parseEquip(argv);

const region = makeRegion(seed);
const caravan = makeStartingCaravan(seed, region.spawn);
console.log(`seed=${seed}`);

const id = biomeAt(region, region.spawn);
const def = biomeDef(id);
console.log(
  `world ${region.width}×${region.height} spawn=${formatTile(region.spawn)} ` +
    `biome=${def?.key ?? id} fertility=${fertilityOf(id)}`,
);

if (pathArg) {
  const parsed = parsePath(pathArg);
  if ('error' in parsed) {
    console.error(`path failed: ${parsed.error}`);
    process.exit(1);
  }
  const cost = pathMaxCost(region, parsed);
  if (!cost.ok) {
    console.error(`path failed: ${cost.reason}`);
    process.exit(1);
  }
  const r = commitLeg(caravan, parsed, 0, {
    width: region.width,
    height: region.height,
    wrap: true,
    terrainCost: cost.maxCost,
  });
  if (!r.ok) {
    console.error(`commitLeg failed: ${r.reason}`);
    process.exit(1);
  }
  console.log(
    `committed leg #${r.leg.seq} tpt=${r.leg.ticksPerTile} cost×${cost.maxCost} ` +
      `${r.leg.tiles.map(formatTile).join('→')}`,
  );
}

if (doSettle) {
  const r = settle(caravan, at, region);
  if (!r.ok) {
    console.error(`settle failed: ${r.reason}`);
    process.exit(1);
  }
  console.log('settled → outpost');
}

if (doMobilise) {
  if (!doSettle) {
    const s = settle(caravan, at, region);
    if (!s.ok) {
      console.error(`settle failed: ${s.reason}`);
      process.exit(1);
    }
  }
  const r = mobilise(caravan, region, at);
  if (!r.ok) {
    console.error(`mobilise failed: ${r.reason}`);
    process.exit(1);
  }
  console.log(`mobilised → caravan  refund=${formatRefunds(r.refunds)}`);
}

if (doStaff) {
  const character = firstFitted(caravan, OccupantKind.character);
  const station = firstFitted(caravan, OccupantKind.station);
  if (!character || !station) {
    console.error('staff failed: need a fitted character and station');
    process.exit(1);
  }
  const r = assign(caravan, character.instanceId, station.instanceId);
  if (!r.ok) {
    console.error(`assign failed: ${r.reason}`);
    process.exit(1);
  }
  console.log(`assigned ${character.name} → ${station.name}`);
}

if (depositSpec) {
  const target = caravan.holds[0]?.stationInstanceId ?? LOOSE;
  const r = deposit(caravan, target, depositSpec.materialId, depositSpec.qty);
  if (!r.ok) {
    console.error(`deposit failed: ${r.reason}`);
    process.exit(1);
  }
  console.log(`deposited ${depositSpec.qty} ${depositSpec.materialId} → ${target}`);
}

if (doTransfer) {
  const holdId = caravan.holds[0]?.stationInstanceId;
  if (!holdId) {
    console.error('transfer failed: no cargo hold');
    process.exit(1);
  }
  const fromHold = caravan.holds[0]!.stacks.some(
    (s) => s.materialId === 'construction_scrap' && s.qty >= 10,
  );
  const from = fromHold ? holdId : LOOSE;
  const to = fromHold ? LOOSE : holdId;
  const r = transfer(caravan, from, to, 'construction_scrap', 10);
  if (!r.ok) {
    console.error(`transfer failed: ${r.reason}`);
    process.exit(1);
  }
  console.log(`transferred 10 construction_scrap ${from} → ${to}`);
}

if (equipId) {
  const character = firstFitted(caravan, OccupantKind.character);
  if (!character) {
    console.error('equip failed: no character');
    process.exit(1);
  }
  const slot =
    equipId === 'scrap_vest'
      ? GearSlot.armor
      : equipId === 'hand_axe'
        ? GearSlot.tool
        : GearSlot.gear;
  const r = equip(caravan, character.instanceId, slot, equipId);
  if (!r.ok) {
    console.error(`equip failed: ${r.reason}`);
    process.exit(1);
  }
  console.log(`equipped ${equipId} on ${character.name} (${slot})`);
}

if (doFeed) {
  const character = firstFitted(caravan, OccupantKind.character);
  if (!character) {
    console.error('feed failed: no character');
    process.exit(1);
  }
  const r = feed(caravan, character.instanceId, at, 1);
  if (!r.ok) {
    console.error(`feed failed: ${r.reason}`);
    process.exit(1);
  }
  console.log(
    `fed ${character.name} → satedUntil=${character.satedUntilStep} (spent 1 ${RATIONS})`,
  );
}

if (starveStep != null) {
  const pos = positionAt(caravan, starveStep);
  const fert = fertilityOf(biomeAt(region, pos.tile));
  const produced = produceAt(caravan, starveStep, fert);
  if (produced > 0) console.log(`produced ${produced} ${RATIONS} (fertility ${fert})`);
  const report = starveAt(caravan, starveStep);
  console.log(
    `starve @${starveStep}: removed ${report.starved.length}` +
      (report.starved.length
        ? ` (${report.starved.map((o) => o.name).join(', ')})`
        : '') +
      (report.collapsed ? '  outpost collapsed' : '') +
      (caravan.form === 'derelict' ? '  → derelict' : ''),
  );
}

if (doSalvage) {
  const char = spawnFromCatalog('wanderer', 'Salvor');
  const r = salvage(caravan, char);
  if (!r.ok) {
    console.error(`salvage failed: ${r.reason}`);
    process.exit(1);
  }
  console.log(`salvaged → caravan with ${char.name}`);
}

if (doSurvey) {
  const startStep = 0;
  const r = startSurvey(caravan, startStep);
  if (!r.ok) {
    console.error(`survey failed: ${r.reason}`);
    process.exit(1);
  }
  console.log(`survey started @${startStep} (100 ticks)`);
  const resolveStep = starveStep ?? at;
  const done = resolveActivity(caravan, resolveStep);
  if (done.completed) {
    console.log(
      `survey complete @${resolveStep} tile=${formatTile(done.tile!)} ` +
        `→ 1 ${SURVEY_NOTES}`,
    );
  } else {
    console.log(`survey in progress @${resolveStep} (need ≥${startStep + 100})`);
  }
}

if (doDeploy) {
  const r = autoDeployFront(caravan);
  if (!r.ok) {
    console.error(`deploy failed: ${r.reason}`);
    process.exit(1);
  }
  console.log(
    `deployed ${caravan.deploy.placements.length} on Side A front: ` +
      caravan.deploy.placements.map((p) => `${p.characterInstanceId}@${p.col},${p.row}`).join(' '),
  );
}

if (doSkirmish) {
  if (caravan.deploy.placements.length === 0) {
    const r = autoDeployFront(caravan);
    if (!r.ok) {
      console.error(`deploy failed: ${r.reason}`);
      process.exit(1);
    }
    console.log(`auto-deployed ${caravan.deploy.placements.length} for skirmish`);
  }
  const r = skirmish(caravan);
  if (!r.ok || !r.engagement) {
    console.error(`skirmish failed: ${'reason' in r ? r.reason : 'unknown'}`);
    process.exit(1);
  }
  const eng = r.engagement;
  console.log(
    `skirmish outcome=${eng.outcome} rounds=${eng.roundsPlayed} ` +
      `aliveA=${eng.rounds.at(-1)?.aliveA ?? '?'} aliveB=${eng.rounds.at(-1)?.aliveB ?? '?'}`,
  );
  for (const line of eng.summary.slice(0, 8)) console.log(`  ${line}`);
}

const pos = positionAt(caravan, starveStep ?? at);
console.log(
  `at=${starveStep ?? at} tile=${formatTile(pos.tile)} travelling=${pos.travelling} form=${caravan.form}`,
);
console.log(formatCaravan(caravan, starveStep ?? at));
