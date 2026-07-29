# Project Wiki — Sunborn Legacy

Durable, committed project memory. Read by the orchestrator and sub-agents for context.

| File | What's in it |
| --- | --- |
| [architecture.md](architecture.md) | Current shipped module layout and boundaries. |
| [conventions.md](conventions.md) | Runtime constraints, TS idioms, performance idiom. |
| [rules.md](rules.md) | Active rules (`R-NNN`). Passed to every sub-agent at spawn. |
| [decisions/](decisions/) | ADRs — one file per architectural decision. |
| [gotchas.md](gotchas.md) | Non-obvious pitfalls that bit us once. |
| [glossary.md](glossary.md) | Domain + framework terms. |
| [specs/](specs/) | Per-spec notes that outlive the branch. |

## Relationship to the root docs

The root docs are the *design record*; this wiki is the *engineering memory*.

- `BRAINSTORM.md` — authoritative for design intent. Large.
- `ARCHITECTURE.md` — technical target state, **cut off at BRAINSTORM Session 8**.
- `SIMULATION.md` — verified numbers from real runs.
- `README.md` — entry point and current state.

Agents are handed excerpts from these by the orchestrator; they do not read them whole
(`ARCHITECTURE.md` alone is ~120 KB).

## Numbering

Single-session default: `decisions/0001…0099`, rules `R-001…R-099`. Parallel sessions take
distinct hundred-blocks (see ORCHESTRATION → Cross-session reconciliation).
