/**
 * WHAT A WORLD MAY BE — the bounds on size and on a composed cycle set, with the
 * measurement behind each one.
 *
 * The viewer is where a person types a number, so this is where a bad number has to be
 * caught. Every rejection below names the constraint rather than clamping silently: a
 * clamp turns "height 143" into a 144-row world the user did not ask for and cannot
 * tell they did not get, which is the same class of quiet wrongness as a swallowed npm
 * flag.
 *
 * ★ NOTHING HERE IS A PREFERENCE. Each bound is either a hard requirement of the grid,
 * a measured cost ceiling, or a degeneracy that makes the map stop meaning anything.
 * Where a bound is a judgement call, the measurement it was drawn from is quoted so the
 * next person can move it on evidence rather than on taste.
 */

import { CYCLE_CATALOGUE, cycleCatalogueEntry, type CycleSpec } from '../sim/cycles.ts';
import { DEFAULT_BAND_WIDTH } from '../sim/world.ts';

/**
 * Columns evaluated per sweep step — `World`'s default `bandWidth`, which the viewer
 * never overrides.
 *
 * WIDTH MUST BE A MULTIPLE OF THIS, and that is a measured requirement, not tidiness.
 * `stepDay()` runs `ceil(width / bandWidth)` steps and each step advances the gaze by
 * exactly `bandWidth` columns, so when the width is not a multiple the last step of the
 * day overlaps the first. MEASURED with a zero-effect observer cycle counting `affect`
 * calls per column over one day at height 16:
 *
 *     width 240  (240 % 8 = 0)   1.000 evaluations/column/day, 0 columns doubled
 *     width 244  (244 % 8 = 4)   1.016 evaluations/column/day, 4 columns doubled
 *     width 250  (250 % 8 = 2)   1.024 evaluations/column/day, 6 columns doubled
 *     width 100  (100 % 8 = 4)   1.040 evaluations/column/day, 4 columns doubled
 *
 * A doubled column ages twice as fast for that day, and the doubled band drifts across
 * the map as the days go by. Nothing crashes, which is exactly why it is worth
 * rejecting: the world simply runs a few percent fast in a way no output would show.
 *
 * Derived from the sim's own default rather than retyped — the true rule is "a multiple of
 * the world's `bandWidth`", which is a `WorldOptions` knob. A caller passing a non-default
 * `bandWidth` needs a different divisor, and this constant would not know.
 */
export const BAND_COLS = DEFAULT_BAND_WIDTH;

/**
 * Smallest sensible world.
 *
 * The hard floor is much lower — the neighbour table only degenerates below 3 columns
 * or 4 rows, where a tile becomes its own neighbour — but a world narrower than twice
 * the beam band (8 columns) or shorter than twice the default monsoon band (9 rows) is
 * a world where a single default cycle covers everything at once, every day. That is
 * not a small world, it is a world with no geography for weather to happen in.
 */
export const MIN_WIDTH = 16;
export const MIN_HEIGHT = 16;

/**
 * Largest world, as a tile count rather than per-axis, because every cost that matters
 * scales with the product.
 *
 * MEASURED on this machine (Node 24, one `stepDay` averaged over 20 days after a
 * 5-day warm-up), the simulation is linear in tiles at ~92 ns/tile with no cycles and
 * ~125 ns/tile with all five:
 *
 *     240×144    34,560 tiles    3.2 / 4.3 ms      68 KiB per frame
 *     320×192    61,440 tiles    5.6 / 7.9 ms     120 KiB
 *     480×288   138,240 tiles   12.5 / 17.1 ms    270 KiB
 *     640×384   245,760 tiles   22.6 / 30.1 ms    480 KiB
 *     960×576   552,960 tiles   51.7 / 68.4 ms   1080 KiB
 *
 * The cap is set at 262,144 tiles, and what bounds it is STEP TIME, not the canvas and
 * not the frame. Measured IN THE VIEWER at exactly the cap (512×512, all five cycles):
 * 42.2 ms per simulated day, 512 KiB per frame, 48 ms for a full client redraw, and a
 * 10,653×9,222 canvas at the maximum hex size.
 *
 *   - Step time. `ViewerSession.schedule` delivers speeds above 20 days/second as
 *     several days per timer tick, so at the top speed of 60 it steps 3 days in one
 *     synchronous block: ~127 ms of blocked event loop per tick at the cap, which is
 *     already at the edge of a viewer meant to feel live. At 960×576 the same figure is
 *     over 200 ms and playback visibly stalls between frames. Note the viewer's number
 *     is ~25% above the bare `stepDay` cost above, because a viewer day also samples
 *     the world and serves frames.
 *   - Canvas. At the maximum hex radius of 12 a tile costs ~374 canvas pixels, so
 *     Chrome's ~268 Mpx canvas area limit is not reached until ~717,000 tiles — 2.7×
 *     the cap. Measured at the cap: 98.2 Mpx, allocated and drawn without complaint.
 *     Below the cap the canvas is never the binding constraint at any zoom.
 *   - Frame bytes. Two bytes per tile: 512 KiB at the cap, over loopback, at most 15
 *     frames a second. Not close to binding.
 *
 * The per-axis cap is what keeps a legal tile count from being an illegal canvas: 4096
 * columns at hex radius 12 is 85,000 px wide, past Chrome's 65,535 px maximum dimension.
 */
export const MAX_TILES = 262_144;
export const MAX_SIDE = 2048;

export interface SizeLimits {
  minWidth: number;
  minHeight: number;
  maxSide: number;
  maxTiles: number;
  bandCols: number;
}

export const SIZE_LIMITS: SizeLimits = {
  minWidth: MIN_WIDTH,
  minHeight: MIN_HEIGHT,
  maxSide: MAX_SIDE,
  maxTiles: MAX_TILES,
  bandCols: BAND_COLS,
};

/**
 * Validate a requested world size.
 *
 * Returns the message to show the user, or null when the size is fine. The message says
 * what the constraint IS — "height must be even" rather than "invalid height" — because
 * the person reading it is choosing a number, not filing a bug.
 */
export function checkSize(width: unknown, height: unknown): string | null {
  if (typeof width !== 'number' || !Number.isFinite(width) || !Number.isInteger(width)) {
    return 'Width must be a whole number.';
  }
  if (typeof height !== 'number' || !Number.isFinite(height) || !Number.isInteger(height)) {
    return 'Height must be a whole number.';
  }
  if (width < MIN_WIDTH || height < MIN_HEIGHT) {
    return `The world must be at least ${MIN_WIDTH}×${MIN_HEIGHT}. Below that a single ` +
      'default cycle — an 8-column beam band, a 9-row monsoon band — covers the whole ' +
      'map at once, and there is no geography left for the weather to move across.';
  }
  if (width > MAX_SIDE || height > MAX_SIDE) {
    return `Neither axis may exceed ${MAX_SIDE}. At the maximum hex size a wider world ` +
      "overruns the browser's 65,535-pixel canvas limit and the map stops drawing.";
  }
  if (height % 2 !== 0) {
    return 'Height must be EVEN. The world is a torus: its top row is stitched to its ' +
      'bottom row, and odd heights flip hex row parity across that seam, so the two ' +
      'edges join up wrong. The grid refuses to build at all.';
  }
  if (width % BAND_COLS !== 0) {
    const near = Math.round(width / BAND_COLS) * BAND_COLS;
    return `Width must be a multiple of ${BAND_COLS}, the sweep band (try ${near}). The sun ` +
      `evaluates ${BAND_COLS} columns per step and ceil(width/${BAND_COLS}) steps per day, so any ` +
      'other width makes the last step of the day overlap the first: measured at width ' +
      '250, six columns are evaluated twice a day and the world ages 2.4% fast in a ' +
      'drifting band. Nothing crashes, which is why it is rejected here.';
  }
  if (width * height > MAX_TILES) {
    return `${(width * height).toLocaleString()} tiles is over the ${MAX_TILES.toLocaleString()}-tile ` +
      'ceiling. What bounds it is step time, not the canvas: measured at the ceiling, ' +
      'five cycles cost 42 ms per simulated day, so playing at 60 days/second steps ' +
      'three days in one ~127 ms block of the server’s event loop. Past that the viewer ' +
      'stops feeling live.';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Composed cycle sets
// ---------------------------------------------------------------------------

/**
 * Validate a composed cycle set, returning a message or null.
 *
 * Three things are checked, and the third is the interesting one:
 *
 *   - the kind exists (otherwise `makeCycle` throws and the request 500s);
 *   - every parameter is known to the catalogue and inside its declared range —
 *     `Partial<Params>` means an unrecognised property is silently ignored by the
 *     constructor, so a typo'd name would produce a cycle that quietly used defaults;
 *   - KEYS ARE UNIQUE. A cycle's key seeds its RNG stream (`hash32(worldSeed, key,
 *     kind)`), so two cycles of one kind sharing a key are not two cycles — they are
 *     one cycle evaluated twice, with identical fault lines, vents and phase. Two
 *     monsoons out of phase is a legitimate world and this is what keeps it possible.
 */
export function checkCycles(cycles: unknown): string | null {
  if (!Array.isArray(cycles)) return 'Cycles must be a list.';
  if (cycles.length > 32) return 'A world may hold at most 32 cycles.';

  const seen = new Set<string>();
  for (const raw of cycles as CycleSpec[]) {
    if (typeof raw !== 'object' || raw === null) return 'Each cycle must be an object.';
    const spec = raw as Record<string, unknown>;
    const kind = spec['kind'];
    if (typeof kind !== 'string') return 'Each cycle needs a kind.';
    let entry;
    try {
      entry = cycleCatalogueEntry(kind);
    } catch {
      return `Unknown cycle kind "${kind}". Known kinds: ${CYCLE_CATALOGUE.map((e) => e.kind).join(', ')}.`;
    }

    const key = spec['key'];
    if (key !== undefined) {
      if (typeof key !== 'string' || key.trim() === '') return 'A cycle key must be a non-empty string.';
      if (seen.has(key)) {
        return `Two cycles share the key "${key}". A key seeds the cycle's own random ` +
          'stream, so identical keys make identical cycles — same faults, same vents, ' +
          'same phase. Give each instance its own key.';
      }
      seen.add(key);
    }

    for (const [name, value] of Object.entries(spec)) {
      if (name === 'kind' || name === 'key') continue;
      const def = entry.params.find((p) => p.name === name);
      if (def === undefined) {
        return `"${kind}" has no parameter "${name}". A cycle constructor takes a partial ` +
          'params object and ignores what it does not recognise, so this would have ' +
          `silently run with defaults. Parameters: ${entry.params.map((p) => p.name).join(', ')}.`;
      }
      if (def.type === 'boolean') {
        if (typeof value !== 'boolean') return `"${kind}.${name}" must be true or false.`;
        continue;
      }
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return `"${kind}.${name}" must be a finite number.`;
      }
      if (def.type === 'integer' && !Number.isInteger(value)) {
        return `"${kind}.${name}" must be a whole number.`;
      }
      if (def.type === 'choice' && !(def.choices ?? []).includes(value)) {
        return `"${kind}.${name}" must be one of ${(def.choices ?? []).join(', ')}.`;
      }
      if (def.min !== undefined && value < def.min) {
        return `"${kind}.${name}" must be at least ${def.min}. ${def.note}`;
      }
      if (def.max !== undefined && value > def.max) {
        return `"${kind}.${name}" must be at most ${def.max}. ${def.note}`;
      }
    }
  }
  return null;
}
