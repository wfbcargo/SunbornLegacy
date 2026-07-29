# 0003 — Canvas hex fills are batched in sixteens, not per-colour

Date: 2026-07-29
Status: accepted

## Context

The viewer draws 34,560 hexes per frame at the default 240×144 world. The textbook advice
for canvas is to minimise state changes and draw calls: bucket the tiles by colour, build
one `Path2D` per biome, set `fillStyle` 22 times, and call `fill()` 22 times. That was the
first implementation.

Measured on Chrome at the default hex size, one full redraw:

| fills per colour | full redraw |
| --- | --- |
| 1 (one path per biome) | **6867 ms** |
| flush every 4096 hexes | 806 ms |
| flush every 512 hexes | 130 ms |
| flush every 64 hexes | 16 ms |
| **flush every 16 hexes** | **7 ms** |
| flush every 1 hex | 19 ms |

The in-page number was 1729 ms rather than 6867 ms because the 22 buckets split the work,
but the shape is the same and the cost is the same kind of cost.

The cause is not draw-call count. A path holding every tile of one colour carries up to
~207,000 edges, and the rasteriser's per-scanline work scales with the size of the whole
path rather than with the part of it that crosses that scanline. Fewer, larger fills make
each one superlinearly worse.

## Decision

Bucket by biome as before, but **flush the path every 16 hexes** (`FILL_CHUNK` in
`src/viewer/public/viewer.js`). Bucketing still earns its keep — it is what lets a flush
hold 16 hexes of a single colour — but the batching, not the bucketing, is what makes the
viewer usable.

## Consequences

- Full redraw fell from 1729 ms to **11.6 ms** at the default hex size, and to 20.3 ms at
  the maximum hex size (a 4999×2598 canvas). Per-day partial redraws run 0.4–1.0 ms.
- Playback at 30 days/second is comfortable, and no downsampling, WebGL rewrite, or worker
  is needed. The plain 2D context is sufficient at this world size.
- The optimum is a **U**, not a slope: too few fills and the rasteriser drowns, too many and
  per-call overhead takes over. 16 is measured, not reasoned. If the hex geometry or the
  world size changes materially, re-measure rather than assuming it still holds.
- This is a browser-rasteriser property, not a canvas-API one. It was only visible at full
  world size; a 40×24 test world would have shown nothing.
