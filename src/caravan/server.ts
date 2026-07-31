/**
 * Local caravan lab — outfit slots, settle/mobilise, travel legs.
 *
 *   npm run caravan:view
 *
 * Binds 127.0.0.1 only. Not a product surface.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { allCatalog, catalogById, spawnFromCatalog } from './catalog.ts';
import { chassisById } from './chassis.ts';
import { deriveStats } from './derive.ts';
import { canFit, fit, unfit } from './fit.ts';
import { commitLeg, positionAt, stallAt } from './legs.ts';
import { emptyCaravan, makeStartingCaravan } from './loadout.ts';
import { LAB_HEIGHT, LAB_WIDTH, neighboursOf } from './path.ts';
import { mobilise, settle } from './settle.ts';
import type { Caravan, MaterialStack, Occupant, TileCoord } from './types.ts';

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

let session: Caravan = makeStartingCaravan('lab');
let clockStep = 0;
const bench: Occupant[] = [];
const scrap: MaterialStack[] = [];

function pushScrap(refunds: readonly MaterialStack[]): void {
  for (const r of refunds) {
    const existing = scrap.find((s) => s.materialId === r.materialId);
    if (existing) existing.qty += r.qty;
    else scrap.push({ materialId: r.materialId, qty: r.qty });
  }
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
        slots: v.slots.map((s) => ({
          index: s.def.index,
          kind: s.def.kind,
          size: s.def.size ?? null,
          tier: s.def.tier ?? null,
          containerClass: s.def.containerClass ?? null,
          label: s.def.label ?? `${s.def.kind}#${s.def.index}`,
          occupant: serializeOccupant(s.occupant),
        })),
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
  return {
    step: clockStep,
    map: { width: LAB_WIDTH, height: LAB_HEIGHT },
    neighbours: neighboursOf(pos.tile),
    caravan: serializeCaravan(session, clockStep),
    catalog: allCatalog(),
    bench: bench.map(serializeOccupant),
    scrap: scrap.map((s) => ({ ...s })),
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
    scrap.length = 0;
    clockStep = 0;
    session = body.empty
      ? emptyCaravan()
      : makeStartingCaravan(body.seed ?? 'lab');
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
    json(res, 200, statePayload());
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
    const r = commitLeg(session, body.tiles, startStep);
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
    const r = settle(session, body.step ?? clockStep);
    if (!r.ok) {
      json(res, 400, { error: r.reason });
      return;
    }
    json(res, 200, statePayload());
    return;
  }

  if (method === 'POST' && path === '/api/mobilise') {
    const r = mobilise(session);
    if (!r.ok) {
      json(res, 400, { error: r.reason });
      return;
    }
    pushScrap(r.refunds);
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
          pushScrap(u.refunds);
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
    pushScrap(r.refunds);
    json(res, 200, statePayload({
      collapsed: r.collapsed,
      lastRefunds: r.refunds,
    }));
    return;
  }

  json(res, 404, { error: 'not found' });
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
  console.log(`Caravan lab http://127.0.0.1:${PORT}`);
});
