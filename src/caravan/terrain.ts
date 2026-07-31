/**
 * Terrain rules for caravan travel / farming — derived from biome ids.
 * Does not mutate the World.
 */

import { BIOMES, Biome, type Biome as BiomeId } from '../sim/biomes.ts';

const BY_ID = new Map(BIOMES.map((b) => [b.id, b]));

export function biomeDef(id: number) {
  return BY_ID.get(id as BiomeId);
}

/** True sea or molten lava — wagons cannot enter. */
export function passable(biomeId: number): boolean {
  const def = biomeDef(biomeId);
  if (!def) return false;
  if (def.molten) return false;
  if (def.water && !def.molten) return false; // ocean / shallows / frozen sea
  return true;
}

/**
 * Move-cost multiplier (≥1). Applied to base ticksPerTile.
 * Glacier / mountain / rock are slow; grassland is 1.
 */
export function moveCost(biomeId: number): number {
  if (!passable(biomeId)) return 99;
  switch (biomeId) {
    case Biome.Grassland:
    case Biome.Savanna:
    case Biome.Soil:
    case Biome.Bloom:
    case Biome.Barren:
    case Biome.Ash:
      return 1;
    case Biome.Forest:
    case Biome.Marsh:
    case Biome.Swamp:
    case Biome.Tundra:
    case Biome.Desert:
    case Biome.River:
      return 2;
    case Biome.Rainforest:
    case Biome.Badlands:
    case Biome.Rock:
    case Biome.Basalt:
    case Biome.Glass:
      return 3;
    case Biome.Mountain:
    case Biome.Glacier:
      return 4;
    default:
      return 2;
  }
}

/**
 * Farm fertility 0…3. Lookup only — no depleting soil channel yet.
 * Spec 60e8f1a2.
 */
export function fertilityOf(biomeId: number): number {
  switch (biomeId) {
    case Biome.Soil:
    case Biome.Bloom:
      return 3;
    case Biome.Grassland:
    case Biome.Savanna:
    case Biome.Forest:
    case Biome.Rainforest:
    case Biome.Marsh:
    case Biome.Swamp:
      return 2;
    case Biome.Tundra:
    case Biome.River:
    case Biome.Ash:
      return 1;
    default:
      return 0;
  }
}

export function canFarm(biomeId: number): boolean {
  return fertilityOf(biomeId) > 0;
}
