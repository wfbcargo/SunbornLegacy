import { catalogById } from './catalog.ts';
import { deriveStats } from './derive.ts';
import { positionAt } from './legs.ts';
import {
  ContainerClass,
  Form,
  SlotKind,
  SlotTier,
  type Caravan,
  type MaterialStack,
  type Occupant,
  type SettleResult,
  type SlotDef,
} from './types.ts';

/**
 * Session 11 open question — mobilisation refund percentage.
 * Too generous → settlements are disposable; too harsh → map calcifies.
 * Locked at half until economy numbers exist.
 */
export const MOBILISE_REFUND_RATIO = 0.5;

export const OUTPOST_SLOT_INDEX = 14;

export const OUTPOST_SLOT_DEF: SlotDef = {
  index: OUTPOST_SLOT_INDEX,
  kind: SlotKind.station,
  tier: SlotTier.basic,
  containerClass: ContainerClass.outpost,
  label: 'Outpost station',
};

export const REFUND_MATERIAL = 'construction_scrap';

function primaryVehicle(caravan: Caravan) {
  return caravan.vehicles[0];
}

function refundForStation(occupant: Occupant | null): MaterialStack[] {
  if (!occupant || occupant.kind !== 'station') return [];
  const item = catalogById(occupant.catalogId);
  const cost = item?.constructionCost ?? 0;
  const qty = Math.floor(cost * MOBILISE_REFUND_RATIO);
  if (qty <= 0) return [];
  return [{ materialId: REFUND_MATERIAL, qty }];
}

/** Remove the outpost slot; return its occupant (if any) and scrap refund. */
export function stripOutpostSlot(caravan: Caravan): {
  occupant: Occupant | null;
  refunds: MaterialStack[];
} {
  const vehicle = primaryVehicle(caravan);
  if (!vehicle) return { occupant: null, refunds: [] };

  const idx = vehicle.slots.findIndex((s) => s.def.index === OUTPOST_SLOT_INDEX);
  if (idx < 0) return { occupant: null, refunds: [] };

  const slot = vehicle.slots[idx]!;
  const occupant = slot.occupant;
  const refunds = refundForStation(occupant);
  vehicle.slots.splice(idx, 1);
  return { occupant, refunds };
}

/**
 * Settle: caravan becomes an immobile outpost and gains the outpost station slot.
 * Rejects while travelling at `step`.
 */
export function settle(caravan: Caravan, step = 0): SettleResult {
  if (caravan.form !== Form.caravan) {
    return { ok: false, reason: `already settled as ${caravan.form}; mobilise first` };
  }
  const pos = positionAt(caravan, step);
  if (pos.travelling) {
    return {
      ok: false,
      reason: `cannot settle while travelling (step ${step} on leg ${pos.legSeq}); wait until idle`,
    };
  }
  const stats = deriveStats(caravan);
  if (!stats.staffed) {
    return { ok: false, reason: 'cannot settle: outpost requires at least one character managing it' };
  }
  const vehicle = primaryVehicle(caravan);
  if (!vehicle) return { ok: false, reason: 'cannot settle: no vehicle' };

  if (vehicle.slots.some((s) => s.def.index === OUTPOST_SLOT_INDEX)) {
    return { ok: false, reason: 'outpost slot already present (chassis bug)' };
  }

  vehicle.slots.push({ def: { ...OUTPOST_SLOT_DEF }, occupant: null });
  caravan.form = Form.outpost;
  return { ok: true, refunds: [], strippedStation: null };
}

/**
 * Mobilise: destroy the outpost slot (refund station scrap) and restore mobility.
 * Requires a managing character — unstaffed path is collapse via unfit.
 */
export function mobilise(caravan: Caravan): SettleResult {
  if (caravan.form !== Form.outpost) {
    return { ok: false, reason: 'not an outpost; settle first' };
  }
  const stats = deriveStats(caravan);
  if (!stats.staffed) {
    return {
      ok: false,
      reason: 'cannot mobilise while unstaffed; remove the last character to collapse the outpost',
    };
  }

  const { refunds, occupant } = stripOutpostSlot(caravan);
  caravan.form = Form.caravan;
  return { ok: true, refunds, strippedStation: occupant };
}

/**
 * Staffing collapse: last character left — outpost is destroyed, wagon remains.
 */
export function collapseOutpost(caravan: Caravan): { refunds: MaterialStack[]; occupant: Occupant | null } {
  if (caravan.form !== Form.outpost) {
    return { refunds: [], occupant: null };
  }
  const stripped = stripOutpostSlot(caravan);
  caravan.form = Form.caravan;
  return stripped;
}

export function countCharacters(caravan: Caravan): number {
  let n = 0;
  for (const v of caravan.vehicles) {
    for (const s of v.slots) {
      if (s.occupant?.kind === 'character') n++;
    }
  }
  return n;
}
