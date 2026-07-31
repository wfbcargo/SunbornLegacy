import { catalogById } from './catalog.ts';
import { collapseOutpost, countCharacters } from './settle.ts';
import { clearAssignmentsFor } from './staff.ts';
import { clearDeployFor } from './deploy.ts';
import { maybeDerelict } from './derelict.ts';
import { detachHold, ensureHold } from './inventory.ts';
import type {
  Caravan,
  FitResult,
  Occupant,
  SlotState,
  UnfitResult,
  Vehicle,
} from './types.ts';
import { Form, OccupantKind, SlotKind } from './types.ts';

function findVehicle(caravan: Caravan, vehicleId: string): Vehicle | undefined {
  return caravan.vehicles.find((v) => v.id === vehicleId);
}

function findSlot(vehicle: Vehicle, slotIndex: number): SlotState | undefined {
  return vehicle.slots.find((s) => s.def.index === slotIndex);
}

/** True if this occupant instance already sits in any slot on the caravan. */
export function occupantPlaced(caravan: Caravan, instanceId: string): boolean {
  for (const v of caravan.vehicles) {
    for (const s of v.slots) {
      if (s.occupant?.instanceId === instanceId) return true;
    }
  }
  return false;
}

export function canFit(
  caravan: Caravan,
  vehicleId: string,
  slotIndex: number,
  occupant: Occupant,
): FitResult {
  const vehicle = findVehicle(caravan, vehicleId);
  if (!vehicle) return { ok: false, reason: `unknown vehicle: ${vehicleId}` };

  const slot = findSlot(vehicle, slotIndex);
  if (!slot) return { ok: false, reason: `unknown slot index: ${slotIndex}` };

  if (slot.occupant) {
    return {
      ok: false,
      reason: `slot ${slotIndex} (${slot.def.label ?? slot.def.kind}) is occupied by ${slot.occupant.name}; unfit first`,
    };
  }

  if (occupantPlaced(caravan, occupant.instanceId)) {
    return {
      ok: false,
      reason: `occupant ${occupant.instanceId} already fitted elsewhere; an occupant occupies at most one slot`,
    };
  }

  if (occupant.kind !== slot.def.kind) {
    return {
      ok: false,
      reason: `kind mismatch: ${occupant.kind} cannot fit a ${slot.def.kind} slot`,
    };
  }

  const catalog = catalogById(occupant.catalogId);
  if (catalog?.equipSlot) {
    return {
      ok: false,
      reason: `${occupant.name} is equipment — use equip(), do not fit into a chassis slot`,
    };
  }

  if (slot.def.kind === SlotKind.mount || slot.def.kind === SlotKind.wheel) {
    if (slot.def.size == null) {
      return { ok: false, reason: `${slot.def.kind} slot ${slotIndex} has no size (chassis bug)` };
    }
    if (occupant.size !== slot.def.size) {
      return {
        ok: false,
        reason: `size mismatch: ${occupant.size ?? 'none'} cannot fit ${slot.def.size} ${slot.def.kind} slot`,
      };
    }
  }

  if (slot.def.kind === SlotKind.station) {
    if (slot.def.tier == null || slot.def.containerClass == null) {
      return { ok: false, reason: `station slot ${slotIndex} missing tier/containerClass (chassis bug)` };
    }
    if (occupant.tier !== slot.def.tier || occupant.containerClass !== slot.def.containerClass) {
      return {
        ok: false,
        reason:
          `station typing mismatch: need ${slot.def.tier}/${slot.def.containerClass}, ` +
          `got ${occupant.tier ?? 'none'}/${occupant.containerClass ?? 'none'}`,
      };
    }
  }

  return { ok: true };
}

export function fit(
  caravan: Caravan,
  vehicleId: string,
  slotIndex: number,
  occupant: Occupant,
): FitResult {
  const check = canFit(caravan, vehicleId, slotIndex, occupant);
  if (!check.ok) return check;

  const vehicle = findVehicle(caravan, vehicleId)!;
  const slot = findSlot(vehicle, slotIndex)!;
  slot.occupant = occupant;
  if (occupant.kind === OccupantKind.station) ensureHold(caravan, occupant);
  return { ok: true };
}

/**
 * Clear a slot. If this removes the last character from an outpost, the outpost
 * collapses (Session 11: staffing requirement is the decay mechanism).
 */
export function unfit(
  caravan: Caravan,
  vehicleId: string,
  slotIndex: number,
): UnfitResult {
  const vehicle = findVehicle(caravan, vehicleId);
  if (!vehicle) return { ok: false, reason: `unknown vehicle: ${vehicleId}` };

  const slot = findSlot(vehicle, slotIndex);
  if (!slot) return { ok: false, reason: `unknown slot index: ${slotIndex}` };

  if (!slot.occupant) {
    return { ok: false, reason: `slot ${slotIndex} is already empty` };
  }

  const occupant = slot.occupant;
  const removingLastManager =
    caravan.form === Form.outpost &&
    occupant.kind === OccupantKind.character &&
    countCharacters(caravan) === 1;

  if (occupant.kind === OccupantKind.station) {
    detachHold(caravan, occupant.instanceId);
    delete caravan.production[occupant.instanceId];
  }

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
    return {
      ok: true,
      occupant,
      collapsed: true,
      refunds: collapsed.refunds,
      strippedStation: collapsed.occupant,
    };
  }

  maybeDerelict(caravan);
  return {
    ok: true,
    occupant,
    collapsed: false,
    refunds: [],
    strippedStation: null,
  };
}
