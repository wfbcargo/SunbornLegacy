# Spec 07717b6b — Movement legs

Branch: `main--epic/8d614c77_modular-caravan--spec/07717b6b_movement-legs`
Epic: `8d614c77_modular-caravan`
Status: done

## Objective

In-memory caravan travel: commit a hex tile path as an immutable **leg**, snapshot
`ticksPerTile` from the slowest member at commit, and resolve position as a pure
function of step. No world shard, no region boundaries, no starve yet.

Source: `BRAINSTORM.md` Session 2 (speed = slowest member; departure + duration →
arrival). `ARCHITECTURE.md` §3.4 `caravan_leg` (committed legs, ticks snapshot,
position as pure function). Epic: `.wiki/specs/8d614c77_modular-caravan.md`.

## Acceptance criteria

1. **`Caravan` gains** `origin: TileCoord`, `legs: CaravanLeg[]`, `generation: number`.
   Starting loadout parks at `{ col: 0, row: 0 }` with empty legs.
2. **`CaravanLeg`:** `{ seq, tiles, ticksPerTile, startStep, state }` where
   `state` is `'committed' | 'stalled'`. `tiles[0]` is the departure tile; each next
   tile must be an odd-r neighbour (pointy-top, **non-wrapping** this slice).
3. **`commitLeg(caravan, tiles, startStep)`**
   - Rejects if `form !== 'caravan'` / not mobile / `ticksPerTile == null`.
   - Rejects if `tiles.length < 2`, non-contiguous, or `tiles[0]` ≠ position at
     `startStep`.
   - Snapshots `ticksPerTile` from `deriveStats` at commit (not live).
   - Appends a `committed` leg; bumps nothing on generation this slice (replan later).
4. **`positionAt(caravan, step)`** — pure. Walks committed (non-stalled) legs in
   order; for each leg, tile index =
   `min(floor((step - startStep) / ticksPerTile), tiles.length - 1)` while
   `step >= startStep`. Before any leg / after arrival: last known tile (origin or
   final tile of last finished leg). Returns `{ tile, travelling, legSeq, tileIndex }`.
5. **`stallLeg(caravan, seq)`** marks that leg `stalled` (future interrupt). Position
   freezes at whatever `positionAt` last resolved on that leg before stall — simpler
   this slice: stalled legs are skipped for travel after their start, and position
   stays at the tile held when stalled was applied via `stallAt(caravan, step)` which
   freezes by truncating the active leg's `tiles` to `tiles.slice(0, tileIndex+1)` and
   marking stalled. **Committed history is not rewritten backward** — only the
   unfinished suffix is dropped.
6. **`settle` rejects while travelling** at "now" — settle API / function takes an
   optional `step` (default 0); if `positionAt(...).travelling`, reject with a named
   reason. Idle outposts still work.
7. **CLI:** `npm run caravan -- --path 0,0:1,0:2,0 --at 12` commits that path at
   step 0 and prints position at `--at`. Without `--path`, behaviour unchanged aside
   from showing parked tile.
8. **Lab:** small odd-r hex board (width 8 × height 6, non-wrapping), show caravan
   tile, click to build a waypoint path from current tile, Commit route, step
   scrubber updates position. Settle still available when idle.
9. **`npm run typecheck` green.** `npm run sim:golden` unmoved.

## Scope

**May touch:** `src/caravan/**`, `.wiki/specs/07717b6b_movement-legs.md`,
`.wiki/specs/8d614c77_modular-caravan.md`, `.wiki/glossary.md` (leg / ticksPerTile).

**Must not touch:** `src/sim/**` stepping (importing neighbour math from `hex.ts` is
OK if used read-only; prefer a local odd-r neighbour helper to avoid torus wrap),
`src/battle/**`, `src/viewer/**`, golden hashes.

## Boundary decisions (do not relitigate)

- **No region segmentation** — one leg = one path. Multi-leg chains allowed by
  committing again after arrival.
- **No terrain cost** — every tile costs the snapshotted `ticksPerTile`.
- **Non-wrapping lab grid** — edges have fewer neighbours; reject out-of-bounds.
- **Starve / sated_until** deferred.
- **Generation / event idempotency** deferred (field exists, stays 0).
