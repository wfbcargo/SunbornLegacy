/**
 * In-memory world region for the caravan manager — couples travel to biomes.
 */

import { hashString } from '../sim/rng.ts';
import { World } from '../sim/world.ts';
import type { TileCoord } from './types.ts';
import { tileKey } from './path.ts';
import { fertilityOf, moveCost, passable, biomeDef } from './terrain.ts';

export const REGION_WIDTH = 24;
export const REGION_HEIGHT = 16;

export interface Region {
  seed: string;
  world: World;
  width: number;
  height: number;
  spawn: TileCoord;
  /** tileKey → caravan id claiming the tile (one settlement per tile). */
  settlements: Map<string, string>;
}

export function biomeAt(region: Region, t: TileCoord): number {
  const i = region.world.grid.index(t.col, t.row);
  return region.world.biome[i]!;
}

function findSpawn(world: World): TileCoord {
  // Prefer grassland-class fertility ≥ 2 near centre, else any passable.
  const cx = (world.grid.width / 2) | 0;
  const cy = (world.grid.height / 2) | 0;
  let fallback: TileCoord | null = null;
  for (let radius = 0; radius < Math.max(world.grid.width, world.grid.height); radius++) {
    for (let dr = -radius; dr <= radius; dr++) {
      for (let dc = -radius; dc <= radius; dc++) {
        if (radius > 0 && Math.max(Math.abs(dc), Math.abs(dr)) !== radius) continue;
        const col = cx + dc;
        const row = cy + dr;
        if (col < 0 || row < 0 || col >= world.grid.width || row >= world.grid.height) {
          continue;
        }
        const id = world.biome[world.grid.index(col, row)]!;
        if (!passable(id)) continue;
        const tile = { col, row };
        if (fertilityOf(id) >= 2) return tile;
        if (!fallback) fallback = tile;
      }
    }
  }
  if (fallback) return fallback;
  throw new Error('region has no passable spawn tile');
}

export function makeRegion(seed: string | number = 'lab'): Region {
  const seedStr = String(seed);
  const world = new World({
    width: REGION_WIDTH,
    height: REGION_HEIGHT,
    seed: typeof seed === 'number' ? seed : hashString(seedStr),
    cycles: [],
  });
  const spawn = findSpawn(world);
  return {
    seed: seedStr,
    world,
    width: REGION_WIDTH,
    height: REGION_HEIGHT,
    spawn,
    settlements: new Map(),
  };
}

export function claimSettlement(
  region: Region,
  tile: TileCoord,
  caravanId: string,
): { ok: true } | { ok: false; reason: string } {
  const key = tileKey(tile);
  const owner = region.settlements.get(key);
  if (owner && owner !== caravanId) {
    return { ok: false, reason: `tile ${key} already settled by ${owner}` };
  }
  region.settlements.set(key, caravanId);
  return { ok: true };
}

export function freeSettlement(
  region: Region,
  tile: TileCoord,
  caravanId: string,
): void {
  const key = tileKey(tile);
  if (region.settlements.get(key) === caravanId) {
    region.settlements.delete(key);
  }
}

export function serializeMap(region: Region): {
  width: number;
  height: number;
  seed: string;
  day: number;
  tiles: Array<{
    col: number;
    row: number;
    biome: string;
    glyph: string;
    passable: boolean;
    cost: number;
    fertility: number;
    settledBy: string | null;
  }>;
} {
  const tiles = [];
  for (let row = 0; row < region.height; row++) {
    for (let col = 0; col < region.width; col++) {
      const id = biomeAt(region, { col, row });
      const def = biomeDef(id);
      const key = tileKey({ col, row });
      tiles.push({
        col,
        row,
        biome: def?.key ?? `id${id}`,
        glyph: def?.glyph ?? '?',
        passable: passable(id),
        cost: moveCost(id),
        fertility: fertilityOf(id),
        settledBy: region.settlements.get(key) ?? null,
      });
    }
  }
  return {
    width: region.width,
    height: region.height,
    seed: region.seed,
    day: region.world.day,
    tiles,
  };
}

/** Max move-cost along path edges (destination tile of each step). */
export function pathMaxCost(
  region: Region,
  tiles: readonly TileCoord[],
): { ok: true; maxCost: number } | { ok: false; reason: string } {
  let maxCost = 1;
  for (const t of tiles) {
    const id = biomeAt(region, t);
    if (!passable(id)) {
      const def = biomeDef(id);
      return {
        ok: false,
        reason: `impassable tile ${tileKey(t)} (${def?.key ?? id})`,
      };
    }
    maxCost = Math.max(maxCost, moveCost(id));
  }
  return { ok: true, maxCost };
}
