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

/** odd-r offset → cube coordinates. */
function cubeFromOffset(col: number, row: number): [number, number, number] {
  const q = col - ((row - (row & 1)) >> 1);
  const r = row;
  return [q, r, -q - r];
}
