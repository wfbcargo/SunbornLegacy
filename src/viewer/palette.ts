/**
 * xterm-256 → RGB.
 *
 * `BiomeDef.colour` is an ANSI-256 terminal code because the simulator's only
 * renderer was a terminal. A canvas needs RGB, and the conversion lives HERE rather
 * than as a second colour field on `BiomeDef`: the sim describes the world, callers
 * decide how to draw it (`architecture.md#boundaries`), and `src/sim/` is out of this
 * spec's scope.
 *
 * The table is computed, not transcribed. Codes 16-231 are a 6×6×6 cube over five
 * fixed levels and 232-255 are an even grey ramp, so only the 16 legacy colours need
 * literals — which is 16 numbers to get wrong instead of 256.
 */

/** The five channel levels of the 6×6×6 colour cube. */
const CUBE_LEVELS = [0, 95, 135, 175, 215, 255] as const;

/** The 16 legacy ANSI colours, as 0xRRGGBB. */
const LEGACY = [
  0x000000, 0x800000, 0x008000, 0x808000, 0x000080, 0x800080, 0x008080, 0xc0c0c0,
  0x808080, 0xff0000, 0x00ff00, 0xffff00, 0x0000ff, 0xff00ff, 0x00ffff, 0xffffff,
] as const;

export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export function ansi256ToRgb(code: number): Rgb {
  const c = Math.max(0, Math.min(255, Math.round(code)));

  if (c < 16) {
    const packed = LEGACY[c]!;
    return { r: (packed >> 16) & 0xff, g: (packed >> 8) & 0xff, b: packed & 0xff };
  }

  if (c < 232) {
    const n = c - 16;
    return {
      r: CUBE_LEVELS[Math.floor(n / 36)]!,
      g: CUBE_LEVELS[Math.floor(n / 6) % 6]!,
      b: CUBE_LEVELS[n % 6]!,
    };
  }

  const grey = 8 + (c - 232) * 10;
  return { r: grey, g: grey, b: grey };
}

export function ansi256ToHex(code: number): string {
  const { r, g, b } = ansi256ToRgb(code);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}
