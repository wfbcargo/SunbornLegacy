# 0012 — The sweep measures gross flux, not only the stock

Date: 2026-07-29
Status: accepted
Spec: `2915cb06-3_water-chemistry`
Decided by: `impl-water-chemistry-5c9a12`

## Context

`sweep.ts` section C is the only instrument in the repo that watches the coastline over a
long horizon, and it was the instrument that caught both of the historical one-way
membranes. It measures one thing: **sea share, as a stock, at five decade marks.**

That is not enough for an epic that adds water↔land edges on purpose.

- **A stock is blind to gross flux by construction.** Two edges moving 5 pp of the world
  per game-year in opposite directions net to zero and never move the number. This is not
  a hypothetical: the shipped coastline *is* a pair of large opposed flows. Measured at
  120×72 over 40 game-years, `crucible` runs 0.782 pp/y landward against 0.730 pp/y seaward
  for a net of +0.052 — the net is **3.4% of gross**. "The sea share barely moved" is
  therefore equally consistent with a new rule doing nothing and with a new rule doing an
  enormous amount of work that something else happens to cancel.
- **`SEA_SHARE` was hand-enumerated** (`[Ocean, Shallows, FrozenSea]`) in the one file
  whose job is to catch a draining world, while `biomes.ts` derives the same set from
  `water && !molten` and documents at length why hand lists there are "a trap factory".
  Spec 5 of this epic adds a water-ish biome. The sweep would have reported a flat sea
  while the sea drained into the biome it could not see.
- **Drift cannot tell "converged" from "draining forever."** Pass/fail is `|drift| < 5 pp`
  at y40. A world losing 0.12 pp/y passes and is dry at y200 — and since the coastline has
  **no restoring force**, that is the realistic failure mode, not an edge case. (The epic's
  prior analysis established the absence of a restoring force by perturbing the day-0 sea
  level and watching the y60 end state move from 0.00% to 91.23%. That figure is theirs,
  taken before specs 1 and 2; the evidence below is from this tree.)
- **`invariants.ts` check 8 will not cover for it.** Check 8 measures immutability, not
  extinction: a biome at 0.00% has zero stuck tiles and passes trivially, and `Ocean` is
  explicitly exempt (`invariants.ts:500`). A drained ocean passes every invariant.

## Decision

**Three changes to `sweep.ts`, and a counter in `biomes.ts` that makes the first possible.**

1. **`SEA_SHARE` is now `SEA`, imported from `biomes.ts`.** Same predicate as the
   hydrology, so a new water biome joins the measurement the moment it joins `BIOMES`.

2. **A per-rule flux ledger, reported next to the stock.** `enableFluxLedger()` installs a
   counting getter over `Rule.to` on every rule; section C resets it per preset and prints
   every rule whose two endpoints straddle the sea/land boundary, in pp of world per
   game-year, with the landward and seaward totals and the net as a percentage of gross.
   It costs no extra simulation — the counters are filled by the runs section C already
   performs.

3. **A late rate and a projection.** Most of the drift in the drift column is the worldgen
   transient, spent inside the first decade, and it is not a ratchet. The y20→y40 rate is
   now reported separately and extrapolated to y200, with a `⚠` when the projection leaves
   `(0%, 100%)`. The ±5 pp verdict is unchanged — this is a reported rate, not a new merge
   gate.

**★ THE LEDGER IS A GETTER ON `Rule.to`, NOT A COUNTER IN THE HOT LOOP.** `world.ts:720`
is the single place `rule.to` is read, and it is read only *after* the roll has already
been won. So the getter **is** the firing count: no test, no extra state, no branch on the
~99.9% of tile-visits that do not transition, and — the property that matters — **no way
for the instrument to change the arithmetic it is measuring.** Verified: both golden hashes
are unchanged with the ledger enabled.

It is off by default and `enableFluxLedger()` is one-way. A diagnostic that can be switched
off mid-run reports a number nobody can reproduce.

## Evidence

`npm run sim:sweep`, 120×72, 40 game-years, seed 20260729, with both of this spec's new
edges in place. Net as a fraction of gross:

| preset | land→sea | sea→land | net | net as % of gross |
|---|---|---|---|---|
| still | 0.014 | 0.054 | −0.040 | 57.8% |
| anvil | 0.134 | 0.100 | +0.034 | 14.7% |
| garden | 0.272 | 0.345 | −0.073 | 11.9% |
| kiln | 0.435 | 0.504 | −0.069 | 7.4% |
| crucible | 0.782 | 0.730 | +0.052 | **3.4%** |

**The busier the world, the more completely the stock hides what is happening in it.** On
`crucible` the net is 3.4% of gross — the sea share is the small residue of two flows 20×
its size, so "sea share barely moved" is nearly uninformative there. The control inverts it
(57.8%) for the obvious reason that `still` has almost no flux at all to hide anything in.

The ledger is also what made this spec's per-edge numbers measurable at all. On `anvil`,
`the flow builds new land` fires 86 times in 40 game-years (0.0249 pp/y) and `the shallows
bake dry` fires 10 (0.0029 pp/y) — rates the stock column cannot resolve from noise, and
exact integers to the ledger.

**The late-rate column earned its place on the first run.** `kiln` reports `late pp/y`
−0.061 → **11% sea at y200**, and `garden` −0.021 → 18%, while both pass the ±5 pp drift
test comfortably (−2.8 pp and −2.9 pp). Neither is caused by this spec — the same rates are
present in the pre-edge baseline (`kiln` −0.0523 pp/y, `garden` −0.0579 pp/y over 60
game-years) — which is exactly the point: this is a pre-existing slow drain that the
instrument could not previously express, on the two presets nobody was worried about.

## Consequences

- **A new water-ish biome is now measured automatically**, and spec 5 does not have to
  remember to update a list in a second file.
- **`sweep.ts` output grew a section.** It is the presentation caller (R-007), so the
  printing belongs there; `biomes.ts` owns only the counter.
- **`RULE_FIRINGS` is a module-level singleton**, so a process that runs two worlds
  concurrently would blend their counts. Nothing does, and the alternative — per-world
  counters — means threading a ledger reference through `evaluateTile`, which is exactly
  the hot-loop cost the getter exists to avoid. If concurrent worlds ever become real,
  this is the thing to revisit.
- **Reading `rule.to` outside the simulation increments the counter**, including in
  `sweep.ts`'s own classification loop. Harmless because the ledger is read after the run,
  but any future consumer must reset before the window it cares about, not after.
- **Three known blindnesses remain**, recorded in the spec file rather than fixed here:
  transients are still invisible between decade marks, section C still runs one worldgen
  point (`seaLevel` 0.44, where the *unmodified* ruleset already fails its own 5 pp test
  at 0.37), and the ±5 pp verdict still ignores the late rate the sweep now prints.
