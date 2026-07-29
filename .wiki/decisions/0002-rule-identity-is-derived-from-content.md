# 0002 — A transition rule's identity is derived from its content, not its array position

Date: 2026-07-29
Status: accepted
Spec: `495707fd_sim-trust`

## Context

Every terrain transition is decided by `rollAt(worldSeed, tileIndex, day, <rule>)`. The
fourth coordinate selects which stream of dice the rule draws from, and it used to be `r` —
the rule's **index in its per-biome bucket**, which is a function of the order rules happen
to appear in the `RULES` array in `biomes.ts`.

That made a rule's dice a property of the array rather than of the rule. Inserting a rule,
moving one, or adding a biome to a predicate-derived fan-out renumbered every rule after it
and handed each a different stream. Concretely: **editing the erosion rules changed what the
forests did.** Every recorded figure in `SIMULATION.md` shifted for reasons unrelated to the
edit, and nothing anywhere reported it.

This is the worst shape a defect can take in a simulator whose entire value proposition is
that its numbers can be believed. It is invisible, it contaminates every A/B comparison
between two rulesets, and it gets *more* damaging the more carefully someone iterates —
because each iteration re-rolls the world underneath the measurement they are trying to make.

## Decision

A rule's identity is **derived from its content**:

```
ruleKey(r) = `${BIOMES[r.from].key}->${BIOMES[r.to].key}:${r.label}`
```

hashed with FNV-1a to a 32-bit `keyHash`, which is what `evaluateTile` passes to `rollAt`.

Three supporting choices:

- **`RuleDef` and `Rule` are separate types.** Rules are authored as `RuleDef` (no identity)
  and `RULES` maps them to `Rule` (with `key` and `keyHash`) once, at module load. Identity
  therefore cannot be authored by hand, so two rules cannot claim the same one by accident
  and a rule's identity cannot be changed without changing what the rule says.

- **`label` is part of the key.** `from`/`to` alone is not unique — glass has three exits,
  bloom has two edges to forest at different medians. The alternative (a hand-written `id`
  field per rule) reintroduces exactly the hand-maintained-uniqueness problem the derived
  biome sets in `biomes.ts` were built to eliminate.

- **`invariants.ts` checks both the strings and the hashes are unique.** Two rules sharing a
  stream is not cosmetic: on any tile where both preconditions hold, the second draws the
  number the first already drew, so the first always wins and the second becomes dead code —
  while the graph checks still count it as a live edge.

## Verification

Insert a rule that can never fire (`when: () => 0`) at the head of `RULES` and hash the
resulting worlds. Under positional keying both worlds move; under content keying neither does.

| | old keying | content keying |
|---|---|---|
| baseline, `still` | `0c4d5c1bd222dc2b` | `ea1caa9f367a0453` |
| + dead probe rule | `0f61f686021ee87c` | `ea1caa9f367a0453` |
| baseline, `crucible` | `cbfbb340506e0ae6` | `f4bece63b740b9e2` |
| + dead probe rule | `6ba6dd80f4bb49d1` | `f4bece63b740b9e2` |

## Consequences

- **Reordering `RULES` is now a no-op for outcomes.** Array order still sets *precedence*
  within a biome's bucket — first rule to fire wins — but nothing else. Those are now two
  separate concerns instead of one tangled one.

- **Every previously recorded number was invalidated** and has been re-measured from actual
  runs. The verdicts did not move: `crucible` still passes both liveness tests (entropy
  0.753, churn 3.92%) and `still` still fails (0.647, 0.04%). The findings were properties of
  the ruleset, not artefacts of its array order — which is the result you want, and was not
  guaranteed in advance.

- **Renaming a rule re-keys it and changes the world.** This is the cost of deriving identity
  from content, and it is accepted: a rename is a deliberate edit to the rule, where a reorder
  is not. `npm run sim:golden` exists partly to make such a change loud instead of silent.

- **A new failure mode is possible but checked:** a 32-bit hash collision between two distinct
  keys. Vanishingly unlikely at 160 rules and completely invisible if it happened, which is
  why `invariants.ts` uses a `Set` rather than an appeal to the birthday bound.

## Alternatives rejected

- **A hand-written `id` on every rule.** Restores the trap that derived biome sets exist to
  kill: uniqueness maintained by human attention across 160 entries, with a silent
  rate/precedence bug as the failure mode.
- **Hashing the `when` function source.** Identity would then change with whitespace,
  minification or a refactor that preserved behaviour exactly. Strictly worse than `label`.
- **Keeping positional keying and forbidding reordering by convention.** A convention that
  must be remembered by everyone forever, whose violation is undetectable, guarding a
  correctness property. That is the arrangement this decision exists to end.
