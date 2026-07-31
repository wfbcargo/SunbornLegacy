# 0038 — Stat buffs and debuffs do not stack within polarity

Status: accepted
Date: 2026-07-31
Amended: 2026-07-31 (buff + debuff net)
Epic: `70a8a238_battle-sim`

## Context

Multiple weaken/hex sources could overwrite each other in either direction, and a
future accuracy or speed buff stack would make "can this body die?" unreadable
again — the same class of problem cooldown healing created (decision 0037).

Clarification: forbidding all stacking was too strong. Opposing polarities on the
same stat should still combine so a +10% accuracy buff and a −20% accuracy debuff
net to −10%.

## Decision

**One effect per polarity per stat.** For any given stat (damage dealt, accuracy,
speed, dodge, …):

1. **Buffs do not stack with buffs.** Only the most impactful buff applies
   (larger magnitude; equal magnitude keeps the longer duration).
2. **Debuffs do not stack with debuffs.** Same rule on the debuff channel.
3. **The strongest buff and the strongest debuff do stack.** Effective modifier
   is their sum (buff positive, debuff negative) — e.g. +10% and −20% ⇒ −10%.
4. A weaker same-polarity effect is a no-op — it does not queue under the
   stronger one and does not resume when the stronger expires.

Root is binary (cannot move); "most impactful" is simply longest duration
(`Math.max`). It has no opposing buff polarity today.

## Out of scope

**Ward armor grants are a stock, not a modifier.** `+8 armor` adds to the armor
pool — it is not an "armor %" buff channel. Wards may still add. If a later
armor-multiplier buff/debuff pair appears, that channel follows this decision.

## Consequences

- Each modifiable stat needs up to two slots: best buff and best debuff.
- `applyTimedMagnitude` picks the winner within one polarity; `netPolarMods`
  combines the two polarities when both are live.
- Weaken today is debuff-only (outgoing damage cut); a future "empower" would
  occupy the buff slot on the same channel and net against it.
- Ability cooldown still spends when a weaken/root hits but fails to stick.
- Event text records the no-op so replays stay honest.
