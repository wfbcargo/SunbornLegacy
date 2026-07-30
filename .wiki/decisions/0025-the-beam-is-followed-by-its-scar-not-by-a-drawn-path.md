# 0025 — The beam is followed by its scar, not by a drawn path

Date: 2026-07-30
Status: accepted
Spec: `0280c42b`
Decided by: `impl-wandering-sun-3c7e14`

## Context

Spec `0280c42b` quoted the user's ask as "players will want to predict its movements which
they can do by following its path", and its criterion 8 turned that into a rendering task:
draw the beam's current position, draw its **forward track**, draw every live storm and
its **projected path**.

That reading was wrong, and the user corrected it mid-implementation:

> "One clarification, I didnt mean to render its path. I simply meant that because of the
> immense heat of the beam effecting the biomes, it will be easy to see where it has been
> because of the biome changes preceding it"

**The path is meant to be read off the ground.** The beam's trail is glass, ash, lava and
desert — the biome changes it leaves behind — and following the sun means looking at the
terrain, not at an overlay. That is a property of the simulation, visible in any render of
the biome grid including the plain ASCII map `npm run sim` already prints, and it is
available to a player inside the fiction rather than through a HUD.

## Decision

**No forward tracks, and no projections. Followability is a simulation property.**

Removed: `SolarBeam.pathAhead`, `Weather.sightings`, `StormSighting`, `TrackPoint`, the
storm fields carried only to project a track (`label`, `track`, `birth`, `life`), the
client's `strokeWrappedPath`, and the wire encoding that flattened paths onto every frame.

Kept: `World.sky()` and `BeamSighting`, reduced to **where each sun is right now**, plus
the great-year numbers for the panel. That is orientation, not prediction — and it earns
its place by letting a reader check that the scar and the sun agree, which is exactly the
claim this decision rests on.

## What this does to the choice of radius

This is the part worth carrying forward, because it changes what a default is FOR.

Partial coverage was already required ("The intention is partial coverage"). It is now
doing double duty: **a beam that burns everything leaves no trail to follow.** At the
previous default of `radiusHexes: 16` on the old track, one pass covered 100.00% of the
map — there was no unburned ground for the burned ground to be legible against, so the
scar carried no shape at all. Legibility of the trail is therefore a constraint on radius
in the same way escapability is, and it pushes in the opposite direction to severity.

Measured at the shipped defaults (radius 6, 3 oscillations, 60-day traverse), one pass
covers 30.64% and the great year covers 100% — so at any moment roughly two thirds of the
world is unburned and the wave stands out against it, while nothing is permanently spared.
The scar renders in `SIMULATION.md`'s legibility section show what that looks like beside
radius 2 (too faint) and radius 16 (no trail).

## Superseded reasoning

The withdrawn draft of this decision argued three things. Two are dead with it; one
survives and is worth keeping in view.

**Dead — "two kinds of future, drawn differently."** It proposed rendering the beam's
forward track solid (`basis: 'exact'`, since a beam does not read the world) and storm
paths dashed (`basis: 'projected'`, since `readsWorld` makes their survival terrain
dependent), so that the drawing could not overstate what the simulation knows. The
reasoning was sound and the feature should not exist. `CycleForecast.basis` still carries
the distinction for the API, where it is still needed — decision `0007`.

**Dead — the 45-day, 4-samples-a-day wire budget** for paths on the frame header. With
positions only, the sky is ~250 bytes against 69,120 bytes of byte planes at 240×144, and
there is nothing left to budget.

**Survives — the sim computes it, the client does not.** `sighting()` calls the same
`dayState` the simulation steps, so the marked sun is the sun that burned the ground. A
client-side sinusoid would have been the **third** implementation of one curve, and
decision `0008` records that this repo already got two separate beam seam bugs from having
two. The overlay is also still on its own canvas rather than painted onto the map, because
the map is redrawn by diff (decision `0003`) and anything painted into that buffer smears
across the frames the diff does not happen to cover.

Two torus details survive with it, both of which would otherwise read as bugs: the marker
is an **ellipse**, because a hex ring of radius r reaches `r · hexW` sideways against
`r · rowStep` vertically and a circle overstates its vertical reach by 15%; and it is drawn
at **all nine torus offsets**, so a disc straddling the seam appears on both sides while
the canvas clips the eight that miss.
