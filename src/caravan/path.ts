/**
 * Pathfinding board helpers — odd-r pointy-top.
 * Supports non-wrapping lab bounds or toroidal wrap (live World).
 */

import type { TileCoord } from './types.ts';

/** @deprecated Prefer region width/height — kept for callers during cutover. */
export const LAB_WIDTH = 24;
export const LAB_HEIGHT = 16;

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

export type GridOpts = {
  width: number;
  height: number;
  /** Toroidal wrap (World). Default false. */
  wrap?: boolean;
};

function wrapCoord(v: number, span: number): number {
  return ((v % span) + span) % span;
}

export function tileKey(t: TileCoord): string {
  return `${t.col},${t.row}`;
}

export function tilesEqual(a: TileCoord, b: TileCoord): boolean {
  return a.col === b.col && a.row === b.row;
}

export function inBounds(t: TileCoord, opts: GridOpts): boolean {
  if (opts.wrap) return true;
  return t.col >= 0 && t.col < opts.width && t.row >= 0 && t.row < opts.height;
}

export function normalizeTile(t: TileCoord, opts: GridOpts): TileCoord {
  if (!opts.wrap) return { col: t.col, row: t.row };
  return {
    col: wrapCoord(t.col, opts.width),
    row: wrapCoord(t.row, opts.height),
  };
}

export function neighboursOf(t: TileCoord, opts: GridOpts): TileCoord[] {
  const parity = t.row & 1;
  const deltas = ODD_R_NEIGHBOURS[parity]!;
  const out: TileCoord[] = [];
  for (const [dc, dr] of deltas) {
    const raw = { col: t.col + dc, row: t.row + dr };
    if (opts.wrap) {
      out.push(normalizeTile(raw, opts));
    } else if (inBounds(raw, opts)) {
      out.push(raw);
    }
  }
  return out;
}

export function areNeighbours(a: TileCoord, b: TileCoord, opts: GridOpts): boolean {
  const nb = normalizeTile(b, opts);
  return neighboursOf(a, opts).some((n) => tilesEqual(n, nb));
}

/** Every consecutive pair must be odd-r neighbours; all tiles in bounds (or wrapped). */
export function validatePath(
  tiles: readonly TileCoord[],
  opts: GridOpts,
): { ok: true } | { ok: false; reason: string } {
  if (tiles.length < 2) {
    return { ok: false, reason: 'path needs at least two tiles (departure and destination)' };
  }
  const norm = tiles.map((t) => normalizeTile(t, opts));
  for (let i = 0; i < norm.length; i++) {
    const t = norm[i]!;
    if (!opts.wrap && !inBounds(t, opts)) {
      return {
        ok: false,
        reason: `tile ${tileKey(t)} is out of bounds (${opts.width}×${opts.height})`,
      };
    }
    if (i > 0) {
      const prev = norm[i - 1]!;
      if (!areNeighbours(prev, t, opts)) {
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
