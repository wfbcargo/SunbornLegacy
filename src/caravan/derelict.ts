/**
 * Derelict form — last character gone; salvage restores a caravan.
 * Decision 0039.
 */

import { clearDeploy } from './deploy.ts';
import type { Caravan, FitResult, Occupant } from './types.ts';
import { Form, OccupantKind, SlotKind } from './types.ts';

export function markDerelict(caravan: Caravan): void {
  caravan.form = Form.derelict;
  caravan.assignments = [];
  caravan.activity = null;
  clearDeploy(caravan);
}

/** After removing a character — derelict if none remain. */
export function maybeDerelict(caravan: Caravan): boolean {
  let chars = 0;
  for (const v of caravan.vehicles) {
    for (const s of v.slots) {
      if (s.occupant?.kind === OccupantKind.character) chars++;
    }
  }
  if (chars > 0) return false;
  if (caravan.form === Form.derelict) return true;
  markDerelict(caravan);
  return true;
}

/**
 * Place a character into the first empty character seat and restore Form.caravan.
 * Does not go through fit() to avoid circular imports with unfit→derelict.
 */
export function salvage(caravan: Caravan, character: Occupant): FitResult {
  if (caravan.form !== Form.derelict) {
    return { ok: false, reason: 'not a derelict; nothing to salvage' };
  }
  if (character.kind !== OccupantKind.character) {
    return { ok: false, reason: 'salvage requires a character' };
  }
  for (const v of caravan.vehicles) {
    for (const s of v.slots) {
      if (s.def.kind === SlotKind.character && !s.occupant) {
        s.occupant = character;
        caravan.form = Form.caravan;
        return { ok: true };
      }
    }
  }
  return { ok: false, reason: 'no empty character seat to salvage into' };
}
