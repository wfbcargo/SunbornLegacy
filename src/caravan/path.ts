import type { TileCoord } from './types.ts';

/** Lab / pathfinding board — odd-r pointy-top, non-wrapping. */
export const LAB_WIDTH = 8;
export const LAB_HEIGHT = 6;

/** Neighbour deltas [dcol, drow] by row parity (odd-r). */
const ODD_R_NEIGHBOURS: readonly (readonly (readonly [number, number])[])[] = [
  [
    [+1, 0],
    [0, -1],
    [-1, -1],
    [-1, 0],
    [-1, +1],
    [0, +1],
  ],
  [
    [+1, 0],
    [+1, -1],
    [0, -1],
    [-1, 0],
    [0, +1],
    [+1, +1],
  ],
];

export function tileKey(t: TileCoord): string {
  return `${t.col},${t.row}`;
}

export function tilesEqual(a: TileCoord, b: TileCoord): boolean {
  return a.col === b.col && a.row === b.row;
}

export function inBounds(
  t: TileCoord,
  width = LAB_WIDTH,
  height = LAB_HEIGHT,
): boolean {
  return t.col >= 0 && t.col < width && t.row >= 0 && t.row < height;
}

export function neighboursOf(
  t: TileCoord,
  width = LAB_WIDTH,
  height = LAB_HEIGHT,
): TileCoord[] {
  const parity = t.row & 1;
  const deltas = ODD_R_NEIGHBOURS[parity]!;
  const out: TileCoord[] = [];
  for (const [dc, dr] of deltas) {
    const n = { col: t.col + dc, row: t.row + dr };
    if (inBounds(n, width, height)) out.push(n);
  }
  return out;
}

export function areNeighbours(a: TileCoord, b: TileCoord): boolean {
  return neighboursOf(a).some((n) => tilesEqual(n, b));
}

/** Every consecutive pair must be odd-r neighbours; all tiles in bounds. */
export function validatePath(
  tiles: readonly TileCoord[],
  width = LAB_WIDTH,
  height = LAB_HEIGHT,
): { ok: true } | { ok: false; reason: string } {
  if (tiles.length < 2) {
    return { ok: false, reason: 'path needs at least two tiles (departure and destination)' };
  }
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i]!;
    if (!inBounds(t, width, height)) {
      return {
        ok: false,
        reason: `tile ${tileKey(t)} is out of bounds (${width}×${height})`,
      };
    }
    if (i > 0) {
      const prev = tiles[i - 1]!;
      if (!areNeighbours(prev, t)) {
        return {
          ok: false,
          reason: `path break: ${tileKey(prev)} is not adjacent to ${tileKey(t)}`,
        };
      }
    }
  }
  return { ok: true };
}

export function parsePath(spec: string): TileCoord[] | { error: string } {
  const parts = spec.split(':').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return { error: 'empty path' };
  const tiles: TileCoord[] = [];
  for (const part of parts) {
    const [cs, rs] = part.split(',');
    const col = Number(cs);
    const row = Number(rs);
    if (!Number.isInteger(col) || !Number.isInteger(row)) {
      return { error: `bad tile "${part}" — expected col,row integers` };
    }
    tiles.push({ col, row });
  }
  return tiles;
}
