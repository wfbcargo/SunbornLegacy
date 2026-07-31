/**
 * Station staffing — assign fitted characters to fitted stations.
 *
 * Assignment is a soft link: the character stays in their seat.
 * One character ↔ one station this slice.
 */

import type { Caravan, FitResult, Occupant, StationAssignment } from './types.ts';
import { OccupantKind } from './types.ts';

function findFitted(
  caravan: Caravan,
  instanceId: string,
): Occupant | null {
  for (const v of caravan.vehicles) {
    for (const s of v.slots) {
      if (s.occupant?.instanceId === instanceId) return s.occupant;
    }
  }
  return null;
}

export function assignmentForCharacter(
  caravan: Caravan,
  characterInstanceId: string,
): StationAssignment | undefined {
  return caravan.assignments.find((a) => a.characterInstanceId === characterInstanceId);
}

export function assignmentForStation(
  caravan: Caravan,
  stationInstanceId: string,
): StationAssignment | undefined {
  return caravan.assignments.find((a) => a.stationInstanceId === stationInstanceId);
}

export function canAssign(
  caravan: Caravan,
  characterInstanceId: string,
  stationInstanceId: string,
): FitResult {
  const character = findFitted(caravan, characterInstanceId);
  if (!character) {
    return { ok: false, reason: `character ${characterInstanceId} is not fitted on this caravan` };
  }
  if (character.kind !== OccupantKind.character) {
    return { ok: false, reason: `${characterInstanceId} is a ${character.kind}, not a character` };
  }

  const station = findFitted(caravan, stationInstanceId);
  if (!station) {
    return { ok: false, reason: `station ${stationInstanceId} is not fitted on this caravan` };
  }
  if (station.kind !== OccupantKind.station) {
    return { ok: false, reason: `${stationInstanceId} is a ${station.kind}, not a station` };
  }

  const charBusy = assignmentForCharacter(caravan, characterInstanceId);
  if (charBusy && charBusy.stationInstanceId !== stationInstanceId) {
    return {
      ok: false,
      reason:
        `${character.name} already staffs another station (${charBusy.stationInstanceId}); unassign first`,
    };
  }

  const stationBusy = assignmentForStation(caravan, stationInstanceId);
  if (stationBusy && stationBusy.characterInstanceId !== characterInstanceId) {
    return {
      ok: false,
      reason:
        `${station.name} is already staffed by ${stationBusy.characterInstanceId}; unassign first`,
    };
  }

  if (charBusy && stationBusy) {
    return { ok: false, reason: `${character.name} already staffs ${station.name}` };
  }

  return { ok: true };
}

export function assign(
  caravan: Caravan,
  characterInstanceId: string,
  stationInstanceId: string,
): FitResult {
  const check = canAssign(caravan, characterInstanceId, stationInstanceId);
  if (!check.ok) return check;

  if (assignmentForCharacter(caravan, characterInstanceId)) {
    return { ok: false, reason: `already assigned` };
  }

  caravan.assignments.push({ characterInstanceId, stationInstanceId });
  return { ok: true };
}

export type UnassignOk = { ok: true; assignment: StationAssignment };
export type UnassignResult = UnassignOk | { ok: false; reason: string };

/** Unassign by character id, station id, or both (must match if both given). */
export function unassign(
  caravan: Caravan,
  opts: { characterInstanceId?: string; stationInstanceId?: string },
): UnassignResult {
  const { characterInstanceId, stationInstanceId } = opts;
  if (!characterInstanceId && !stationInstanceId) {
    return { ok: false, reason: 'characterInstanceId or stationInstanceId is required' };
  }

  let idx = -1;
  if (characterInstanceId && stationInstanceId) {
    idx = caravan.assignments.findIndex(
      (a) =>
        a.characterInstanceId === characterInstanceId &&
        a.stationInstanceId === stationInstanceId,
    );
    if (idx < 0) {
      return {
        ok: false,
        reason: `no assignment linking ${characterInstanceId} → ${stationInstanceId}`,
      };
    }
  } else if (characterInstanceId) {
    idx = caravan.assignments.findIndex((a) => a.characterInstanceId === characterInstanceId);
    if (idx < 0) {
      return { ok: false, reason: `character ${characterInstanceId} is not staffing a station` };
    }
  } else {
    idx = caravan.assignments.findIndex((a) => a.stationInstanceId === stationInstanceId);
    if (idx < 0) {
      return { ok: false, reason: `station ${stationInstanceId} has no assignee` };
    }
  }

  const [assignment] = caravan.assignments.splice(idx, 1);
  return { ok: true, assignment: assignment! };
}

/** Drop any assignment that references this instance (character or station). */
export function clearAssignmentsFor(caravan: Caravan, instanceId: string): number {
  const before = caravan.assignments.length;
  caravan.assignments = caravan.assignments.filter(
    (a) => a.characterInstanceId !== instanceId && a.stationInstanceId !== instanceId,
  );
  return before - caravan.assignments.length;
}
