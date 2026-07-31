/**
 * Local caravan manager — outfit, settle/mobilise, travel, staffing, inventory,
 * tile survey.
 *
 *   npm run caravan:view
 *
 * Binds 127.0.0.1 only. Not a product surface.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  activityProgress,
  cancelActivity,
  resolveActivity,
  startSurvey,
} from './activity.ts';
import { assessSkirmish, skirmish } from './bridge.ts';
import { allCatalog, catalogById, spawnFromCatalog } from './catalog.ts';
import { chassisById } from './chassis.ts';
import {
  clearDeploy,
  clearPlacement,
  place,
} from './deploy.ts';
import { salvage } from './derelict.ts';
import { deriveStats } from './derive.ts';
import { canFit, fit, unfit } from './fit.ts';
import { advanceNeeds, feed } from './food.ts';
import { equip, unequip, GearSlot } from './gear.ts';
import {
  deposit,
  depositRefunds,
  LOOSE,
  transfer,
  withdraw,
  type HoldTarget,
} from './inventory.ts';
import { commitLeg, positionAt, stallAt } from './legs.ts';
import { emptyCaravan, makeStartingCaravan } from './loadout.ts';
import { neighboursOf } from './path.ts';
import {
  biomeAt,
  makeRegion,
  pathMaxCost,
  serializeMap,
  type Region,
} from './region.ts';
import { fertilityOf, biomeDef, passable } from './terrain.ts';
import { mobilise, settle } from './settle.ts';
import { assign, assignmentForStation, unassign } from './staff.ts';
import type { Caravan, Occupant, TileCoord } from './types.ts';

const PORT = (() => {
  const i = process.argv.lastIndexOf('--port');
  const v = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(v) ? v : 4175;
})();

const ROOT = join(import.meta.dirname, 'public');

const ALLOWED = new Set([
  '/index.html',
  '/caravan.css',
  '/caravan.js',
  '/',
]);

let region: Region = makeRegion('lab');
let session: Caravan = makeStartingCaravan('lab', region.spawn);
let clockStep = 0;
const bench: Occupant[] = [];

function gridOpts() {
  return { width: region.width, height: region.height, wrap: true as const };
}

function tileFertility(step: number): number {
  const pos = positionAt(session, step);
  return fertilityOf(biomeAt(region, pos.tile));
}

function pushBench(...occupants: Array<Occupant | null | undefined>): void {
  for (const o of occupants) {
    if (o) bench.push(o);
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(data);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function serializeOccupant(o: Occupant | null) {
  if (!o) return null;
  return {
    instanceId: o.instanceId,
    catalogId: o.catalogId,
    name: o.name,
    kind: o.kind,
    size: o.size ?? null,
    tier: o.tier ?? null,
    containerClass: o.containerClass ?? null,
    ticksPerTile: o.ticksPerTile ?? null,
    satedUntilStep: o.satedUntilStep ?? null,
    armor: o.armor ?? null,
    tool: o.tool ?? null,
    gear: o.gear ?? null,
  };
}

function serializeCaravan(c: Caravan, step: number) {
  const stats = deriveStats(c);
  const pos = positionAt(c, step);
  return {
    id: c.id,
    name: c.name,
    form: c.form,
    origin: c.origin,
    generation: c.generation,
    stats,
    position: pos,
    assignments: c.assignments.map((a) => ({ ...a })),
    holds: c.holds.map((h) => ({
      stationInstanceId: h.stationInstanceId,
      stacks: h.stacks.map((s) => ({ ...s })),
    })),
    loose: c.loose.map((s) => ({ ...s })),
    production: { ...c.production },
    activity: (() => {
      const prog = activityProgress(c, step);
      if (!prog.ok) return null;
      const p = prog.progress;
      return {
        kind: p.kind,
        tile: p.tile,
        startStep: p.startStep,
        durationTicks: p.durationTicks,
        elapsed: p.elapsed,
        remaining: p.remaining,
        fraction: p.fraction,
        done: p.done,
      };
    })(),
    deploy: {
      placements: c.deploy.placements.map((p) => ({ ...p })),
    },
    legs: c.legs.map((l) => ({
      seq: l.seq,
      tiles: l.tiles,
      ticksPerTile: l.ticksPerTile,
      startStep: l.startStep,
      state: l.state,
    })),
    vehicles: c.vehicles.map((v) => {
      const chassis = chassisById(v.chassisId);
      return {
        id: v.id,
        chassisId: v.chassisId,
        chassisName: chassis?.name ?? v.chassisId,
        slots: v.slots.map((s) => {
          const occ = s.occupant;
          const staffedBy =
            occ?.kind === 'station'
              ? (assignmentForStation(c, occ.instanceId)?.characterInstanceId ?? null)
              : null;
          return {
            index: s.def.index,
            kind: s.def.kind,
            size: s.def.size ?? null,
            tier: s.def.tier ?? null,
            containerClass: s.def.containerClass ?? null,
            label: s.def.label ?? `${s.def.kind}#${s.def.index}`,
            occupant: serializeOccupant(occ),
            staffedBy,
          };
        }),
      };
    }),
  };
}

function takeBench(instanceId: string): Occupant | undefined {
  const i = bench.findIndex((o) => o.instanceId === instanceId);
  if (i < 0) return undefined;
  return bench.splice(i, 1)[0];
}

function findFitted(instanceId: string): {
  vehicleId: string;
  slotIndex: number;
  occupant: Occupant;
} | null {
  for (const v of session.vehicles) {
    for (const s of v.slots) {
      if (s.occupant?.instanceId === instanceId) {
        return { vehicleId: v.id, slotIndex: s.def.index, occupant: s.occupant };
      }
    }
  }
  return null;
}

function statePayload(extra?: Record<string, unknown>) {
  const pos = positionAt(session, clockStep);
  const fert = fertilityOf(biomeAt(region, pos.tile));
  const def = biomeDef(biomeAt(region, pos.tile));
  return {
    step: clockStep,
    map: serializeMap(region),
    neighbours: neighboursOf(pos.tile, gridOpts()),
    tile: {
      fertility: fert,
      biome: def?.key ?? 'unknown',
      glyph: def?.glyph ?? '?',
      passable: def ? passable(def.id) : false,
    },
    caravan: serializeCaravan(session, clockStep),
    catalog: allCatalog().map((c) => ({ ...c })),
    bench: bench.map(serializeOccupant),
    ...extra,
  };
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (method === 'GET' && path === '/api/state') {
    json(res, 200, statePayload());
    return;
  }

  if (method === 'POST' && path === '/api/reset') {
    const body = JSON.parse((await readBody(req)) || '{}') as { seed?: string; empty?: boolean };
    bench.length = 0;
    clockStep = 0;
    region = makeRegion(body.seed ?? 'lab');
    session = body.empty
      ? emptyCaravan('basic_wagon', region.spawn)
      : makeStartingCaravan(body.seed ?? 'lab', region.spawn);
    json(res, 200, statePayload());
    return;
  }

  if (method === 'POST' && path === '/api/step') {
    const body = JSON.parse((await readBody(req)) || '{}') as { step?: number };
    if (body.step == null || !Number.isFinite(body.step) || body.step < 0) {
      json(res, 400, { error: 'step must be a non-negative number' });
      return;
    }
    clockStep = Math.floor(body.step);
    const fert = tileFertility(clockStep);
    const needs = advanceNeeds(session, clockStep, fert);
    const survey = resolveActivity(session, clockStep);
    json(res, 200, statePayload({
      produced: needs.produced,
      starved: needs.starve.starved.map((o) => o.instanceId),
      collapsed: needs.starve.collapsed,
      stalledForHunger: needs.stalledForHunger,
      surveyCompleted: survey.completed,
      surveyTile: survey.tile ?? null,
    }));
    return;
  }

  if (method === 'POST' && path === '/api/commit-leg') {
    const body = JSON.parse((await readBody(req)) || '{}') as {
      tiles?: TileCoord[];
      startStep?: number;
    };
    if (!Array.isArray(body.tiles)) {
      json(res, 400, { error: 'tiles array is required' });
      return;
    }
    const startStep = body.startStep ?? clockStep;
    const cost = pathMaxCost(region, body.tiles);
    if (!cost.ok) {
      json(res, 400, { error: cost.reason });
      return;
    }
    const r = commitLeg(session, body.tiles, startStep, {
      ...gridOpts(),
      terrainCost: cost.maxCost,
    });
    if (!r.ok) {
      json(res, 400, { error: r.reason });
      return;
    }
    json(res, 200, statePayload());
    return;
  }

  if (method === 'POST' && path === '/api/stall') {
    const body = JSON.parse((await readBody(req)) || '{}') as { step?: number };
    const step = body.step ?? clockStep;
    stallAt(session, step);
    json(res, 200, statePayload());
    return;
  }

  if (method === 'POST' && path === '/api/settle') {
    const body = JSON.parse((await readBody(req)) || '{}') as { step?: number };
    const r = settle(session, body.step ?? clockStep, region);
    if (!r.ok) {
      json(res, 400, { error: r.reason });
      return;
    }
    json(res, 200, statePayload());
    return;
  }

  if (method === 'POST' && path === '/api/mobilise') {
    const r = mobilise(session, region, clockStep);
    if (!r.ok) {
      json(res, 400, { error: r.reason });
      return;
    }
    depositRefunds(session,r.refunds);
    pushBench(r.strippedStation);
    json(res, 200, statePayload({ lastRefunds: r.refunds }));
    return;
  }

  if (method === 'POST' && path === '/api/spawn') {
    const body = JSON.parse((await readBody(req)) || '{}') as {
      catalogId?: string;
      name?: string;
    };
    if (!body.catalogId || !catalogById(body.catalogId)) {
      json(res, 400, { error: `unknown catalog id: ${body.catalogId ?? ''}` });
      return;
    }
    const occ = spawnFromCatalog(body.catalogId, body.name);
    bench.push(occ);
    json(res, 200, { occupant: serializeOccupant(occ), bench: bench.map(serializeOccupant) });
    return;
  }

  if (method === 'POST' && path === '/api/fit') {
    const body = JSON.parse((await readBody(req)) || '{}') as {
      vehicleId?: string;
      slotIndex?: number;
      instanceId?: string;
      catalogId?: string;
      name?: string;
    };
    const vehicleId = body.vehicleId ?? session.vehicles[0]?.id;
    if (vehicleId == null || body.slotIndex == null) {
      json(res, 400, { error: 'vehicleId and slotIndex are required' });
      return;
    }

    let occ: Occupant | undefined;
    if (body.instanceId) {
      occ = takeBench(body.instanceId);
      if (!occ) {
        const fitted = findFitted(body.instanceId);
        if (fitted) {
          const u = unfit(session, fitted.vehicleId, fitted.slotIndex);
          if (!u.ok) {
            json(res, 400, { error: u.reason });
            return;
          }
          occ = u.occupant;
          depositRefunds(session,u.refunds);
          pushBench(u.strippedStation);
        }
      }
      if (!occ) {
        json(res, 400, { error: `unknown instance: ${body.instanceId}` });
        return;
      }
    } else if (body.catalogId) {
      if (!catalogById(body.catalogId)) {
        json(res, 400, { error: `unknown catalog id: ${body.catalogId}` });
        return;
      }
      occ = spawnFromCatalog(body.catalogId, body.name);
    } else {
      json(res, 400, { error: 'instanceId or catalogId is required' });
      return;
    }

    const check = canFit(session, vehicleId, body.slotIndex, occ);
    if (!check.ok) {
      bench.push(occ);
      json(res, 400, { error: check.reason, ...statePayload() });
      return;
    }
    const r = fit(session, vehicleId, body.slotIndex, occ);
    if (!r.ok) {
      bench.push(occ);
      json(res, 400, { error: r.reason });
      return;
    }
    json(res, 200, statePayload());
    return;
  }

  if (method === 'POST' && path === '/api/unfit') {
    const body = JSON.parse((await readBody(req)) || '{}') as {
      vehicleId?: string;
      slotIndex?: number;
    };
    const vehicleId = body.vehicleId ?? session.vehicles[0]?.id;
    if (vehicleId == null || body.slotIndex == null) {
      json(res, 400, { error: 'vehicleId and slotIndex are required' });
      return;
    }
    const r = unfit(session, vehicleId, body.slotIndex);
    if (!r.ok) {
      json(res, 400, { error: r.reason });
      return;
    }
    pushBench(r.occupant, r.strippedStation);
    depositRefunds(session,r.refunds);
    json(res, 200, statePayload({
      collapsed: r.collapsed,
      lastRefunds: r.refunds,
    }));
    return;
  }

  if (method === 'POST' && path === '/api/assign') {
    const body = JSON.parse((await readBody(req)) || '{}') as {
      characterInstanceId?: string;
      stationInstanceId?: string;
    };
    if (!body.characterInstanceId || !body.stationInstanceId) {
      json(res, 400, { error: 'characterInstanceId and stationInstanceId are required' });
      return;
    }
    const r = assign(session, body.characterInstanceId, body.stationInstanceId);
    if (!r.ok) {
      json(res, 400, { error: r.reason });
      return;
    }
    json(res, 200, statePayload());
    return;
  }

  if (method === 'POST' && path === '/api/unassign') {
    const body = JSON.parse((await readBody(req)) || '{}') as {
      characterInstanceId?: string;
      stationInstanceId?: string;
    };
    const r = unassign(session, {
      characterInstanceId: body.characterInstanceId,
      stationInstanceId: body.stationInstanceId,
    });
    if (!r.ok) {
      json(res, 400, { error: r.reason });
      return;
    }
    json(res, 200, statePayload({ lastUnassign: r.assignment }));
    return;
  }

  if (method === 'POST' && path === '/api/deposit') {
    const body = JSON.parse((await readBody(req)) || '{}') as {
      target?: string;
      materialId?: string;
      qty?: number;
    };
    const target = parseHoldTarget(body.target);
    if (target == null || !body.materialId || body.qty == null) {
      json(res, 400, { error: 'target (loose|stationId), materialId, and qty are required' });
      return;
    }
    const r = deposit(session, target, body.materialId, body.qty);
    if (!r.ok) {
      json(res, 400, { error: r.reason });
      return;
    }
    json(res, 200, statePayload());
    return;
  }

  if (method === 'POST' && path === '/api/withdraw') {
    const body = JSON.parse((await readBody(req)) || '{}') as {
      source?: string;
      materialId?: string;
      qty?: number;
    };
    const source = parseHoldTarget(body.source);
    if (source == null || !body.materialId || body.qty == null) {
      json(res, 400, { error: 'source (loose|stationId), materialId, and qty are required' });
      return;
    }
    const r = withdraw(session, source, body.materialId, body.qty);
    if (!r.ok) {
      json(res, 400, { error: r.reason });
      return;
    }
    json(res, 200, statePayload());
    return;
  }

  if (method === 'POST' && path === '/api/transfer') {
    const body = JSON.parse((await readBody(req)) || '{}') as {
      from?: string;
      to?: string;
      materialId?: string;
      qty?: number;
    };
    const from = parseHoldTarget(body.from);
    const to = parseHoldTarget(body.to);
    if (from == null || to == null || !body.materialId || body.qty == null) {
      json(res, 400, { error: 'from, to, materialId, and qty are required' });
      return;
    }
    const r = transfer(session, from, to, body.materialId, body.qty);
    if (!r.ok) {
      json(res, 400, { error: r.reason });
      return;
    }
    json(res, 200, statePayload());
    return;
  }

  if (method === 'POST' && path === '/api/feed') {
    const body = JSON.parse((await readBody(req)) || '{}') as {
      characterInstanceId?: string;
      qty?: number;
      step?: number;
    };
    if (!body.characterInstanceId) {
      json(res, 400, { error: 'characterInstanceId is required' });
      return;
    }
    const step = body.step ?? clockStep;
    const r = feed(session, body.characterInstanceId, step, body.qty ?? 1);
    if (!r.ok) {
      json(res, 400, { error: r.reason });
      return;
    }
    json(res, 200, statePayload());
    return;
  }

  if (method === 'POST' && path === '/api/survey') {
    const body = JSON.parse((await readBody(req)) || '{}') as { step?: number };
    const step = body.step ?? clockStep;
    const r = startSurvey(session, step);
    if (!r.ok) {
      json(res, 400, { error: r.reason });
      return;
    }
    json(res, 200, statePayload());
    return;
  }

  if (method === 'POST' && path === '/api/survey/cancel') {
    const cancelled = cancelActivity(session);
    json(res, 200, statePayload({ cancelled }));
    return;
  }

  if (method === 'POST' && path === '/api/deploy') {
    const body = JSON.parse((await readBody(req)) || '{}') as {
      characterInstanceId?: string;
      col?: number;
      row?: number;
    };
    if (
      !body.characterInstanceId ||
      body.col == null ||
      body.row == null ||
      !Number.isFinite(body.col) ||
      !Number.isFinite(body.row)
    ) {
      json(res, 400, { error: 'characterInstanceId, col, and row are required' });
      return;
    }
    const r = place(
      session,
      body.characterInstanceId,
      Math.floor(body.col),
      Math.floor(body.row),
    );
    if (!r.ok) {
      json(res, 400, { error: r.reason });
      return;
    }
    json(res, 200, statePayload());
    return;
  }

  if (method === 'POST' && path === '/api/deploy/clear') {
    const body = JSON.parse((await readBody(req)) || '{}') as {
      characterInstanceId?: string;
    };
    if (body.characterInstanceId) {
      const r = clearPlacement(session, body.characterInstanceId);
      if (!r.ok) {
        json(res, 400, { error: r.reason });
        return;
      }
    } else {
      clearDeploy(session);
    }
    json(res, 200, statePayload());
    return;
  }

  if (method === 'POST' && path === '/api/skirmish') {
    const body = JSON.parse((await readBody(req)) || '{}') as {
      battleId?: string;
    };
    const r = skirmish(session, body.battleId, undefined, {
      region,
      step: clockStep,
    });
    if (!r.ok || !r.engagement) {
      json(res, 400, { error: 'reason' in r ? r.reason : 'skirmish failed' });
      return;
    }
    const eng = r.engagement;
    const last = eng.rounds[eng.rounds.length - 1];
    json(res, 200, statePayload({
      skirmish: {
        outcome: eng.outcome,
        roundsPlayed: eng.roundsPlayed,
        aliveA: last?.aliveA ?? 0,
        aliveB: last?.aliveB ?? 0,
        summary: eng.summary,
        engagementId: eng.engagementId,
      },
    }));
    return;
  }

  if (method === 'POST' && path === '/api/assess-skirmish') {
    const body = JSON.parse((await readBody(req)) || '{}') as {
      battleId?: string;
    };
    const r = assessSkirmish(session, body.battleId, undefined, {
      region,
      step: clockStep,
    });
    if (!r.ok || !r.assess) {
      json(res, 400, { error: 'reason' in r ? r.reason : 'assess failed' });
      return;
    }
    const a = r.assess;
    json(res, 200, statePayload({
      assess: {
        outcome: a.outcome,
        ticksToResolve: a.ticksToResolve,
        expectedLosses: a.expectedLosses,
        remaining: a.remaining,
        summary: a.summary,
        engagementId: a.engagement.engagementId,
      },
    }));
    return;
  }

  if (method === 'POST' && path === '/api/equip') {
    const body = JSON.parse((await readBody(req)) || '{}') as {
      characterInstanceId?: string;
      slot?: string;
      catalogId?: string;
    };
    if (!body.characterInstanceId || !body.slot || !body.catalogId) {
      json(res, 400, { error: 'characterInstanceId, slot, and catalogId are required' });
      return;
    }
    if (body.slot !== GearSlot.armor && body.slot !== GearSlot.tool && body.slot !== GearSlot.gear) {
      json(res, 400, { error: 'slot must be armor|tool|gear' });
      return;
    }
    const r = equip(session, body.characterInstanceId, body.slot, body.catalogId);
    if (!r.ok) {
      json(res, 400, { error: r.reason });
      return;
    }
    json(res, 200, statePayload());
    return;
  }

  if (method === 'POST' && path === '/api/unequip') {
    const body = JSON.parse((await readBody(req)) || '{}') as {
      characterInstanceId?: string;
      slot?: string;
    };
    if (!body.characterInstanceId || !body.slot) {
      json(res, 400, { error: 'characterInstanceId and slot are required' });
      return;
    }
    if (body.slot !== GearSlot.armor && body.slot !== GearSlot.tool && body.slot !== GearSlot.gear) {
      json(res, 400, { error: 'slot must be armor|tool|gear' });
      return;
    }
    const r = unequip(session, body.characterInstanceId, body.slot);
    if (!r.ok) {
      json(res, 400, { error: r.reason });
      return;
    }
    json(res, 200, statePayload());
    return;
  }

  if (method === 'POST' && path === '/api/salvage') {
    const body = JSON.parse((await readBody(req)) || '{}') as { instanceId?: string };
    if (!body.instanceId) {
      json(res, 400, { error: 'instanceId of a bench character is required' });
      return;
    }
    const occ = takeBench(body.instanceId);
    if (!occ) {
      json(res, 400, { error: `bench character ${body.instanceId} not found` });
      return;
    }
    const r = salvage(session, occ);
    if (!r.ok) {
      bench.push(occ);
      json(res, 400, { error: r.reason });
      return;
    }
    json(res, 200, statePayload());
    return;
  }

  json(res, 404, { error: 'not found' });
}

function parseHoldTarget(raw: string | undefined): HoldTarget | null {
  if (!raw) return null;
  if (raw === 'loose') return LOOSE;
  return raw;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }

    let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
    if (!ALLOWED.has(filePath)) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    if (filePath === '/') filePath = '/index.html';
    const abs = join(ROOT, filePath.slice(1));
    const data = await readFile(abs);
    const type =
      filePath.endsWith('.css')
        ? 'text/css; charset=utf-8'
        : filePath.endsWith('.js')
          ? 'text/javascript; charset=utf-8'
          : 'text/html; charset=utf-8';
    res.writeHead(200, { 'content-type': type });
    res.end(data);
  } catch (err) {
    console.error(err);
    res.writeHead(500);
    res.end('error');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Caravan manager http://127.0.0.1:${PORT}`);
});
