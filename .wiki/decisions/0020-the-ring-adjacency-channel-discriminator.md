# 0020 — Linearity is a ring-adjacency test, not a neighbour count

Status: accepted · Spec: `2915cb06-5` · Date: 2026-07-30

## Decision

A tile may become `River` iff it has **one or two** river neighbours **and no two of them are
cyclically adjacent** on the hex neighbour ring. Implemented as `CHANNEL_OK`, a 64-entry
`Uint8Array` indexed by `TileContext.riverRing` — a 6-bit mask of which neighbour *directions*
hold a river. One indexed load in the hot loop.

## Why the mask and not the count

`neighbourCounts[River]` is not enough. Two river neighbours mean opposite things depending
on where they sit:

- **60° apart (adjacent on the ring)** — a pocket *beside* a channel. A tile alongside a
  straight chain always touches two consecutive chain tiles. This is what widening looks
  like, and refusing it is where linearity comes from.
- **120° or 180° apart** — a one-tile hole *in* a channel. Admitting it is what lets a
  severed chain heal.

`hex.ts` walks the neighbour ring in cyclic order — E, NE, NW, W, SW, SE — at **both** row
parities (verified against `ODD_R_NEIGHBOURS` directly), so direction `d` and `(d+1) % 6` are
geometrically 60° apart and the distinction is exactly a bit-adjacency test.

## Why healing is not optional

`exactly one river neighbour` gives chains and then destroys them. A tile in a one-tile hole
has **two** river neighbours, so the naive predicate refuses it: one decay event severs a
chain permanently, and both halves keep severing. Measured at 1500 days: **534 "rivers", mean
1.9 tiles, 25.2% isolated singletons**, while the *same growth machinery* with decay disabled
produced 14 rivers of mean 32.2 and longest 131. Growth was never the problem. **A river
under `exactly-one` does not decay, it dissolves.**

The same failure reappeared in this implementation from a different direction, and is worth
recording because the cause was not the predicate at all: `CHANNELABLE` was first aliased to
`SUBSIDABLE` verbatim, which excludes marsh and swamp — and marsh and swamp are precisely
what a river *decays into*. Every tile the river had just lost was un-rechannelable, so the
healing rule could never close the hole it was written for. Measured with that alias: mean
river-neighbour count 1.28–1.47, 33–53% of components a single tile. `CHANNELABLE` is now
`SUBSIDABLE` plus marsh and swamp, and `marsh → river` is an acknowledged edge overlap.

## Why the popcount cap is not redundant with the adjacency test

This is the part that was wrong on the first pass and is the reason this decision exists in
its own right.

"No two neighbours adjacent" **alone** also admits the 0°/120°/240° arrangement. On a hex
grid that is a *sublattice*: there is a honeycomb pattern at 1/3 density in which every tile
has exactly three mutually non-adjacent river neighbours — so the predicate admits every one
of its own cells and the dense phase is a **stable fixed point**.

Measured on the largest `garden` component at 1500 days with the cap absent: 106 tiles,
river-neighbour histogram 1:15, 2:50, **3:41**, mean 2.25, rendering as a braided honeycomb
filling a region rather than a channel crossing one. Widening was the exact thing this table
existed to prevent, and it was reintroduced by the clause meant to allow healing.

With the cap (`count <= 2`), the same world's largest component: 68 tiles, histogram 1:9,
**2:50**, 3:9, mean 2.00 — mode at two neighbours, which is what "channel interior" means.

The cost is exact and small: a hole at a genuine three-way confluence no longer heals.
Two-way holes are the overwhelmingly common case and still do.

## Four or more was already impossible

The largest independent set on a 6-cycle is 3, so any 4 set bits necessarily contain an
adjacent pair. The measured share of river tiles with 4+ river neighbours is **0.00% on every
preset in every configuration tested** — that is a property of the predicate, not a rate that
happened to come out small.

## Measured as shipped

1500 days, 160×96, seed 20260729:

| preset | mean river-neighbours | singleton share of tiles | 4+ neighbours |
|---|---|---|---|
| garden | 1.78 | 2.2% | 0.00% |
| kiln | 1.77 | 2.1% | 0.00% |
| crucible | 1.70 | 3.4% | 0.00% |

Against the prototype's band of 1.56–1.92 mean and 1.4–6.5% singletons.
