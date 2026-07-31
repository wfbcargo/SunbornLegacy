import type { Caravan, DerivedStats } from './types.ts';
import { Form, OccupantKind } from './types.ts';

/** Speed and staffing derived from fitted mounts and characters. */
export function deriveStats(caravan: Caravan): DerivedStats {
  let ticksPerTile: number | null = null;
  let characterCount = 0;
  let mountCount = 0;
  let stationCount = 0;
  let emptySlots = 0;

  for (const vehicle of caravan.vehicles) {
    for (const slot of vehicle.slots) {
      const occ = slot.occupant;
      if (!occ) {
        emptySlots++;
        continue;
      }
      if (occ.kind === OccupantKind.character) characterCount++;
      else if (occ.kind === OccupantKind.mount) mountCount++;
      else if (occ.kind === OccupantKind.station) stationCount++;

      if (
        (occ.kind === OccupantKind.mount || occ.kind === OccupantKind.character) &&
        occ.ticksPerTile != null
      ) {
        ticksPerTile =
          ticksPerTile == null
            ? occ.ticksPerTile
            : Math.max(ticksPerTile, occ.ticksPerTile);
      }
    }
  }

  const mobile = caravan.form === Form.caravan;
  if (!mobile) ticksPerTile = null;

  return {
    ticksPerTile,
    mobile,
    form: caravan.form,
    staffed: characterCount >= 1,
    characterCount,
    mountCount,
    stationCount,
    emptySlots,
  };
}
