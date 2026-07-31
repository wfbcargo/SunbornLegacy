/**
 * Biome → arena hex features (Session 12 / spec a1e9b472).
 *
 * Deterministic from battleId + biomeKey + tileIndex + cell.
 * No I/O; does not step the world.
 */

import { hashString, rollAt } from '../sim/rng.ts';
import { DEPLOY_A_COLS, DEPLOY_B_COLS } from './arena.ts';

export const HexFeature = {
  open: 0,
  cover: 1,
  mud: 2,
  block: 3,
  high: 4,
} as const;
export type HexFeature = (typeof HexFeature)[keyof typeof HexFeature];

export const COVER_DODGE_BONUS = 0.15;
export const MAX_DODGE = 0.95;
/** Extra turns added to moveReadyIn after ending a move on mud. */
export const MUD_MOVE_EXTRA = 1;
/** High ground extends abilities that already have range ≥ 2. */
export const HIGH_RANGE_BONUS = 1;

const PURPOSE_TERRAIN = hashString('arena:terrain');

export interface TerrainField {
  biomeKey: string;
  tileIndex: number;
  battleId: string;
  width: number;
  height: number;
  /** One HexFeature per cell, row-major. */
  features: Uint8Array;
}

export interface GenerateTerrainOpts {
  biomeKey: string;
  battleId: string;
  tileIndex?: number;
  width: number;
  height: number;
}

/** Profile densities — interpreted as P(feature) on eligible cells. */
interface Profile {
  cover: number;
  mud: number;
  /** Only on non-deploy cells. */
  block: number;
  high: number;
}

const OPEN: Profile = { cover: 0, mud: 0, block: 0, high: 0 };
const LIGHT_COVER: Profile = { cover: 0.08, mud: 0, block: 0, high: 0 };
const FOREST: Profile = { cover: 0.28, mud: 0, block: 0, high: 0 };
const WET: Profile = { cover: 0.04, mud: 0.45, block: 0, high: 0 };
const STONE: Profile = { cover: 0.05, mud: 0, block: 0.12, high: 0.22 };

const PROFILE_BY_KEY: Record<string, Profile> = {
  forest: FOREST,
  rainforest: FOREST,
  glass: OPEN,
  desert: OPEN,
  barren: OPEN,
  ash: OPEN,
  mountain: STONE,
  rock: STONE,
  basalt: STONE,
  badlands: STONE,
  marsh: WET,
  swamp: WET,
  river: WET,
  grassland: LIGHT_COVER,
  savanna: LIGHT_COVER,
  soil: LIGHT_COVER,
  bloom: LIGHT_COVER,
  tundra: LIGHT_COVER,
};

function profileFor(biomeKey: string): Profile {
  return PROFILE_BY_KEY[biomeKey] ?? OPEN;
}

function isDeployCol(col: number): boolean {
  return (
    (DEPLOY_A_COLS as readonly number[]).includes(col) ||
    (DEPLOY_B_COLS as readonly number[]).includes(col)
  );
}

/**
 * Build a terrain field. Deploy columns never receive `block`.
 */
export function generateTerrain(opts: GenerateTerrainOpts): TerrainField {
  const tileIndex = opts.tileIndex ?? 0;
  const { biomeKey, battleId, width, height } = opts;
  const size = width * height;
  const features = new Uint8Array(size);
  const battleKey = hashString(battleId);
  const biomeHash = hashString(biomeKey);
  const profile = profileFor(biomeKey);

  for (let cell = 0; cell < size; cell++) {
    const col = cell % width;
    const deploy = isDeployCol(col);
    const roll = rollAt(battleKey, tileIndex, biomeHash, PURPOSE_TERRAIN, cell);
    let cursor = 0;
    let feature: HexFeature = HexFeature.open;

    const tryPick = (p: number, kind: HexFeature): boolean => {
      if (p <= 0) return false;
      cursor += p;
      if (roll < cursor) {
        feature = kind;
        return true;
      }
      return false;
    };

    if (!deploy && tryPick(profile.block, HexFeature.block)) {
      // blocked
    } else if (tryPick(profile.high, HexFeature.high)) {
      // high
    } else if (tryPick(profile.mud, HexFeature.mud)) {
      // mud
    } else if (tryPick(profile.cover, HexFeature.cover)) {
      // cover
    } else {
      feature = HexFeature.open;
    }

    features[cell] = feature;
  }

  return { biomeKey, tileIndex, battleId, width, height, features };
}

/** All-open field — same outcomes as pre-terrain battles. */
export function openTerrain(
  battleId: string,
  width: number,
  height: number,
  biomeKey = 'open',
): TerrainField {
  return {
    biomeKey,
    tileIndex: 0,
    battleId,
    width,
    height,
    features: new Uint8Array(width * height),
  };
}

export function featureAt(field: TerrainField, cell: number): HexFeature {
  if (cell < 0 || cell >= field.features.length) return HexFeature.open;
  return field.features[cell]! as HexFeature;
}

export function featureName(f: HexFeature): string {
  switch (f) {
    case HexFeature.cover:
      return 'cover';
    case HexFeature.mud:
      return 'mud';
    case HexFeature.block:
      return 'block';
    case HexFeature.high:
      return 'high';
    default:
      return 'open';
  }
}

/** Compact counts for CLI / API. */
export function terrainSummary(field: TerrainField): string {
  const counts = { open: 0, cover: 0, mud: 0, block: 0, high: 0 };
  for (let i = 0; i < field.features.length; i++) {
    counts[featureName(field.features[i]! as HexFeature) as keyof typeof counts]++;
  }
  return (
    `terrain ${field.biomeKey}@tile${field.tileIndex}: ` +
    `open ${counts.open} cover ${counts.cover} mud ${counts.mud} ` +
    `block ${counts.block} high ${counts.high}`
  );
}

export function effectiveDodge(base: number, field: TerrainField | null, cell: number): number {
  let d = base;
  if (field && featureAt(field, cell) === HexFeature.cover) d += COVER_DODGE_BONUS;
  if (d > MAX_DODGE) d = MAX_DODGE;
  if (d < 0) d = 0;
  return d;
}

export function effectiveAbilityRange(
  baseRange: number,
  field: TerrainField | null,
  attackerCell: number,
): number {
  if (baseRange < 2 || !field) return baseRange;
  if (featureAt(field, attackerCell) === HexFeature.high) {
    return baseRange + HIGH_RANGE_BONUS;
  }
  return baseRange;
}
