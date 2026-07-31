/**
 * Hunger — satedUntilStep deadlines, feed, starve, staffed food production.
 */

import { deposit, detachHold, LOOSE, withdraw } from './inventory.ts';
import { collapseOutpost, countCharacters } from './settle.ts';
import { assignmentForStation, clearAssignmentsFor } from './staff.ts';
import { clearDeployFor } from './deploy.ts';
import { maybeDerelict } from './derelict.ts';
import { stallAt, positionAt } from './legs.ts';
import type { Caravan, FitResult, Occupant } from './types.ts';
import { Form, OccupantKind } from './types.ts';

export const RATIONS = 'rations';
/** Steps of satiety gained per ration fed. */
export const FEED_EXTEND_STEPS = 120;
/** Starting characters are sated until this step (from 0). */
export const START_SATED_UNTIL = 200;
/** Staffed food_grower deposits once per this many steps. */
export const PRODUCE_INTERVAL = 60;
export const PRODUCE_QTY = 1;
export const FOOD_GROWER_ID = 'food_grower';

export type StarveReport = {
  starved: Occupant[];
  collapsed: boolean;
};

function findCharacter(
  caravan: Caravan,
  instanceId: string,
): { vehicleId: string; slotIndex: number; occupant: Occupant } | null {
  for (const v of caravan.vehicles) {
    for (const s of v.slots) {
      if (s.occupant?.instanceId === instanceId) {
        return { vehicleId: v.id, slotIndex: s.def.index, occupant: s.occupant };
      }
    }
  }
  return null;
}

function totalRations(caravan: Caravan): number {
  let n = 0;
  for (const hold of caravan.holds) {
    for (const s of hold.stacks) {
      if (s.materialId === RATIONS) n += s.qty;
    }
  }
  for (const s of caravan.loose) {
    if (s.materialId === RATIONS) n += s.qty;
  }
  return n;
}

function withdrawRations(caravan: Caravan, qty: number): FitResult {
  if (totalRations(caravan) < qty) {
    return {
      ok: false,
      reason: `need ${qty} ${RATIONS}; have ${totalRations(caravan)}`,
    };
  }
  let left = qty;
  for (const hold of caravan.holds) {
    if (left <= 0) break;
    const stack = hold.stacks.find((s) => s.materialId === RATIONS);
    if (!stack) continue;
    const take = Math.min(stack.qty, left);
    const w = withdraw(caravan, hold.stationInstanceId, RATIONS, take);
    if (!w.ok) return w;
    left -= take;
  }
  if (left > 0) {
    const w = withdraw(caravan, LOOSE, RATIONS, left);
    if (!w.ok) return w;
  }
  return { ok: true };
}

export function feed(
  caravan: Caravan,
  characterInstanceId: string,
  step: number,
  qty = 1,
): FitResult {
  if (!Number.isFinite(qty) || qty <= 0 || !Number.isInteger(qty)) {
    return { ok: false, reason: 'qty must be a positive integer' };
  }
  if (!Number.isFinite(step) || step < 0) {
    return { ok: false, reason: 'step must be a non-negative number' };
  }
  const found = findCharacter(caravan, characterInstanceId);
  if (!found) {
    return { ok: false, reason: `character ${characterInstanceId} is not fitted` };
  }
  if (found.occupant.kind !== OccupantKind.character) {
    return { ok: false, reason: `${characterInstanceId} is not a character` };
  }

  const paid = withdrawRations(caravan, qty);
  if (!paid.ok) return paid;

  const current = found.occupant.satedUntilStep ?? step;
  const base = Math.max(step, current);
  found.occupant.satedUntilStep = base + FEED_EXTEND_STEPS * qty;
  return { ok: true };
}

function destroyCharacter(
  caravan: Caravan,
  vehicleId: string,
  slotIndex: number,
  occupant: Occupant,
): { collapsed: boolean } {
  const vehicle = caravan.vehicles.find((v) => v.id === vehicleId);
  if (!vehicle) return { collapsed: false };
  const slot = vehicle.slots.find((s) => s.def.index === slotIndex);
  if (!slot || slot.occupant?.instanceId !== occupant.instanceId) {
    return { collapsed: false };
  }

  const removingLastManager =
    caravan.form === Form.outpost && countCharacters(caravan) === 1;

  slot.occupant = null;
  clearAssignmentsFor(caravan, occupant.instanceId);
  clearDeployFor(caravan, occupant.instanceId);

  if (removingLastManager) {
    const collapsed = collapseOutpost(caravan);
    if (collapsed.occupant) {
      detachHold(caravan, collapsed.occupant.instanceId);
      clearAssignmentsFor(caravan, collapsed.occupant.instanceId);
      clearDeployFor(caravan, collapsed.occupant.instanceId);
    }
    maybeDerelict(caravan);
    return { collapsed: true };
  }
  maybeDerelict(caravan);
  return { collapsed: false };
}

/** Remove characters whose food deadline is strictly before `step`. */
export function starveAt(caravan: Caravan, step: number): StarveReport {
  const starved: Occupant[] = [];
  let collapsed = false;

  // Snapshot list first — mutation while iterating slots is unsafe.
  const victims: Array<{ vehicleId: string; slotIndex: number; occupant: Occupant }> = [];
  for (const v of caravan.vehicles) {
    for (const s of v.slots) {
      const o = s.occupant;
      if (!o || o.kind !== OccupantKind.character) continue;
      const deadline = o.satedUntilStep ?? 0;
      if (deadline < step) {
        victims.push({ vehicleId: v.id, slotIndex: s.def.index, occupant: o });
      }
    }
  }

  for (const v of victims) {
    const r = destroyCharacter(caravan, v.vehicleId, v.slotIndex, v.occupant);
    starved.push(v.occupant);
    if (r.collapsed) collapsed = true;
  }

  return { starved, collapsed };
}

function depositRations(caravan: Caravan, qty: number): void {
  for (const hold of caravan.holds) {
    const d = deposit(caravan, hold.stationInstanceId, RATIONS, qty);
    if (d.ok) return;
  }
  deposit(caravan, LOOSE, RATIONS, qty);
}

/**
 * Staffed food_grower stations produce rations on PRODUCE_INTERVAL.
 * `fertility` scales qty (0 = barren site, no produce). Spec 60e8f1a2.
 * Returns total rations produced this call.
 */
export function produceAt(caravan: Caravan, step: number, fertility = 1): number {
  if (fertility <= 0) return 0;
  let produced = 0;
  for (const v of caravan.vehicles) {
    for (const s of v.slots) {
      const o = s.occupant;
      if (!o || o.kind !== OccupantKind.station) continue;
      if (o.catalogId !== FOOD_GROWER_ID) continue;
      if (!assignmentForStation(caravan, o.instanceId)) continue;

      const last = caravan.production[o.instanceId] ?? 0;
      if (step - last < PRODUCE_INTERVAL) continue;

      const cycles = Math.floor((step - last) / PRODUCE_INTERVAL);
      if (cycles <= 0) continue;

      const qty = cycles * PRODUCE_QTY * fertility;
      depositRations(caravan, qty);
      caravan.production[o.instanceId] = last + cycles * PRODUCE_INTERVAL;
      produced += qty;
    }
  }
  return produced;
}

function minSatedUntil(caravan: Caravan): number | null {
  let min: number | null = null;
  for (const v of caravan.vehicles) {
    for (const s of v.slots) {
      const o = s.occupant;
      if (!o || o.kind !== OccupantKind.character) continue;
      const d = o.satedUntilStep;
      if (d == null) continue;
      min = min == null ? d : Math.min(min, d);
    }
  }
  return min;
}

/** Advance needs from previous clock to `step`: hunger-stall, produce, starve. */
export function advanceNeeds(
  caravan: Caravan,
  step: number,
  fertility = 1,
): {
  produced: number;
  starve: StarveReport;
  stalledForHunger: boolean;
} {
  let stalledForHunger = false;
  const pos = positionAt(caravan, step);
  if (pos.travelling) {
    const deadline = minSatedUntil(caravan);
    if (deadline != null && deadline <= step) {
      stallAt(caravan, step);
      stalledForHunger = true;
    }
  }
  const produced = produceAt(caravan, step, fertility);
  const starve = starveAt(caravan, step);
  return { produced, starve, stalledForHunger };
}
