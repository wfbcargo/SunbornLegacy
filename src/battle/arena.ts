/**
 * Bounded hex arena for combat — odd-r pointy-top, NO wrap.
 *
 * Width stays 10 (deploy 4 / neutral 2 / deploy 4). Height grows with force
 * size so a side can pack four columns deep: heightForSideCount(100) === 25.
 */

export const ARENA_WIDTH = 10;
/** Default skirmish depth — small authored scenarios. */
export const ARENA_HEIGHT_DEFAULT = 6;
/** Hard cap so a mis-click cannot allocate a million-cell board. */
export const ARENA_HEIGHT_MAX = 64;

/** Side A deploys in cols 0–3; neutral 4–5; side B in 6–9. */
export const DEPLOY_A_COLS = [0, 1, 2, 3] as const;
export const NEUTRAL_COLS = [4, 5] as const;
export const DEPLOY_B_COLS = [6, 7, 8, 9] as const;

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

/** Rows needed to seat `n` fighters in a 4-column deploy zone. */
export function heightForSideCount(n: number): number {
  if (n <= 0) return ARENA_HEIGHT_DEFAULT;
  const need = Math.ceil(n / DEPLOY_A_COLS.length);
  return Math.min(ARENA_HEIGHT_MAX, Math.max(ARENA_HEIGHT_DEFAULT, need));
}

export function heightForForce(aCount: number, bCount: number): number {
  return heightForSideCount(Math.max(aCount, bCount));
}

export class Arena {
  readonly width: number;
  readonly height: number;
  readonly size: number;

  constructor(height = ARENA_HEIGHT_DEFAULT, width = ARENA_WIDTH) {
    if (width !== ARENA_WIDTH) {
      throw new Error(`arena width is fixed at ${ARENA_WIDTH} (got ${width})`);
    }
    if (!Number.isInteger(height) || height < 2 || height > ARENA_HEIGHT_MAX) {
      throw new Error(`arena height must be an integer 2…${ARENA_HEIGHT_MAX} (got ${height})`);
    }
    this.width = width;
    this.height = height;
    this.size = width * height;
  }

  index(col: number, row: number): number {
    return row * this.width + col;
  }

  col(index: number): number {
    return index % this.width;
  }

  row(index: number): number {
    return (index / this.width) | 0;
  }

  inBounds(col: number, row: number): boolean {
    return col >= 0 && col < this.width && row >= 0 && row < this.height;
  }

  /** Six neighbour indices, or -1 where the edge cuts them off. */
  neighboursOf(index: number, out: Int32Array): void {
    const col = this.col(index);
    const row = this.row(index);
    const deltas = ODD_R_NEIGHBOURS[row & 1]!;
    for (let d = 0; d < 6; d++) {
      const [dc, dr] = deltas[d]!;
      const nc = col + dc;
      const nr = row + dr;
      out[d] = this.inBounds(nc, nr) ? this.index(nc, nr) : -1;
    }
  }

  distance(a: number, b: number): number {
    const [aq, ar, as] = cubeFromOffset(this.col(a), this.row(a));
    const [bq, br, bs] = cubeFromOffset(this.col(b), this.row(b));
    return (Math.abs(aq - bq) + Math.abs(ar - br) + Math.abs(as - bs)) / 2;
  }

  assertDeploy(side: 0 | 1, cell: number): void {
    const col = this.col(cell);
    const row = this.row(cell);
    if (row < 0 || row >= this.height || col < 0 || col >= this.width) {
      throw new Error(`cell ${cell} is outside the ${this.width}×${this.height} arena`);
    }
    if (side === 0 && (col < 0 || col > 3)) {
      throw new Error(`side A must deploy in cols 0–3 (got col ${col})`);
    }
    if (side === 1 && (col < 6 || col > 9)) {
      throw new Error(`side B must deploy in cols 6–9 (got col ${col})`);
    }
  }
}

function cubeFromOffset(col: number, row: number): [number, number, number] {
  const q = col - ((row - (row & 1)) >> 1);
  const r = row;
  return [q, r, -q - r];
}

/** @deprecated Prefer an Arena instance — kept for call sites during the cutover. */
export const ARENA_HEIGHT = ARENA_HEIGHT_DEFAULT;
export const ARENA_SIZE = ARENA_WIDTH * ARENA_HEIGHT_DEFAULT;

export function arenaIndex(col: number, row: number): number {
  return row * ARENA_WIDTH + col;
}
export function arenaCol(index: number): number {
  return index % ARENA_WIDTH;
}
export function arenaRow(index: number): number {
  return (index / ARENA_WIDTH) | 0;
}
