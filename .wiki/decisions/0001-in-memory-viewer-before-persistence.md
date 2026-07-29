# 0001 — The world viewer runs the sim in memory, ahead of persistence

Date: 2026-07-29
Status: accepted

## Context

`ARCHITECTURE.md#13` sequences the build as Phase 0 (trust) → Phase 1 (sim-core + LOD gate)
→ Phase 2 (Postgres persistence) → … → Phase 4 (API read plane). Under that ordering nothing
is visible in a browser until many weeks in.

The simulator's output today is ASCII printed to a terminal. Every design finding —
disturbance keeping a world alive, cycle sets gating which biomes exist — is spatial, and
reading it as a character grid loses most of it.

## Decision

Build a **local world viewer now**, on top of an in-memory `World`, with no database and no
auth. A small Node HTTP server owns a `World` instance and serves its state to a browser
client that renders the hex grid on a canvas.

Phase 0 hardening and the sim-core extraction land **first**, because the viewer's numbers
are only worth looking at if the simulator is trustworthy.

Explicitly deferred: PostgreSQL, `materializeRegion`/LOD, OAuth, fog of war, the `/v1/*`
contract. The viewer is a **development instrument, not a slice of the product API** — it is
allowed to expose whole-world state that the real API must never expose.

## Consequences

- Something visual exists in days rather than weeks, and every later feature becomes visible.
- The viewer's transport is throwaway; it is not the `/view` endpoint and must not be
  mistaken for it. When Phase 4 lands, the client re-points at the real API.
- Whole-world reads are a **fog-of-war violation by design**. This is safe only while the
  server is local and single-user. Rule R-009 records the constraint.
- Risk: the viewer accretes product expectations and becomes load-bearing. Mitigated by
  keeping it in `src/viewer/`, out of `src/sim/`, with the sim unaware of it.
