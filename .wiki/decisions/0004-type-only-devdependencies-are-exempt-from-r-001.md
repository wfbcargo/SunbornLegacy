# 0004 — Type-only devDependencies are exempt from R-001

Date: 2026-07-29
Status: accepted
Spec: `495707fd_sim-trust`
Decided by: orchestrator, on escalation from `impl-sim-trust-a4f19c`

> **Numbering note.** The orchestrator's ruling named this file `0002`. `0002` was already
> taken by `0002-rule-identity-is-derived-from-content.md`, which is cross-referenced from
> `SIMULATION.md`, `README.md`, `.wiki/gotchas.md` and a commit message, so this entry took
> the next free number instead of breaking those references.

## Context

R-002 requires `tsc --noEmit` to be green. R-001 requires escalation before adding any npm
dependency. Satisfying the first turned out to need something that trips the second, so the
two rules met and had to be reconciled.

`typescript` was already sanctioned by `ARCHITECTURE.md#13` Phase 0. Installing it and running
`tsc --noEmit` for the first time produced **94 errors — every single one a missing Node host
global** (`process`, `console`, `performance`; TS2591/TS2584/TS2304). Filtering those three
codes left an empty list.

**There were zero substantive type errors.** This is worth stating plainly because it is easy
to misread the number: nobody fixed 94 bugs. The codebase's types were already sound, and what
was missing was a declaration of the environment it runs in. Which means the typecheck gate
**found nothing on the day it was introduced, and its entire value is prospective** — it exists
to catch the *next* `--beam-period` (see `SIMULATION.md` bug #6), not to have caught anything
today.

## Options considered

- **(a) `@types/node` as a second devDependency.** Canonical, accurate, maintained.
- **(b) A hand-written ambient `src/host.d.ts`** declaring only the five members used. Zero
  dependencies; honours R-001's letter exactly.
- **(c) Add `"DOM"` to `lib`.** Rejected outright by the implementing agent and confirmed on
  review: it does not supply `process` at all, and it would make `window`/`fetch` visible to
  Node code — *hiding* real errors rather than surfacing them. Strictly worse than either
  alternative.

## Decision

**Take (a).** `@types/node` is approved as a devDependency alongside `typescript`. Those two
and nothing else. `src/host.d.ts` was written and then deleted.

**R-001 exists to protect two properties: zero runtime dependencies, and no build step.** A
type-only package costs neither — it is erased entirely and never appears at runtime. Option
(b) honoured the rule's letter while spending a real correctness property: a hand-maintained
model of someone else's API, drifting over time, in exactly the file (`invariants.ts`) whose
job is to fail loudly. `process.exit` returning `never` rather than `void` is the concrete
example — get that wrong by hand and TypeScript believes execution continues past a fatal
invariant failure, which defeats the point of having a typecheck at all.

That trade is backwards, so the rule was amended rather than obeyed.

## ★ Installing `@types/node` is not sufficient on TypeScript 7.x

**TypeScript 7 (the native port) does not auto-include `@types/*` packages the way 5.x does.**
Measured on this tree, with `@types/node` present on disk in both cases:

| | errors |
|---|---|
| `typescript@7.0.2`, no `types` entry | **114** |
| `typescript@7.0.2`, `"types": ["node"]` | **0** |

The failures are the same TS2591/TS2584 host-global errors as before installing anything — so
without the config entry `@types/node` *looks* installed while the typecheck still reports a
wall of phantom errors in code that is completely fine. A future agent would reasonably
conclude the codebase was broken.

**The fix belongs in `tsconfig.json`, not on a command line**, so `npm run typecheck` is correct
however it is invoked:

```json
"types": ["node"]
```

Staying on 7.x with an explicit `types` entry is preferred to pinning `typescript@5.x`:
explicit configuration beats relying on a particular version's auto-include behaviour.

(The viewer spec measured 119 on the same finding where this branch measures 114. The
difference is tree contents — this branch adds `golden.ts` — not a disagreement.)

## Consequence: how Node and browser types coexist

The viewer epic puts browser code in the same repo, and browser code needs DOM types that Node
code must never see. The arrangement is deliberate and is the correct one, not a workaround:

- Root `tsconfig.json` keeps `"lib": ["ES2023"]` and `"types": ["node"]`. **`"DOM"` is never
  added to the root lib.** Node code must not see `window`/`fetch`; browser code must not see
  `process`.
- **No `exclude` is needed.** The viewer's client lives at `src/viewer/public/` and is plain
  `.js`, so `"include": ["src/**/*.ts"]` already leaves it out. An earlier revision of this
  decision carried `"exclude": ["src/viewer/client/**"]` — a path that does not exist, matching
  nothing. Dead config, since removed.
- If client code is ever written in TypeScript, it gets its own scoped `tsconfig.json`
  extending the root with `lib: ["ES2023", "DOM"]` and no node types.

This was a genuine cross-spec collision: `tsconfig.json` sits in the sim spec's scope while the
need for DOM types sits in the viewer's, so whichever landed second would have broken the
other's typecheck. Recording the shape here is what stops it being rediscovered.

## Consequences

- Two devDependencies, zero runtime dependencies, still no build step. The property R-001
  protects is intact.
- R-001 is amended (see `.wiki/rules.md`) so this does not get re-escalated. A *runtime*
  dependency still requires escalation, unchanged.
- The exemption is narrow and deliberately so: **type-only** means erased at runtime. A package
  that ships executable code is not covered however small it is.
