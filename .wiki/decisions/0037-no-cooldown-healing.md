# 0037 — No healing in combat kits

Status: accepted
Date: 2026-07-31
Amended: 2026-07-31 (mend kind removed from kernel)
Epic: `70a8a238_battle-sim`
Supersedes: `0036-mend-is-ally-aoe-and-loses-the-focus-race.md`

## Context

Healer math made it hard to answer whether a character can take the damage being
thrown at them. Cooldown HP restore turns every fight into a throughput race.

## Decision

**No combat ability restores HP.** The `mend` ability kind, factory, and resolve
path are removed from the kernel. Saltwise and Choir are warders (ward / weaken /
light strike). Damage sticks; armor and positioning buy time.

A later limited-use tool or piece of gear may reintroduce HP restore as a separate
system — not as a repeating cooldown ability on the priority list.

## Consequences

- Scenario `mender-trial` became `ward-trial`.
- `healingDone` stats remain (always zero until a future system writes them).
- Tuning damage and HP can proceed without a heal-vs-DPS spreadsheet.
- Restart `battle:view` after roster changes — Node caches modules for the server
  process lifetime.
