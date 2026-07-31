/**
 * Station cargo — deposit, withdraw, transfer.
 *
 * Holds attach to fitted stations with catalog cargoCapacity.
 * Loose stacks sit on the caravan when no hold accepts them.
 */

import { catalogById } from './catalog.ts';
import type {
  Caravan,
  CargoHold,
  FitResult,
  MaterialStack,
  Occupant,
} from './types.ts';
import { OccupantKind } from './types.ts';

export type InvOk = { ok: true };
export type InvErr = { ok: false; reason: string };
export type InvResult = InvOk | InvErr;

const LOOSE = 'loose' as const;

export type HoldTarget = string | typeof LOOSE;

function findFittedStation(caravan: Caravan, instanceId: string): Occupant | null {
  for (const v of caravan.vehicles) {
    for (const s of v.slots) {
      if (s.occupant?.instanceId === instanceId) return s.occupant;
    }
  }
  return null;
}

function capacityOf(station: Occupant): number | null {
  if (station.kind !== OccupantKind.station) return null;
  const item = catalogById(station.catalogId);
  return item?.cargoCapacity ?? null;
}

function totalQty(stacks: readonly MaterialStack[]): number {
  let n = 0;
  for (const s of stacks) n += s.qty;
  return n;
}

function mergeInto(stacks: MaterialStack[], materialId: string, qty: number): void {
  const existing = stacks.find((s) => s.materialId === materialId);
  if (existing) existing.qty += qty;
  else stacks.push({ materialId, qty });
}

function takeFrom(stacks: MaterialStack[], materialId: string, qty: number): InvResult {
  const existing = stacks.find((s) => s.materialId === materialId);
  if (!existing || existing.qty < qty) {
    return {
      ok: false,
      reason: `insufficient ${materialId}: have ${existing?.qty ?? 0}, need ${qty}`,
    };
  }
  existing.qty -= qty;
  if (existing.qty === 0) {
    const i = stacks.indexOf(existing);
    stacks.splice(i, 1);
  }
  return { ok: true };
}

function stacksOf(caravan: Caravan, target: HoldTarget): MaterialStack[] | null {
  if (target === LOOSE) return caravan.loose;
  const hold = caravan.holds.find((h) => h.stationInstanceId === target);
  return hold ? hold.stacks : null;
}

export function holdOf(caravan: Caravan, stationInstanceId: string): CargoHold | undefined {
  return caravan.holds.find((h) => h.stationInstanceId === stationInstanceId);
}

/** Create empty holds for fitted cargo stations; drop holds for missing stations. */
export function syncHolds(caravan: Caravan): void {
  const cargoIds = new Set<string>();
  for (const v of caravan.vehicles) {
    for (const s of v.slots) {
      const occ = s.occupant;
      if (!occ || occ.kind !== OccupantKind.station) continue;
      if (capacityOf(occ) == null) continue;
      cargoIds.add(occ.instanceId);
      if (!holdOf(caravan, occ.instanceId)) {
        caravan.holds.push({ stationInstanceId: occ.instanceId, stacks: [] });
      }
    }
  }
  caravan.holds = caravan.holds.filter((h) => {
    if (cargoIds.has(h.stationInstanceId)) return true;
    for (const s of h.stacks) mergeInto(caravan.loose, s.materialId, s.qty);
    return false;
  });
}

/** After fitting a cargo station — ensure its hold exists. */
export function ensureHold(caravan: Caravan, station: Occupant): void {
  if (capacityOf(station) == null) return;
  if (!holdOf(caravan, station.instanceId)) {
    caravan.holds.push({ stationInstanceId: station.instanceId, stacks: [] });
  }
}

/**
 * Remove hold for a station being unfit; spill stacks to loose.
 * Call before/after occupant cleared — stationInstanceId is enough.
 */
export function detachHold(caravan: Caravan, stationInstanceId: string): void {
  const i = caravan.holds.findIndex((h) => h.stationInstanceId === stationInstanceId);
  if (i < 0) return;
  const [hold] = caravan.holds.splice(i, 1);
  for (const s of hold!.stacks) mergeInto(caravan.loose, s.materialId, s.qty);
}

export function deposit(
  caravan: Caravan,
  target: HoldTarget,
  materialId: string,
  qty: number,
): InvResult {
  if (!Number.isFinite(qty) || qty <= 0 || !Number.isInteger(qty)) {
    return { ok: false, reason: 'qty must be a positive integer' };
  }
  if (!materialId) return { ok: false, reason: 'materialId is required' };

  if (target === LOOSE) {
    mergeInto(caravan.loose, materialId, qty);
    return { ok: true };
  }

  const station = findFittedStation(caravan, target);
  if (!station) return { ok: false, reason: `station ${target} is not fitted` };
  const cap = capacityOf(station);
  if (cap == null) {
    return { ok: false, reason: `${station.name} has no cargo capacity` };
  }
  ensureHold(caravan, station);
  const hold = holdOf(caravan, target)!;
  if (totalQty(hold.stacks) + qty > cap) {
    return {
      ok: false,
      reason: `capacity ${cap} exceeded (have ${totalQty(hold.stacks)}, adding ${qty})`,
    };
  }
  mergeInto(hold.stacks, materialId, qty);
  return { ok: true };
}

export function withdraw(
  caravan: Caravan,
  source: HoldTarget,
  materialId: string,
  qty: number,
): InvResult {
  if (!Number.isFinite(qty) || qty <= 0 || !Number.isInteger(qty)) {
    return { ok: false, reason: 'qty must be a positive integer' };
  }
  const stacks = stacksOf(caravan, source);
  if (!stacks) {
    return { ok: false, reason: `unknown hold: ${source}` };
  }
  return takeFrom(stacks, materialId, qty);
}

export function transfer(
  caravan: Caravan,
  from: HoldTarget,
  to: HoldTarget,
  materialId: string,
  qty: number,
): InvResult {
  if (from === to) return { ok: false, reason: 'source and destination are the same' };
  const w = withdraw(caravan, from, materialId, qty);
  if (!w.ok) return w;
  const d = deposit(caravan, to, materialId, qty);
  if (!d.ok) {
    // roll back
    deposit(caravan, from, materialId, qty);
    return d;
  }
  return { ok: true };
}

/** Prefer first cargo hold with room; else loose. Used for mobilise refunds. */
export function depositRefunds(caravan: Caravan, refunds: readonly MaterialStack[]): void {
  for (const r of refunds) {
    let placed = false;
    for (const hold of caravan.holds) {
      const d = deposit(caravan, hold.stationInstanceId, r.materialId, r.qty);
      if (d.ok) {
        placed = true;
        break;
      }
    }
    if (!placed) {
      deposit(caravan, LOOSE, r.materialId, r.qty);
    }
  }
}

export { LOOSE };
