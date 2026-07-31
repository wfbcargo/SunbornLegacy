import { hashString, mulberry32 } from '../sim/rng.ts';
import { resetInstanceIds, spawnFromCatalog } from './catalog.ts';
import { BASIC_WAGON } from './chassis.ts';
import { fit } from './fit.ts';
import { Form, type Caravan, type SlotState, type Vehicle } from './types.ts';

const FIRST_NAMES = [
  'Argon',
  'Billow',
  'Cinder',
  'Drift',
  'Ember',
  'Flint',
  'Gale',
  'Haze',
  'Ivy',
  'Jasper',
  'Kestrel',
  'Lumen',
  'Marrow',
  'Nettle',
  'Oath',
  'Pike',
];

function emptyVehicle(chassis = BASIC_WAGON): Vehicle {
  const slots: SlotState[] = chassis.slots.map((def) => ({ def, occupant: null }));
  return { id: 'veh-1', chassisId: chassis.id, slots };
}

function pickName(rng: () => number, used: Set<string>): string {
  for (let i = 0; i < 32; i++) {
    const name = FIRST_NAMES[Math.floor(rng() * FIRST_NAMES.length)]!;
    if (!used.has(name)) {
      used.add(name);
      return name;
    }
  }
  const fallback = `Traveller-${used.size + 1}`;
  used.add(fallback);
  return fallback;
}

/**
 * Session 2 start state: 2 characters + basic wagon pulled by a crabbeast.
 * Deterministic from seed.
 */
export function makeStartingCaravan(seed: string | number = 'start'): Caravan {
  resetInstanceIds(1);
  const seedNum = typeof seed === 'number' ? seed : hashString(String(seed));
  const rng = mulberry32(seedNum);
  const used = new Set<string>();

  const vehicle = emptyVehicle();
  const caravan: Caravan = {
    id: 'caravan-1',
    name: 'Starting caravan',
    form: Form.caravan,
    origin: { col: 0, row: 0 },
    legs: [],
    generation: 0,
    vehicles: [vehicle],
  };

  const mount = spawnFromCatalog('crabbeast');
  const r0 = fit(caravan, vehicle.id, 0, mount);
  if (!r0.ok) throw new Error(r0.reason);

  for (let i = 1; i <= 4; i++) {
    const wheel = spawnFromCatalog('basic_wheel');
    const r = fit(caravan, vehicle.id, i, wheel);
    if (!r.ok) throw new Error(r.reason);
  }

  const templates = ['wanderer', 'hand'] as const;
  for (let i = 0; i < 2; i++) {
    const name = pickName(rng, used);
    const char = spawnFromCatalog(templates[i]!, name);
    const r = fit(caravan, vehicle.id, 5 + i, char);
    if (!r.ok) throw new Error(r.reason);
  }

  const chest = spawnFromCatalog('cargo_chest');
  const rChest = fit(caravan, vehicle.id, 9, chest);
  if (!rChest.ok) throw new Error(rChest.reason);

  return caravan;
}

export function emptyCaravan(chassisId = BASIC_WAGON.id): Caravan {
  resetInstanceIds(1);
  if (chassisId !== BASIC_WAGON.id) {
    throw new Error(`unknown chassis: ${chassisId}`);
  }
  return {
    id: 'caravan-1',
    name: 'Empty caravan',
    form: Form.caravan,
    origin: { col: 0, row: 0 },
    legs: [],
    generation: 0,
    vehicles: [emptyVehicle()],
  };
}
