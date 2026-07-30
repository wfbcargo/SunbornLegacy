/**
 * Toroidal hex grid.
 *
 * Storage is odd-r offset coordinates (pointy-top hexes; odd rows shifted right),
 * wrapping on BOTH axes. Every tile has exactly 6 neighbours, there are no poles,
 * and there are no special cases — which keeps neighbour lookups, the solar sweep,
 * and pathfinding free of the 12-pentagon exceptions a true hex globe would require.
 *
 * Height MUST be even, or row parity flips across the wrap seam and the northern
 * edge stitches to the southern edge incorrectly.
 */

/** Neighbour deltas as [dcol, drow], indexed by row parity. */
const ODD_R_NEIGHBOURS: readonly (readonly (readonly [number, number])[])[] = [
  // even rows
  [
    [+1, 0],
    [0, -1],
    [-1, -1],
    [-1, 0],
    [-1, +1],
    [0, +1],
  ],
  // odd rows
  [
    [+1, 0],
    [+1, -1],
    [0, -1],
    [-1, 0],
    [0, +1],
    [+1, +1],
  ],
];

export class HexTorus {
  readonly width: number;
  readonly height: number;
  readonly size: number;

  /** Flat neighbour table: 6 tile indices per tile, precomputed once. */
  private readonly neighbours: Int32Array;

  constructor(width: number, height: number) {
    if (height % 2 !== 0) {
      throw new Error(`Torus height must be even (got ${height}) or row parity breaks at the seam.`);
    }
    this.width = width;
    this.height = height;
    this.size = width * height;
    this.neighbours = new Int32Array(this.size * 6);
    this.buildNeighbourTable();
  }

  index(col: number, row: number): number {
    const c = ((col % this.width) + this.width) % this.width;
    const r = ((row % this.height) + this.height) % this.height;
    return r * this.width + c;
  }

  col(index: number): number {
    return index % this.width;
  }

  row(index: number): number {
    return (index / this.width) | 0;
  }

  /**
   * Six neighbour indices for a tile, written into `out`.
   * Precomputed, so this is a copy rather than a calculation.
   */
  neighboursOf(index: number, out: Int32Array): void {
    const base = index * 6;
    for (let i = 0; i < 6; i++) out[i] = this.neighbours[base + i]!;
  }

  /** Direct indexed access to the neighbour table, for hot loops. */
  neighbourAt(index: number, direction: number): number {
    return this.neighbours[index * 6 + direction]!;
  }

  /**
   * Shortest distance between two tiles, accounting for wrap in both directions.
   * Not on the hot path — used for region analysis and, later, travel estimates.
   */
  distance(a: number, b: number): number {
    const [aq, ar, as] = this.toCube(a);
    let best = Infinity;
    // Try every wrap combination and keep the shortest.
    for (const dc of [-this.width, 0, this.width]) {
      for (const dr of [-this.height, 0, this.height]) {
        const bCol = this.col(b) + dc;
        const bRow = this.row(b) + dr;
        const [bq, br, bs] = cubeFromOffset(bCol, bRow);
        const d = (Math.abs(aq - bq) + Math.abs(ar - br) + Math.abs(as - bs)) / 2;
        if (d < best) best = d;
      }
    }
    return best;
  }

  private toCube(index: number): [number, number, number] {
    return cubeFromOffset(this.col(index), this.row(index));
  }

  private buildNeighbourTable(): void {
    for (let row = 0; row < this.height; row++) {
      const deltas = ODD_R_NEIGHBOURS[row & 1]!;
      for (let col = 0; col < this.width; col++) {
        const self = row * this.width + col;
        for (let d = 0; d < 6; d++) {
          const [dc, dr] = deltas[d]!;
          this.neighbours[self * 6 + d] = this.index(col + dc, row + dr);
        }
      }
    }
  }
}

/**
 * The horizontal position of a tile's centre, in column-spacing units.
 *
 * Odd rows are shifted right by half a column (odd-r), so a tile's x is `col` on even
 * rows and `col + 0.5` on odd ones. This is the ONE fact that turns hex distance into
 * arithmetic instead of a cube-coordinate conversion — see `hexDistanceToPoint`.
 */
export function hexX(col: number, row: number): number {
  return col + 0.5 * (row & 1);
}

/**
 * Hex distance from a tile to an arbitrary point on the torus.
 *
 * ★ WHY A POINT AND NOT A TILE. The travelling beam's centre moves several columns and
 * tens of rows in a day, so its position within a day is a continuous arc, not a tile.
 * A tile-to-tile distance would force the arc to be rounded before it is measured, and
 * rounding a track that is thinner than its own daily step is how a swept blob becomes
 * a row of disjoint clumps.
 *
 * The closed form. For pointy-top hexes, distance from a horizontal offset `dx` (in
 * column units) and a vertical offset `dy` (in rows) is
 *
 *     max(|dx| + |dy| / 2, |dy|)
 *
 * — the second term is the pure-vertical case, where each row of travel already buys
 * half a column of horizontal reach for free, and the first is everything else. On
 * integer tile coordinates it agrees exactly with the cube-coordinate formula
 * `(|dq| + |dr| + |ds|) / 2` that `distance()` uses; on fractional points it is the
 * natural continuous extension, which the cube form does not have.
 *
 * ★ WRAP IS EXACT, not approximated, under one stated condition. The x-wrap is exact
 * unconditionally: the expression is monotone in `|dx|`, so the shortest horizontal
 * offset is always the best one. The y-wrap is exact whenever the distance being tested
 * is under `height / 2`, because going the other way round the torus costs at least
 * `height - |dy| >= height / 2` rows. Callers that care — the blob beam — are held to
 * `2 * radius + 1 < min(width, height)` by `limits.ts` precisely so this holds.
 */
export function hexDistanceToPoint(
  col: number,
  row: number,
  x: number,
  y: number,
  width: number,
  height: number,
): number {
  return hexDistanceWithin(col, row, x, y, width, height, Infinity);
}

/**
 * `hexDistanceToPoint`, with a cutoff — returns `Infinity` rather than a distance the
 * caller has already decided is too far.
 *
 * This exists for the swept blob beam, which asks the same question of one tile against
 * ~100 points along a day's arc and only ever wants the smallest answer. Because the
 * distance is never less than `|dy|`, a tile whose ROW offset alone exceeds the limit
 * can be discarded before its column offset is even computed — one subtract and one
 * compare instead of the full form. With the limit tightened to the best distance seen
 * so far, most of an arc is rejected on that first test.
 *
 * It is the same arithmetic as the plain form, not a second copy of it: the plain form
 * calls this with no limit. A separate "fast path" would be a second implementation of
 * the geometry, free to agree with itself while disagreeing with the simulator.
 */
export function hexDistanceWithin(
  col: number,
  row: number,
  x: number,
  y: number,
  width: number,
  height: number,
  limit: number,
): number {
  let dy = row - y;
  if (dy > height / 2) dy -= height;
  else if (dy < -height / 2) dy += height;
  if (dy < 0) dy = -dy;
  if (dy > limit) return Infinity;

  let dx = hexX(col, row) - x;
  if (dx > width / 2) dx -= width;
  else if (dx < -width / 2) dx += width;
  if (dx < 0) dx = -dx;

  const diagonal = dx + dy * 0.5;
  const d = diagonal > dy ? diagonal : dy;
  return d > limit ? Infinity : d;
}

/** odd-r offset → cube coordinates. */
function cubeFromOffset(col: number, row: number): [number, number, number] {
  const q = col - ((row - (row & 1)) >> 1);
  const r = row;
  return [q, r, -q - r];
}
