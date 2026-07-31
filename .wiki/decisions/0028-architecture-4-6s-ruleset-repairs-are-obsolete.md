# 0028 — `ARCHITECTURE.md#4.6`'s ruleset repairs are obsolete, and a Quake-gated Rock is not a defect

Status: accepted · Epic: `d53ccbb6` · Date: 2026-07-30

## Decision

`ARCHITECTURE.md#4.6` "Required ruleset repairs" — an explicit line item of Phase 1's build
sequence, described there as "not optional polish" — is **struck from Phase 1**. Three of
its four items do not reproduce on the current tree. The fourth reproduces but is an
economy decision for Phase 7, not a sim repair.

Nothing in `biomes.ts` changes as a result. This decision exists so the *next* agent to
read `ARCHITECTURE.md#13` Phase 1 does not apply repairs to a ruleset that already
outgrew them.

## What was measured

Read-only, `main` at `be3e44d`, 240×144, seed 20260729, 1500 days (4.1 game-years),
sampled every 100 days. §4.6's figures were taken at BRAINSTORM Session 8 — before the
rivers, thermal-inertia, weather and wandering-sun specs landed.

| §4.6 claim | §4.6's measurement | Re-measured today | Verdict |
|---|---|---|---|
| Rock is a true absorbing state; once global Rock is 0 the uplift rules can never fire again | 2.0% at worldgen → 0.03% (no beam) / 0.00% (beam) by day 800, never recovering | `garden` 1.733% → **1.319%**, oscillating 0.767–6.635%. `crucible` → **1.296%**, oscillating 1.117–5.046% | **Does not reproduce** |
| — (§4.6 did not track Mountain) | — | Mountain **grows**: `crucible` 0.203% → **0.521%**, max 0.738%; `garden` → 0.266% | — |
| Bloom has no hysteresis; the exit window contains the entry window, so Bloom is structurally a transient | killing sunpetal/nectar/essence | max **3.001%** (`garden`), **2.908%** (`crucible`), oscillating across the run | **Does not reproduce** |
| Marsh is squeezed from both sides | drowns at ≥3 water neighbours, dries at heat>62 | climbs to **9.682%** (`garden`), **8.981%** (`crucible`), still rising at day 1500 | **Reversed** |
| Ash/char/cinder unobtainable; Ash sits at 0.00% whenever the beam is off | 0.00% | `garden` **0.000%** at all 16 samples | **Reproduces** |

## Why the Rock collapse looked real, and why it is not a defect

The collapse **does** reproduce on `anvil` — Rock 1.733% → **0.038%**, Mountain 0.203% →
**0.023%**, monotone, no recovery. That is the run that matches §4.6's description, and
taken alone it reads as confirmation.

It is not, because `anvil` is:

```ts
anvil: [{ kind: 'solarbeam', transitDays: 60 }],
```

Every single route into Rock is gated on `CycleFlag.Quake`:

- `biomes.ts:884` `Badlands → Rock` "strata split open"
- `biomes.ts:888` `Barren → Rock` "bedrock thrust up"
- `biomes.ts:899` `Mountain → Rock` "the peak comes down"
- `biomes.ts:1117` `Ocean → Rock` "tectonic uplift"
- `biomes.ts:1122` `Shallows → Rock` "tectonic uplift"

`Quake` is raised only by the Tectonics cycle, which `anvil` does not carry. A beam-only
world therefore has **no path to Rock at all**, and its worldgen stock decays away. That is
`README.md` finding #4 working as documented — *"with no tectonics the transition graph has
no path to `mountain` at all… The GM's difficulty dial reaches all the way into the
economy"* — and `sim:check` invariant 8 reports `anvil` unlatched at 13.97% regardless.

**§4.6's own proposed repair already exists.** It asks for a `Barren → Rock` rule at
~300d; `biomes.ts:887` has carried one at 25d since the water-chemistry spec, gated on
Quake like the rest. Applying §4.6 as written would have added a duplicate edge to a
healthy ruleset on the strength of a measurement taken four sessions earlier.

## The one surviving item is not ours

Ash at 0.000% with the beam off is real and reproduces exactly. But `README.md` finding #4
states this as the intended shape of the difficulty dial — a garden world has no volcanic
stone and must trade for it. §4.6's fix (move ash/char/cinder to `origin='salvage'`,
recovered from beam ruins rather than harvested) is a **materials-origin** change with no
`biomes.ts` component. It belongs to Phase 7, and is recorded there rather than done here.

## Consequences

- Phase 1's scope shrinks to: pure `worldgenAt`, the static `tectonic` channel, the 8×8
  coarse CA, and the `lod-agreement` gate.
- The `tectonic` channel loses its §4.6 justification and keeps only its economy one
  (province mineral suites need permanent mountain geography). Whether any rule may read
  it is an open decision held by the user — a `tectonic`-gated route to Rock that fires
  without a Quake would give `anvil` mountains and weaken finding #4's difficulty dial.
  See `specs/d53ccbb6_lod-gate.md`.
- **The general lesson, which is the durable part:** `ARCHITECTURE.md` carries a documented
  Session-8 cut-off for *design*, and this is the first evidence that its **measurements**
  are stale too. `README.md` already warns the data model will need extending; it does not
  warn that the measured defect tables have expired. Treat every number in
  `ARCHITECTURE.md` as needing re-measurement before it is acted on, exactly as R-003
  requires of numbers we produce ourselves.
