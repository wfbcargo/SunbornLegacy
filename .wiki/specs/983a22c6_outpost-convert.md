# Spec 983a22c6 — Caravan ↔ outpost convert

Branch: `main--epic/8d614c77_modular-caravan--spec/983a22c6_outpost-convert`
Epic: `8d614c77_modular-caravan`
Status: done

## Objective

Session 11's most important verb: **settle** a caravan into an immobile outpost
(gaining one basic outpost station slot) and **mobilise** back (destroying that slot
and refunding a portion of its construction). Staffing collapse when the last
character leaves an outpost.

Source: `BRAINSTORM.md` Session 11 (Caravan ↔ Outpost, outposts require a manager).
Epic: `.wiki/specs/8d614c77_modular-caravan.md`.

## Acceptance criteria

1. **`Caravan.form`** is `'caravan' | 'outpost'`. Starting loadout is `'caravan'`.
2. **`settle(caravan)`** — requires `form === 'caravan'` and ≥1 fitted character.
   Sets `form = 'outpost'`, appends one **basic/outpost** station slot (index stable,
   label `Outpost station`). Rejects if already settled or unstaffed.
3. **Immobile while settled.** `deriveStats` reports `ticksPerTile: null` and
   `mobile: false` whenever `form === 'outpost'`, regardless of mount/character speeds.
4. **`mobilise(caravan)`** — requires `form === 'outpost'` and ≥1 character. Removes the
   outpost slot. If that slot held a station, the station is unfitted and a **refund**
   of `floor(constructionCost * MOBILISE_REFUND_RATIO)` scrap is returned (ratio **0.5**,
   locked this slice — Session 11 open question). Sets `form = 'caravan'`.
5. **Staffing collapse.** Unfitting the last character while `form === 'outpost'`
   destroys the outpost (same slot removal + refund as mobilise) and leaves
   `form = 'caravan'` with `staffed: false`. Reject path names the collapse.
6. **Catalog:** at least one `basic/outpost` station (e.g. `outpost_farm`) with a
   positive `constructionCost`. Caravan stations keep `constructionCost` too so
   refunds are uniform.
7. **`npm run caravan`** prints `form` and `mobile`. Optional `--settle` settles the
   starting loadout before printing.
8. **Lab UI** exposes Settle / Mobilise buttons and shows form + mobile in stats.
   Fitting an outpost station into the outpost slot works; caravan stations still
   refuse that slot.
9. **`npm run typecheck` green.** `npm run sim:golden` unmoved.

## Scope

**May touch:** `src/caravan/**`, `.wiki/specs/983a22c6_outpost-convert.md`,
`.wiki/specs/8d614c77_modular-caravan.md` (mark spec 2), `.wiki/glossary.md` (outpost).

**Must not touch:** `src/sim/**` (except existing rng imports), `src/battle/**`,
`src/viewer/**`, golden hashes. No tile occupancy / spacing (no world map yet).

## Boundary decisions (do not relitigate)

- **No tile / spacing checks** this slice — one settlement per tile lands with movement.
- **Refund ratio = 0.5.** Documented as a named constant; retune later with economy data.
- **Collapse ≠ derelict.** Last character leaving destroys the *outpost*, not the wagon;
  derelict-on-death is still the Session 11 open question.
- **Outpost slot is additive** — caravan station slots remain while settled.
- **Mobilise requires staffed** — you cannot abandon-by-mobilise; collapse handles the
  unstaffed path.
