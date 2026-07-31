/**
 * Side-A deployment template — placements in the 4×6 battle deploy zone.
 */

import type { Caravan, DeployPlacement, FitResult, Occupant } from './types.ts';
import { OccupantKind } from './types.ts';

export const DEPLOY_COLS = 4;
export const DEPLOY_ROWS = 6;

function findFittedCharacter(
  caravan: Caravan,
  instanceId: string,
): Occupant | null {
  for (const v of caravan.vehicles) {
    for (const s of v.slots) {
      const o = s.occupant;
      if (o?.instanceId === instanceId && o.kind === OccupantKind.character) {
        return o;
      }
    }
  }
  return null;
}

export function canPlace(
  caravan: Caravan,
  characterInstanceId: string,
  col: number,
  row: number,
): FitResult {
  if (!Number.isInteger(col) || col < 0 || col >= DEPLOY_COLS) {
    return { ok: false, reason: `col must be 0…${DEPLOY_COLS - 1} (Side A); got ${col}` };
  }
  if (!Number.isInteger(row) || row < 0 || row >= DEPLOY_ROWS) {
    return { ok: false, reason: `row must be 0…${DEPLOY_ROWS - 1}; got ${row}` };
  }
  const character = findFittedCharacter(caravan, characterInstanceId);
  if (!character) {
    return {
      ok: false,
      reason: `character ${characterInstanceId} is not fitted on this caravan`,
    };
  }
  const occupied = caravan.deploy.placements.find(
    (p) => p.col === col && p.row === row && p.characterInstanceId !== characterInstanceId,
  );
  if (occupied) {
    return {
      ok: false,
      reason: `cell ${col},${row} already holds ${occupied.characterInstanceId}`,
    };
  }
  return { ok: true };
}

/** Place or move a fitted character onto a Side-A deploy cell. */
export function place(
  caravan: Caravan,
  characterInstanceId: string,
  col: number,
  row: number,
): FitResult {
  const gate = canPlace(caravan, characterInstanceId, col, row);
  if (!gate.ok) return gate;
  const existing = caravan.deploy.placements.findIndex(
    (p) => p.characterInstanceId === characterInstanceId,
  );
  const next: DeployPlacement = { characterInstanceId, col, row };
  if (existing >= 0) caravan.deploy.placements[existing] = next;
  else caravan.deploy.placements.push(next);
  return { ok: true };
}

export function clearPlacement(
  caravan: Caravan,
  characterInstanceId: string,
): FitResult {
  const i = caravan.deploy.placements.findIndex(
    (p) => p.characterInstanceId === characterInstanceId,
  );
  if (i < 0) {
    return { ok: false, reason: `no deploy placement for ${characterInstanceId}` };
  }
  caravan.deploy.placements.splice(i, 1);
  return { ok: true };
}

export function clearDeploy(caravan: Caravan): void {
  caravan.deploy.placements = [];
}

/** Drop placements for a removed occupant (character unfit / starve). */
export function clearDeployFor(caravan: Caravan, instanceId: string): void {
  caravan.deploy.placements = caravan.deploy.placements.filter(
    (p) => p.characterInstanceId !== instanceId,
  );
}

/** Front-edge auto-place: col 3, successive rows. */
export function autoDeployFront(caravan: Caravan): FitResult {
  clearDeploy(caravan);
  const chars: Occupant[] = [];
  for (const v of caravan.vehicles) {
    for (const s of v.slots) {
      if (s.occupant?.kind === OccupantKind.character) chars.push(s.occupant);
    }
  }
  if (chars.length === 0) {
    return { ok: false, reason: 'no fitted characters to deploy' };
  }
  if (chars.length > DEPLOY_ROWS) {
    return {
      ok: false,
      reason: `too many characters (${chars.length}) for ${DEPLOY_ROWS}-row Side A zone`,
    };
  }
  for (let i = 0; i < chars.length; i++) {
    const r = place(caravan, chars[i]!.instanceId, 3, i);
    if (!r.ok) return r;
  }
  return { ok: true };
}
