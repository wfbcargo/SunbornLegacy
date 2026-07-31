/**
 * Character equipment — armor / tool / gear catalog ids on occupants.
 */

import { catalogById } from './catalog.ts';
import { depositRefunds } from './inventory.ts';
import type { Caravan, FitResult, Occupant } from './types.ts';
import { OccupantKind } from './types.ts';

export const GearSlot = {
  armor: 'armor',
  tool: 'tool',
  gear: 'gear',
} as const;
export type GearSlot = (typeof GearSlot)[keyof typeof GearSlot];

const SLOT_ITEM: Record<GearSlot, string> = {
  armor: 'scrap_vest',
  tool: 'hand_axe',
  gear: 'trail_kit',
};

export function isGearItem(catalogId: string): boolean {
  return Object.values(SLOT_ITEM).includes(catalogId);
}

function findCharacter(
  caravan: Caravan,
  instanceId: string,
): Occupant | null {
  for (const v of caravan.vehicles) {
    for (const s of v.slots) {
      if (s.occupant?.instanceId === instanceId && s.occupant.kind === OccupantKind.character) {
        return s.occupant;
      }
    }
  }
  return null;
}

export function equip(
  caravan: Caravan,
  characterInstanceId: string,
  slot: GearSlot,
  catalogId: string,
): FitResult {
  const character = findCharacter(caravan, characterInstanceId);
  if (!character) {
    return { ok: false, reason: `character ${characterInstanceId} is not fitted` };
  }
  if (!catalogById(catalogId) || !isGearItem(catalogId)) {
    return { ok: false, reason: `unknown gear catalog id: ${catalogId}` };
  }
  if (SLOT_ITEM[slot] !== catalogId) {
    return {
      ok: false,
      reason: `${catalogId} does not fit ${slot} (expected ${SLOT_ITEM[slot]} this slice)`,
    };
  }
  const prev = character[slot];
  character[slot] = catalogId;
  if (prev) {
    depositRefunds(caravan, [{ materialId: prev, qty: 1 }]);
  }
  return { ok: true };
}

export function unequip(
  caravan: Caravan,
  characterInstanceId: string,
  slot: GearSlot,
): FitResult {
  const character = findCharacter(caravan, characterInstanceId);
  if (!character) {
    return { ok: false, reason: `character ${characterInstanceId} is not fitted` };
  }
  const prev = character[slot];
  if (!prev) {
    return { ok: false, reason: `${slot} is empty on ${character.name}` };
  }
  character[slot] = undefined;
  depositRefunds(caravan, [{ materialId: prev, qty: 1 }]);
  return { ok: true };
}
