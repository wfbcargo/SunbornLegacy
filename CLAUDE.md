# Sunborn Legacy — session instructions

## Orchestration

This project runs the **claude-architect** framework. The methodology is defined in
`~/.claude/plugins/cache/paul-claude-plugins/claude-architect/0.1.1/ORCHESTRATION.md` —
read it at session start. In short: classify work into epic / spec / implementation, write
the artifact before spawning, run each implementation in its own git worktree under
`.worktrees/`, and squash-merge upward through a review pipeline.

Project wiki: `.wiki/` (committed). Read `.wiki/rules.md` once at session start and cache it
split by `Scope`; pass each sub-agent only its applicable slice. Sub-agents do not re-read it.

### Local deviations from the framework defaults
- **No GitHub remote.** Where the framework says "open a PR into the active branch", the
  top-level unit instead squash-merges into `main` and stops for the user to review the diff.
- Agent model tiers: orchestration + architecture-audit → `fable`; implementation, fix,
  review, spec-audit, merge → `opus`.

## Running the project

Node 24, native TypeScript execution, **zero dependencies, no build step**.

```
npm run typecheck    # tsc --noEmit — must be green before any merge
npm run sim          # full run: map + charts + both liveness tests
npm run sim:check    # transition-graph invariants (single SCC)
npm run sim:sweep    # cycle parameter sweep
npm run sim:trace    # day-by-day trace of one disturbance cycle
```

`npm run sim` takes ~10–30s at default size. Prefer `--days 300` while iterating.

## Non-negotiables

Full list in `.wiki/rules.md`. The two that bite hardest:

- **Run it before you claim it.** Every number about the simulator comes from an actual run,
  pasted from real output. If it fails, report it as failing.
- **Determinism.** Same seed + same options ⇒ bit-identical world. No `Math.random()`, no
  `Date.now()` in stepping code.

## Document map

`README.md` (state) · `PITCH.md` (product) · `BRAINSTORM.md` (design truth, ~82 KB) ·
`ARCHITECTURE.md` (technical target, ~121 KB, **cut off at BRAINSTORM Session 8**) ·
`SIMULATION.md` (verified numbers).

The two large docs are not read whole — the orchestrator hands sub-agents excerpts.
