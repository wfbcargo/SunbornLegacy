# Epic 2915cb06 — Living water, weather, and a travelling sun

Status: in progress
Target branch: `main`
Branch: `main--epic/2915cb06_living-water`

## The intent

Water in this simulator barely moves. It is a stock the terrain rules push around at the
margins, not a participant. This epic makes it one: land is manufactured from water and
water from land, the sea's temperature reaches inland, rivers run, and the disturbance
engine grows a weather layer that travels, morphs against the terrain it crosses, and
dies. The solar beam stops being a full-height band and becomes what it was meant to be —
a small focus tracing a sinusoid across the world.

Six specs. They are **sequential**, not parallel: every one of them moves the same three
files (`biomes.ts`, `cycles.ts`, `world.ts`) and every one of them moves the world's
numbers, so measuring spec N against a baseline that spec N+1 is concurrently changing
would produce evidence about nothing.

## What was measured before any of this was designed

Five read-only analyses ran against `main` at `b924a35`, each with a working prototype.
Their findings are the load-bearing constraints below; the per-spec files carry the
detail. The five results that changed the design:

1. **The coastline membrane has no restoring force.** Net drift is 4–22% of gross flux and
   the sea ends roughly where it starts — there is no attractor. Measured headroom from the
   shipped equilibrium to the runaway-drain knee is **≈6 percentage points of world
   surface**, and today's worst net ratchet is **0.054 pp/game-year** (crucible). Every new
   water↔land edge is a pure ratchet whose full magnitude accumulates linearly. This is the
   budget the whole epic spends.

2. **A heat-gated evaporation edge closes a positive feedback loop whose gain is greater
   than one.** `world.ts:188` gives every water neighbour **−3.0 heat**; converting one to
   desert swings a neighbouring sea tile by **+4.2**. That is larger than the `+2.5` albedo
   that sterilised a world and the `−0.8` ice term that latched one. Measured: halving the
   sea gave ~3.5× more above-threshold exposure *per remaining sea tile*. The loop is open
   today only because nothing converts water to land on the basis of heat.

3. **A small solar beam freezes the world without failing the liveness test.** Coverage, not
   heat budget, is what the world consumes: below radius ≈8 the world latches, and the gate
   that notices is `sim:check`, not `sim`. Re-measured at HEAD (post-spec-2), `anvil`, 1200 d,
   radius the only variable — at r=2 the beam covers 28.46% of the world, **passes** liveness
   test 1 (entropy 0.686, churn 0.180%), and leaves **61.56% of the world with no live
   out-rule and six biome families latched**. At r=8 coverage is 93.34% and invariant 8 is
   15.78%; from r=12 up, coverage saturates at 100%.

   ★ *The original prototype figures for this finding (7.5% coverage, "identical to no beam",
   75.13% latched) came from a different track — absolute row amplitude, different oscillation
   count — and do not reproduce on the shipped geometry. Superseded, not deleted, because the
   conclusion they supported is intact and the way they survived into GM-facing text is itself
   a recorded defect (spec 1 review, finding 1).*

4. **The purity contract's stated justification is already obsolete.** `cycles.ts:43-45`
   defends `dayState` purity with lazy fast-forward of unobserved regions; `ARCHITECTURE.md`
   decision 10.1 formally abandoned that property for terrain, and terrain is stepped every
   step at coarse resolution rather than reconstructed. A world-reading cycle is therefore
   affordable — and was measured to resolve cold-start identically to day-by-day simulation
   on 501/501 days.

5. **River growth is a directed branching process and only elevation bounds it.** With a
   downhill gate, 1.88% of the world; without, 24.91% and climbing. And rivers must be
   `water: false`: counting them as water annihilated the biome (1.14% → 0.00%) *and*
   opened a +1.5 pp water ratchet in four game-years.

## The specs, in order

| # | Spec | File | Moves goldens |
|---|------|------|---------------|
| 1 | The cycle contract grows two channels, and the sun travels a sinusoid | `2915cb06-1_contract-and-beam.md` | yes (beam only) |
| 2 | The sea's temperature reaches inland | `2915cb06-2_thermal-inertia.md` | yes |
| 3 | Water is two-way traffic | `2915cb06-3_water-chemistry.md` | yes |
| 4 | Weather systems that travel, morph and die | `2915cb06-4_weather.md` | yes |
| 5 | Rivers | `2915cb06-5_rivers.md` | yes |
| 6 | Re-baseline and tell the truth about it | `2915cb06-6_rebaseline.md` | authoritative |

Specs 1–5 each re-run `npm run sim:golden -- --update` as part of their own commit and
record the new hashes, per R-010. Spec 6 is where `SIMULATION.md` and `README.md` are
brought back to the truth in one pass, because re-measuring them five times would be five
sets of numbers that were each true for one commit.

## Standing constraints for every spec in this epic

- **The water budget is a shared account.** Any new water↔land edge must report its measured
  net contribution in **pp of world per game-year**, against a per-epic ceiling of
  **0.05 pp/y per edge** and **0.125 pp/y in total** (the latter is `sweep.ts`'s own fail
  threshold, 5 pp over 40 game-years). An edge that cannot state its number has not been
  measured and does not ship.
- **Never gate a feedback on a quantity the feedback can create.** Classify storms on
  `BiomeDef.water && !molten` (geography), never on moisture — a wetness-gated storm was
  measured latching to 100% rain share. Gate evaporation on geometry
  (`waterNeighbours <= 2`), never on heat alone, for the reason in finding 2.
- **The `still` control MUST keep failing** (R-005). Every spec reports it.
- `npm run typecheck`, `npm run sim:check` and `npm run sim:golden` are green at every
  spec boundary. `sim:check` invariant 8 (escapability) is the one that catches latches;
  its per-biome limit is 2% and the baseline already reports forest at 2.67% under a
  three-year settle, so the margin is thinner than the shipped check suggests.

## Local deviation from the framework

Per `CLAUDE.md` there is no GitHub remote, so the epic squash-merges into `main` and stops
for user review. Additionally: because the six specs are strictly sequential and each has
exactly one writer, they land as sequential reviewed commits inside the epic worktree
rather than each taking its own child worktree. Worktree isolation exists to stop
concurrent writers, and there are none here; the review gate before each commit is kept.

## Open decision, held by the user

**Beam radius.** The user declined to fix a size and asked to set it themselves. Spec 1
therefore makes `radiusHexes` a first-class GM knob and must deliver a measured
radius → (coverage, entropy, churn, liveness verdict, invariant-8 escapability) table so
the choice is informed rather than blind. The shipped default is the orchestrator's, not
the user's, and is to be stated as such.
