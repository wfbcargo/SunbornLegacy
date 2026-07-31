# 0039 — Derelict on last character

## Decision

When a caravan or outpost loses its **last fitted character**, the vehicle does not
vanish. It becomes **`Form.derelict`**: chassis, stations, and cargo remain; travel,
settle, survey, and deploy are blocked until another character **salvages** it by
fitting into a free character seat.

## Why

Session 10–11 open Q1: last-character death must re-enter materials into the world.
Derelict salvage matches the Legacy theme and gives exploration a payoff. Destroying
the caravan would erase cargo and teach players nothing.

## Consequences

- Starve / unfit paths call `markDerelict` when character count hits 0 (after outpost
  collapse if applicable — collapse first, then derelict if still no characters).
- Salvage is the only way back to `Form.caravan` from derelict this slice.
- Biome consumption of abandoned salvage (Session 12) is **not** implemented yet.
