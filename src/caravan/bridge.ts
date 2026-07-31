/**
 * Battle bridge — caravan Side-A deploy → battle engagement vs canned raid.
 *
 * One-way: caravan imports battle; battle never imports caravan.
 */

import { Arena, heightForForce } from '../battle/arena.ts';
import {
  assessEngagement,
  DEFAULT_MAX_ROUNDS,
  runEngagement,
  type Assessment,
} from '../battle/engagement.ts';
import {
  isTemplateId,
  MIX_RAID,
  resetFighterIds,
  spawn,
  type TemplateId,
} from '../battle/roster.ts';
import { generateTerrain } from '../battle/terrain.ts';
import { Side, type EngagementResult, type Fighter } from '../battle/types.ts';
import { positionAt } from './legs.ts';
import type { Region } from './region.ts';
import { biomeDef } from './terrain.ts';
import type { Caravan, FitResult, Occupant } from './types.ts';
import { OccupantKind } from './types.ts';

/** Catalog character id → battle combat template. */
export const CATALOG_TO_TEMPLATE: Record<string, TemplateId> = {
  wanderer: 'reedstep',
  hand: 'wagonram',
};

export type BridgeOk = { ok: true; fighters: Fighter[]; battleId: string };
export type BridgeErr = { ok: false; reason: string };
export type BridgeResult = BridgeOk | BridgeErr;

export interface SkirmishContext {
  region?: Region;
  /** World clock step — used with region to pick the fight tile's biome. */
  step?: number;
}

function findCharacter(caravan: Caravan, instanceId: string): Occupant | null {
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

function templateFor(character: Occupant): TemplateId | null {
  if (character.armor) return 'ashplate';
  const id = CATALOG_TO_TEMPLATE[character.catalogId];
  if (id && isTemplateId(id)) return id;
  return null;
}

/**
 * Build Side A from caravan deploy + equal-count Side B from MIX_RAID.
 */
export function buildSkirmish(
  caravan: Caravan,
  battleId = `skirmish:${caravan.id}`,
): BridgeResult {
  const placements = caravan.deploy.placements;
  if (placements.length === 0) {
    return { ok: false, reason: 'no deploy placements; place characters first' };
  }

  resetFighterIds(1);
  const fighters: Fighter[] = [];
  const seen = new Set<string>();

  for (const p of placements) {
    const key = `${p.col},${p.row}`;
    if (seen.has(key)) {
      return { ok: false, reason: `duplicate deploy cell ${key}` };
    }
    seen.add(key);

    const character = findCharacter(caravan, p.characterInstanceId);
    if (!character) {
      return {
        ok: false,
        reason: `placed character ${p.characterInstanceId} is not fitted`,
      };
    }
    const templateId = templateFor(character);
    if (!templateId) {
      return {
        ok: false,
        reason:
          `no combat template for catalog "${character.catalogId}" ` +
          `(known: ${Object.keys(CATALOG_TO_TEMPLATE).join(', ')})`,
      };
    }
    fighters.push(
      spawn(templateId, Side.A, p.col, p.row, character.name),
    );
  }

  const n = placements.length;
  const bCols = [6, 7, 8, 9] as const;
  // Front-loaded: col 6 first, successive rows.
  for (let i = 0; i < n; i++) {
    const row = (i / bCols.length) | 0;
    const col = bCols[i % bCols.length]!;
    const templateId = MIX_RAID[i % MIX_RAID.length]!;
    fighters.push(spawn(templateId, Side.B, col, row, `Raid-${i + 1}`));
  }

  return { ok: true, fighters, battleId };
}

function engagementOpts(
  caravan: Caravan,
  battleId: string | undefined,
  maxRounds: number,
  ctx?: SkirmishContext,
) {
  const built = buildSkirmish(caravan, battleId);
  if (!built.ok) return built;

  const a = built.fighters.filter((f) => f.side === Side.A).length;
  const b = built.fighters.filter((f) => f.side === Side.B).length;
  const height = heightForForce(a, b);
  const arena = new Arena(height);

  let terrain = null;
  const region = ctx?.region;
  if (region) {
    const step = ctx?.step ?? 0;
    const tile = positionAt(caravan, step).tile;
    const tileIndex = region.world.grid.index(tile.col, tile.row);
    const biomeId = region.world.biome[tileIndex]!;
    const def = biomeDef(biomeId);
    terrain = generateTerrain({
      biomeKey: def?.key ?? 'open',
      battleId: built.battleId,
      tileIndex,
      width: arena.width,
      height: arena.height,
    });
  }

  return {
    ok: true as const,
    opts: {
      engagementId: built.battleId,
      title: `${caravan.name} skirmish`,
      fighters: built.fighters,
      arena,
      terrain,
      maxRounds,
    },
  };
}

export function skirmish(
  caravan: Caravan,
  battleId?: string,
  maxRounds = DEFAULT_MAX_ROUNDS,
  ctx?: SkirmishContext,
): FitResult & { engagement?: EngagementResult } {
  const built = engagementOpts(caravan, battleId, maxRounds, ctx);
  if (!built.ok) return { ok: false, reason: built.reason };

  const engagement = runEngagement(built.opts);
  return { ok: true, engagement };
}

export function assessSkirmish(
  caravan: Caravan,
  battleId?: string,
  maxRounds = DEFAULT_MAX_ROUNDS,
  ctx?: SkirmishContext,
): FitResult & { assess?: Assessment } {
  const built = engagementOpts(caravan, battleId, maxRounds, ctx);
  if (!built.ok) return { ok: false, reason: built.reason };

  const assess = assessEngagement(built.opts);
  return { ok: true, assess };
}
