import { deriveStats } from './derive.ts';
import { tilesEqual, validatePath } from './path.ts';
import {
  Form,
  LegState,
  type Caravan,
  type CaravanLeg,
  type LegResult,
  type PositionAt,
  type TileCoord,
} from './types.ts';

function cloneTile(t: TileCoord): TileCoord {
  return { col: t.col, row: t.row };
}

function legDurationTicks(leg: CaravanLeg): number {
  return Math.max(0, leg.tiles.length - 1) * leg.ticksPerTile;
}

function legEndStep(leg: CaravanLeg): number {
  return leg.startStep + legDurationTicks(leg);
}

/** Pure position from origin + committed legs. */
export function positionAt(caravan: Caravan, step: number): PositionAt {
  let tile = cloneTile(caravan.origin);
  let travelling = false;
  let legSeq: number | null = null;
  let tileIndex = 0;

  for (const leg of caravan.legs) {
    if (leg.state === LegState.stalled) {
      // Stalled legs keep their (possibly truncated) final tile as the park point.
      const last = leg.tiles[leg.tiles.length - 1];
      if (last) {
        tile = cloneTile(last);
        tileIndex = leg.tiles.length - 1;
        legSeq = leg.seq;
      }
      travelling = false;
      continue;
    }

    if (step < leg.startStep) {
      break;
    }

    const maxIdx = leg.tiles.length - 1;
    const elapsed = step - leg.startStep;
    const idx = Math.min(Math.floor(elapsed / leg.ticksPerTile), maxIdx);
    const here = leg.tiles[idx];
    if (here) {
      tile = cloneTile(here);
      tileIndex = idx;
      legSeq = leg.seq;
    }

    if (step < legEndStep(leg)) {
      travelling = true;
      break;
    }

    // Arrived — park on last tile; continue to later legs if any.
    travelling = false;
    const last = leg.tiles[maxIdx];
    if (last) {
      tile = cloneTile(last);
      tileIndex = maxIdx;
      legSeq = leg.seq;
    }
  }

  return { tile, travelling, legSeq, tileIndex };
}

export function commitLeg(
  caravan: Caravan,
  tiles: readonly TileCoord[],
  startStep: number,
): LegResult {
  if (caravan.form !== Form.caravan) {
    return { ok: false, reason: 'cannot travel while settled as an outpost; mobilise first' };
  }
  const stats = deriveStats(caravan);
  if (!stats.mobile) {
    return { ok: false, reason: 'caravan is not mobile' };
  }
  if (stats.ticksPerTile == null) {
    return { ok: false, reason: 'no speed: fit a mount or character before committing a route' };
  }

  const pathCheck = validatePath(tiles);
  if (!pathCheck.ok) return pathCheck;

  const atStart = positionAt(caravan, startStep);
  if (atStart.travelling) {
    return {
      ok: false,
      reason: `still travelling at step ${startStep}; wait until arrival before committing another leg`,
    };
  }
  if (!tilesEqual(atStart.tile, tiles[0]!)) {
    return {
      ok: false,
      reason:
        `path must start at current tile ${atStart.tile.col},${atStart.tile.row}; ` +
        `got ${tiles[0]!.col},${tiles[0]!.row}`,
    };
  }

  const seq = caravan.legs.length === 0
    ? 0
    : Math.max(...caravan.legs.map((l) => l.seq)) + 1;

  const leg: CaravanLeg = {
    seq,
    tiles: tiles.map(cloneTile),
    ticksPerTile: stats.ticksPerTile,
    startStep,
    state: LegState.committed,
  };
  caravan.legs.push(leg);
  return { ok: true, leg };
}

/**
 * Interrupt travel at `step`: truncate the active committed leg to the tile held
 * now and mark it stalled. Finished legs are left alone.
 */
export function stallAt(caravan: Caravan, step: number): LegResult | { ok: true; leg: null } {
  const pos = positionAt(caravan, step);
  if (!pos.travelling || pos.legSeq == null) {
    return { ok: true, leg: null };
  }
  const leg = caravan.legs.find((l) => l.seq === pos.legSeq);
  if (!leg || leg.state === LegState.stalled) {
    return { ok: true, leg: null };
  }
  leg.tiles = leg.tiles.slice(0, pos.tileIndex + 1).map(cloneTile);
  leg.state = LegState.stalled;
  return { ok: true, leg };
}

export function formatTile(t: TileCoord): string {
  return `${t.col},${t.row}`;
}
