# 0036 — Mend is an ally AoE and loses the focus race

Status: superseded by `0037-no-cooldown-healing.md`
Date: 2026-07-31
Epic: `70a8a238_battle-sim`

## Context

Single-target mend at the old numbers (Saltwise 12/3 cd, Choir 14/4 cd) could match or beat
an equal bruiser's damage cadence on one body. Healing then became a win condition rather
than a stall / group-support tool.

## Decision

1. **Every mend is an AoE.** Like volley, it centres on a primary (most-hurt ally in
   range) and applies `heal` to every living ally within `aoe` hexes of that primary —
   full amount, not half-splash.
2. **Per-target heal stays below equal-attacker cadence.** Menders win by covering a
   clump, not by out-racing a single strike priority on one fighter.

Tuned baseline (measured against bruiser ~12 dmg / 3 cd):

| Mender | Ability | Heal | CD | AoE |
|--------|---------|------|----|-----|
| Saltwise | Brine Mend | 6 | 3 | 1 |
| Choir | Recovery Hymn | 7 | 4 | 1 |

## Consequences

- Focused HPS on one ally is intentionally lower than equal damage; multi-ally clumps
  get more total healing for free.
- `mend()` factory now requires an `aoe` argument.
- Ward is unchanged — this decision is about HP restore only.

## Superseded

Cooldown mend was removed from all roster kits — see `0037`. The AoE mend resolve path
remains only as a hook for future limited-use tools/gear.
