# Active Project Rules

Flat list, stable IDs. The orchestrator caches this split by `Scope` and passes each
agent only the rules that apply to it. Sub-agents do not re-read it.

## R-001: No dependencies without escalation
Scope: global
Added: 2026-07-29 | Amended: 2026-07-29 (decisions/0004) | Source: package.json
The project runs on Node 24 native TypeScript execution with no build step and no
runtime dependencies. Adding any npm dependency is a structural decision — escalate.
**Exempt: type-only devDependencies** (erased at runtime, so they cost neither of the
properties this rule protects). `typescript` and `@types/node` are approved; a package
shipping executable code still needs escalation however small.

## R-002: TypeScript must pass `tsc --noEmit`
Scope: global
Added: 2026-07-29 | Source: ARCHITECTURE.md#13 Phase 0
Node strips types without checking them, so an unchecked type error runs silently and
produces wrong numbers. Any change must leave `npm run typecheck` green.

## R-003: Claims about the simulator need numbers from a real run
Scope: global
Added: 2026-07-29 | Source: README.md#working-agreement
Never state a metric you did not produce by executing the code. If a run fails, report
it as failing. Estimated or remembered numbers are a defect.

## R-004: Simulation must stay deterministic under a fixed seed
Scope: global
Added: 2026-07-29 | Source: SIMULATION.md
Same seed + same options + same day count ⇒ bit-identical world. No `Math.random()`,
no `Date.now()`, no iteration over unordered structures in stepping code. Use the
seeded RNG in `src/sim/rng.ts`.

## R-005: Churn is the load-bearing liveness metric, not entropy
Scope: global
Added: 2026-07-29 | Amended: 2026-07-30 (spec `2915cb06-6`, biome count only) | Source: README.md#test-1-thresholds
At this taxonomy's size a frozen world can score HIGHER entropy than a living one — measured
at 22 biomes, and the taxonomy holds **23** today. Worse, `biomeEntropy()` divides by
`ln(BIOME_COUNT)`, so entropy's safety margin against `ALIVE_ENTROPY` moves whenever a biome
is added or removed; churn is a total-variation distance and does not. Do not "simplify" the
liveness test back to entropy alone. The still-cycles control MUST keep failing — that failure
is what proves the test discriminates.

## R-006: `erasableSyntaxOnly` — no enums, no parameter properties
Scope: global
Added: 2026-07-29 | Source: tsconfig.json
Node's type-stripping cannot execute TypeScript that emits runtime code. No `enum`,
no constructor parameter properties, no namespaces. Use `const` objects + union types.

## R-007: The sim core stays free of I/O
Scope: src/sim/**
Added: 2026-07-29 | Source: ARCHITECTURE.md#13 Phase 1
Simulation modules compute; they do not print, read files, parse argv, or touch the
network. Presentation belongs to callers (`report.ts`, `run.ts`, the server).

## R-008: Design decisions get written down with their reasoning
Scope: global
Added: 2026-07-29 | Source: README.md#working-agreement
A durable, non-obvious, project-scoped decision becomes a `.wiki/decisions/<NNNN>` entry.
Superseded reasoning is marked, never deleted.

## R-009: The viewer is a local dev instrument, never a product surface
Scope: src/viewer/**
Added: 2026-07-29 | Source: decisions/0001-in-memory-viewer-before-persistence.md
It binds to localhost only, has no auth, and deliberately serves whole-world state that the
real API must never expose. Do not add product features, accounts, or public deployment to
it, and never treat its endpoints as the `/v1/*` contract.

## R-010: `npm run sim:golden` must be green before any merge
Scope: global
Added: 2026-07-29 | Source: decisions/0002-rule-identity-is-derived-from-content.md
The golden hashes are the tripwire for silent simulation drift. Unlike a type error, a
failure here may be *correct* — it means the world changed. If the change was intended:
`--update`, then re-run `npm run sim` and update the numbers in `SIMULATION.md` and
`README.md` **in the same commit**. Updating the hash alone turns the gate into a rubber
stamp and is worse than not having it.
