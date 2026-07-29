# Sunborn Legacy — Brainstorm

Raw idea capture. Nothing here is decided. Fiction first, mechanics inferred.

---

## Session 1 — Cosmology & Premise

### The Sun
- Multiverse of worlds, but **one sun**, existing across all multiverses simultaneously.
- Every other celestial body orbits it, indefinitely.
- Divine beings exist *as* celestial bodies. The Sun God is primary among them.
- Despite the "multiverse" framing, it functions as **one massive solar system**.

### The Purge
- Recurring event: the sun purges a planet with intense rays.
- Cast from the planet's **solar moon** — an orbiting body of heat unique to each world.
- Rumored purpose: the Sun God is cleansing planets to see which of his Sunborn are
  **worthy of ascension**.

### Humanity
- Struggles to survive across many worlds. Civilizations rise and fall.
- Most never learn how far humanity has spread across the galaxy.
- **Humanity cannot directly convert solar power.** They must build machines to do it.
  → This is the factory layer. Machines are humanity's answer to divinity.

### The Sunborn
- Rarely, a child is born capable of manifesting the divine power of the Sun God.
- Withstand immense heat and cold.
- Powers manifest in wildly different forms: demons, shadows, mages, druids,
  necromancers, and more.
- **Sunborn ARE the direct conversion humanity otherwise lacks.**

### Tone / Aesthetic
- Solarpunk.
- Flora and fauna possess magic derived from the sun.
- Solar plates, wildly blooming flowers, ethereal projections.
- Warmth, growth, overgrowth — but with an apocalyptic clock overhead.

---

## Mechanical Seeds (my read — unconfirmed)

These fall out of the fiction almost for free:

| Fiction | Possible mechanic |
|---|---|
| One sun, many worlds | Shared backbone (economy/market/server) + per-world shards |
| The Purge | Prestige / world reset. The idle-game reset *is* canon |
| Solar moon | Per-world doom clock. Visible, orbiting, countable |
| "Legacy" | What survives your world's purge and carries forward |
| Machines vs. Sunborn | Two progression axes: industry (build) and divinity (become) |
| Ascension | Endgame / long-horizon goal |
| Civilizations rise & fall | Worlds have lifecycles; new players seed new worlds |
| Isolation from other worlds | Trade must be *discovered* — a mid-game unlock, not a menu |

**Key structural insight:** the theme and the idle-game skeleton are already the same
shape. The purge is not a mechanic bolted onto a story — the story is about a reset loop.

---

## Open Tensions (to resolve)

1. **Isolation vs. trade.** Fiction says civilizations don't know about each other.
   MMO says trade. Reconciling these two is a design opportunity, not a bug —
   discovering other worlds could be a major unlock beat.
2. **Is the purge scheduled or earned?** Timer, threshold, or player-triggered?
3. **Do Sunborn classes matter mechanically** (necromancer vs. druid factory builds),
   or are they flavor over a shared economy?

---

## Session 2 — Player Model, World, Simulation

### The Player
- **The player is not a character.** No avatar. The player is a manager.
- Players manage **characters**, grouped into **caravans**.
- Caravans are formed, split, and reorganized at will.
- Start state: **2 random characters + 1 basic caravan vehicle**, pulled by a
  slow, durable **crabbeast**.

### World Map
- **Hexagonal tile map that wraps back onto itself** like a globe.
- Each tile is a geography. Tiles may contain cities or towns.
- **No space travel.** No ships, no rockets.
- **Inter-world travel is magical and conditional** — each world has its own key:
  - An abyssal world of the dead: reachable only by *dying within its aura*.
  - A small oasis planet: reachable only through a rare rift constructed by an
    alcove of Sunborn druids.
  → Worlds are secrets with entry conditions, not destinations on a menu.

### Living Terrain (cellular automaton)
The world is never static. Every tick, tiles transform based on their own
temperature and the state of neighboring tiles.

- Island surrounded by ocean → slowly erodes into ocean.
- Forest under sustained heat → desert.
- Desert struck by a burning ray → **field of glass**.

→ The solar moon's purge is not a cutscene. It physically rewrites the map.

### Ticks
- **1 tick ≈ 6 real seconds.** (10/min · 600/hr · 14,400/day)
- World terrain updates every tick.
- Caravans have a **speed** measured in ticks per tile.
  - A very fast caravan: 1 tile / 4 ticks (24s per tile).
- **A caravan travels at the speed of its slowest member.**

### Caravans & Vehicles
- Caravans can include **vehicles**, outfitted and upgraded via slots:
  mounts, rooms, crafting/manufacturing stations.
- **Basic caravan vehicle loadout:**
  - 1 medium mount slot
  - 4 wheel slots
  - 4 character slots (1 driver + 3 misc)
  - 4 station slots (food growing, water collection, cargo chest, med station…)

### Consumption & Logistics
- Characters **require food**.
- Manufacturing **requires ingredients**.
- Vehicles may run on **solar batteries**, produced by a **solar generator**.
→ Nothing is free. Every system has an input.

---

## Open Questions — Session 2

1. **Offline behavior.** The world ticks whether or not you are logged in. Do your
   characters keep eating? Can you return to a starved caravan? This is *the*
   defining question for an idle MMO with consumption.
2. **Scale.** Tiles per world × worlds × concurrent players. Determines whether the
   terrain CA is trivial or the hardest problem in the project.
3. **Sunborn acquisition.** Are the 2 starting characters Sunborn, or ordinary
   humans? How does a Sunborn enter your roster?

---

## Session 3 — Stochastic Simulation & Level of Detail

### Core principle: fuzzy, not physical
World ticks are **not** a deterministic equation. Every transition carries a large
element of randomness. What matters is **inevitability**, not precision.

> An island surrounded by water will become water in **10–10,000 ticks**,
> distributed around **~1200 ticks**.

Benefits: cheaper, more alive, no physics engine required, and outcomes feel
fated rather than calculated.

### Level-of-detail simulation
- **Observed / discovered regions:** simulate tick by tick, full fidelity.
- **Undiscovered / unwitnessed regions:** simulate in batches of thousands or tens
  of thousands of ticks at once.

### Why this actually works (the underlying math)
Randomizing transitions is what *permits* fast-forwarding. Instead of stepping a
tile 10,000 times, sample its transition time directly — O(1) instead of O(ticks).

**Stronger form — event-driven simulation:** rather than batching by time, have each
tile schedule its *next* transition into a priority queue. Advancing the world =
popping events until the target timestamp. Cost becomes proportional to the number
of **actual changes**, not to (tiles × ticks). A stable forest costs nothing to
simulate for a century. A coastline under erosion costs exactly what it should.

**Storage requirement:** a spread of 10–10,000 centered on 1200 is not exponential,
so it is *not* memoryless — the tile's age matters. Store `state_entered_at` per
tile and sample from the conditional distribution given elapsed age. Cheap, and it
makes arbitrary distributions (log-normal, Weibull) legal.

**Determinism:** seed the PRNG per tile (`hash(world_seed, tile_id, epoch)`) so a
fast-forward is reproducible and auditable rather than a one-way dice roll.

---

## ⚠️ Biggest risk: absorbing states / heat death of the map

Every rule described so far is a **ratchet**, and every ratchet ends in a sink:

    island → ocean          (never back)
    forest → desert         (never back)
    desert → glass          (never back)

Run that forward 100,000 unobserved ticks and the map converges on a featureless
absorbing state — a dead ball of ocean, sand, and glass. Fast-forwarding doesn't
cause this; it just **reveals it faster**. Tick-by-tick has the same fate, only
slower.

The fix is that the system must be a **cycle, not a ratchet**. Every sink needs a
generative counter-force:

| Sink | Counter-force |
|---|---|
| ocean | tectonics, silt, coral, land rising |
| desert | rain shadow shifts, rivers, oasis spread |
| glass | weathering, dust, soil accumulation |
| everything | **blooms** — solarpunk flora aggressively reclaiming ground |

This is also the thematically correct answer: the sun purges, and life blooms back.
Death and rebirth is already your cosmology. The map should breathe.

**Design target:** the long-run terrain distribution should be *stationary and
varied*, not converged. Worth building a headless simulator early that runs a world
1,000,000 ticks and plots biome proportions over time. If the lines flatten into
one color, the ruleset is wrong — and that test is cheap to write before any UI
exists.

---

## Open Questions — Session 3

1. **What counts as "witnessed"?** Player physically present? Owns a city there?
   Within N tiles of any caravan? Any player, or just this one?
2. **What happens at the seam** between a fine-simulated region and a coarse one?
   That boundary is where visible artifacts appear.
3. **Does an observed region resimulate on discovery,** or does the coarse result
   stand as canon once a player arrives?

---

---

## Session 4 — Decoupled Clocks

### Core correction: most systems need no tick at all
Only systems with **neighbor interaction** (terrain) or **contention** (market,
combat) require simulation. Everything else is lazy math resolved on read.

- Caravan travel = `departure_time + duration → arrival_time`. Interpolate position
  on read. Zero server work while traveling.
- Production = `rate × elapsed`, resolved when observed.
- Food, growth, healing = same.

### The Solar Sweep (terrain cadence)
Terrain runs on its own clock, decoupled from movement.

- A **cycle** advances a **spatial band** across the world — a terminator line —
  rather than a random subset of tiles.
- One full revolution ≈ 10,000 ticks (~16.7 hrs). Every tile updated on an exactly
  uniform interval.
- Spatial locality: neighbors load and write together (cache + DB friendly), and no
  tile is ever evaluated against neighbors in inconsistent update states.

**Lore:** a cycle is **the sun's gaze passing over the world**. Terrain transforms in
the wake of the light. Players can see the band crossing the map and know that is
when their coastline gets its dice rolled. The purge is the solar moon *focusing*
that sweep, not replacing it.

### Cost with lazy materialization
World of 10,000 × 5,000 = 50M tiles, every tile swept once per ~16.7 hrs:

| Storage model | Load |
|---|---|
| All 50M tiles materialized | ~833 tile-evals/sec, forever, per world |
| Only touched tiles (~1–2M) | **~17–33/sec** + ~1,000 region updates per sweep |

Unexplored regions exist only as `seed + region climate + last_swept_at`, and
resolve into real tiles when a caravan first approaches. **You only pay for the
parts of the multiverse humanity has actually reached** — which is exactly the
fiction.

### The three clocks

| System | Clock | Cost |
|---|---|---|
| Movement, production, growth, consumption | none — timestamps + lazy resolve | ~0 |
| Terrain | solar sweep, spatial band, ~10k ticks/revolution | small, materialized tiles only |
| Market, combat, world events | event queue, on demand | proportional to activity |

---

## Session 5 — API-First / Programmable World  ★ PILLAR

### The commitment
**Everything a player can do must be doable via API.** Players are actively
encouraged to write software that runs their caravans. MCP servers are a
first-class client, not an afterthought.

- The official web client is **just the first API client**. It gets no privileged
  endpoints, no private calls, no back doors.
- **Every NPC belongs to a player account — even when that "player" is a remote
  server.** There is one entity model. NPC and player-run caravans are the same
  thing with different controllers.
- Developer intent: build the world's NPC population as software against the same
  public API.

### Why this fits the genre unusually well
**Idle is the one genre where bots don't break the game.** In a twitch MMO,
automation steals a reflex advantage no human can match, so bots must be banned.
Here the **clock is the bottleneck** — a caravan crossing a tile in 15 minutes moves
at 15 minutes per tile whether a human, a script, or an LLM is steering.

A bot's edge is *attention* and *optimization*, never APM. That makes automation
safe to embrace instead of expensive to police, and it converts the genre's biggest
weakness (idle games get solved and scripted) into the actual product.

### What NPC-as-account buys
- Uniform ownership, permission, and rate-limit model — no separate NPC subsystem.
- World factions are literally accounts; one can be handed to the community.
- Abandoned player caravans can be adopted by an NPC controller instead of vanishing.
- Load testing and world-seeding = spawn bots.
- Developing NPCs dogfoods the public API continuously.

### REST vs MCP are different shapes
- **REST/WebSocket:** fine-grained, deterministic, high-frequency. For scripted bots.
- **MCP:** coarse, semantic, low-frequency tools for LLM agents —
  `send_caravan_to_nearest_water()`, not `set_heading(37°)`.
  Same authority, different granularity.

### ⚠️ The trap: information symmetry
The API must expose **exactly** what the UI can see — no more. It is very easy to
ship one convenient "give me world state" endpoint that lets bots see through fog
of war and through the undiscovered-region model, permanently invalidating
exploration. Fog of war must live in the **authorization layer**, not the client.

### Rate limits are game design, not infrastructure
Per-account action budgets should be expressed in fiction (caravan stamina, solar
charge, character focus) rather than as HTTP 429s. That single lever keeps bots and
humans on the same footing and doubles as the multi-accounting defense.

### Reference point
**Screeps** — an MMO where players write JS to run their units. Closest existing
analog; a decade-long cult success with a devoted programmer audience. Worth
studying for economy, spectator tooling, and how it handles bot-vs-bot fairness.

### Third-party clients — ANSWERED
Humans playing by hand is a **first-class way to play**. The official client will be
good, fun, and engaging — and third parties are actively encouraged to build better
ones. The client ecosystem is open by design.

This makes the API's audience two distinct groups with different needs:

| Consumer | Needs |
|---|---|
| **Bots / agents** | fine-grained actions, deterministic reads, scheduling |
| **Third-party UIs** | bulk reads, real-time push, map data, **art assets** |

#### Consequences to design in now
1. **Delegated auth (OAuth-style scoped tokens).** Players must authorize a
   third-party client *without* handing over a password or master API key. Scopes:
   read-only spectator vs. full control. Retrofitting this is brutal, and any
   period where players share credentials with third-party clients is unrecoverable.
2. **Real-time push (WebSocket/SSE), not polling.** Twenty clients polling per second
   is both bad UX and a real bill. Bots want the same stream.
3. **Asset licensing + CDN.** A third-party UI needs the sprites, tile art, and
   icons. Decide the license early and serve them publicly, or the ecosystem
   cannot actually exist. Cheap to solve now, blocking if ignored.
4. **API versioning + deprecation policy.** Once third parties depend on it, casual
   breaking changes are off the table. This is the tax on the whole pillar — accept
   it deliberately.
5. **★ Monetization cannot live in the client.** If anyone can build a client, the
   official one can never be the paywall — no client-side ads, no premium UI
   features. Revenue must be **account-level and server-enforced**: subscription,
   server-side cosmetics, roster/caravan slots, compute quota. This is a real
   business consequence of an open client ecosystem and it bites late if unnoticed.

#### Schema-first
An OpenAPI spec becomes the source of truth, generating the MCP server, client SDKs,
and docs. Documentation is a **product artifact**, not a chore.

### Open Questions — Session 5
1. **Multi-accounting.** If NPCs are accounts, what stops one player running 50?
2. **Spectator legibility.** When much of the world is bot-run, watching becomes a
   primary experience. Replay/visualization may be core, not optional.
3. **Rate-limit scoping.** Per account or per token? A player running a bot *and* a
   third-party UI shares one budget — probably correct, but decide deliberately.
4. **Client registry / showcase** to make the ecosystem discoverable.

---

## Session 6 — Progression Model  ★ PILLAR

### Not an exponential game
This is **not** a game where you get exponentially stronger. Some growth over time,
but no multiplier treadmill. **The goal is a real living world.**

> ⚠️ This invalidates the earlier "purge = prestige" framing. Prestige is an
> exponential-curve idea (reset → multiplier → climb faster). Here the purge is a
> **catastrophe you survive or don't**, and *Legacy* means what your people carry
> out of it — not a permanent stat bonus.

### Why this is required, not merely preferred
**Exponential progression and a player-driven economy are incompatible.** In an
exponential game, everything early becomes worthless — week-one iron is a rounding
error by month three, nobody trades it, and the market collapses to a thin band of
the current tier. Flat power means **iron matters in year three the way it mattered
in week one.** Scarcity stays real, prices stay meaningful, routes stay worth
defending.

Same argument for the MMO layer: exponential power makes veterans unbalanceable
against newcomers, and shared worlds become museums. Flat power lets a day-one
player matter.

### Where growth actually comes from: **the factory**
Progression is measured in **what you can make**, not how big a number is. Breadth
of capability, not height of power. (Factorio's model.)

Other things that accumulate: caravans, established territory, infrastructure
(roads/waystones/rifts), rare specialists and Sunborn, relationships and standing
contracts, and **knowledge** — which worlds exist and how to reach them, which never
inflates.

### Regional materials  ★
- Materials are **highly regional**.
- **Every region has enough to survive** — no region is a death sentence.
- Advanced production requires specialized inputs from **all over the world, and
  potentially other worlds**.

**This is the real justification for the big map.** Not just "travel should take
days" — *materials must be far apart*. Distance becomes the price mechanism, and
transport cost is denominated in **real time**, the one currency nobody can inflate.

### The core strategic loop: **build vs. buy**
For any input you lack, two options:
1. Go establish a city/outpost in the region that has it (vertical integration).
2. Buy it from a market — possibly one you built yourself in a city.

The player's stated intent: **buying should often be the easier path.**

> **Central balance target:** these two must stay *close*. If self-sufficiency always
> wins, markets die. If buying always wins, nobody expands or explores. Which one
> wins should depend on situation — distance, route safety, volume, urgency.

### ★★ Killer synergy: the terrain sim IS the supply side
The stochastic terrain model means **resource geography is dynamic**:

- A forest that turns to desert stops producing wood.
- A desert struck by a burning ray becomes a **field of glass** — presumably itself
  a material.
- A bloom reclaims ground and changes what a region yields.

Consequences:
- **No permanent monopolies.** A purge or a bloom can erase a regional advantage.
- **Trade routes must adapt**; a route is a living thing, not a solved path.
- **Scouting has ongoing value**, not one-time value.
- The world map is literally a **live commodity map**.

The living world isn't scenery — it is the economy's supply curve. This is the
synergy that makes the whole design cohere.

### ⚠️ Critical guard: markets must not teleport goods
If a market is just an order book with instant delivery, distance stops mattering,
one player builds the best market, and **regional pricing collapses into a single
global price** — evaporating the entire regional-scarcity design.

Goods must **physically move**. A market is a *place* where physically-present goods
change hands. (EVE gets this right: Jita exists, but hauling is real, so distance
keeps its teeth.)

### Open Questions — Session 6
1. **Depletion.** Do deposits deplete? Depletion + terrain change = a genuinely
   dynamic resource map. No depletion = first-mover monopolies (partially offset by
   terrain change).
2. **Onboarding risk.** Idle games hook players with fast, loud early numbers; a
   living-world sim can't. Wurm Online and Haven & Hearth have brutal onboarding and
   tiny (devoted) audiences. The early hook here is probably **the world visibly
   changing without you** + attachment to specific characters — slower-acting, needs
   deliberate design.
3. **Market ownership.** Does the builder of a market tax it? Control access?
   Whoever builds at a crossroads creates a Schelling point — emergent settlement.

### Every start is a niche — DECIDED
No bad spawns, only different ones. Every region must have *something* worth
exporting. Requires actively auditing the terrain sim for dead zones, which it will
otherwise produce on its own.

---

## Session 7 — The Cleansing & Game Masters  ★ PILLARS

### The Solar Beam
A divine force actively reshapes the world. **Must be telegraphed, never a surprise
punishment.**

- A solar beam obliterates the tiles beneath it with immense heat, slowly singeing
  its way across the entire world.
- Destroys cities. Dries up oceans. Turns sand into glasslike wasteland.
- Visible, predictable, inevitable — a clock every player on the world can read.

**Why it's strong:**
- A shared, scheduled, unavoidable event puts everyone on one timeline.
- Forces **migration** — which makes the huge map necessary rather than expensive.
  You flee across it.
- Creates a **rolling frontier economy**: land ahead of the beam is precious, land
  behind it is ruined-then-recovering.
- **Destroys accumulated infrastructure on a schedule** — the anti-calcification
  mechanism a decades-long persistent world needs. The world itself demolishes
  entrenched advantage.

**The one structural decision — terminal vs. rotating:**
| Model | Meaning |
|---|---|
| **Terminal** — beam crosses once, world ends | Worlds are **campaigns** with an ending |
| **Rotating** — beam circles forever, bloom follows behind | Worlds are **permanent**, with a moving frontier of ruin and regrowth |

Both viable, very different games. **Elegant answer: the GM chooses per world.**
Note: a terminal beam with no regrowth is the heat-death failure mode from Session 3.
A rotating beam needs the bloom cycle (glass → weathering → soil → life) behind it.

**Requirements:**
- Warning time legible in **real-world units** ("the beam reaches your city in
  6 days"), queryable via API.
- **Salvage and evacuation mechanics** are essential. Being able to carry something
  out is what makes destruction *Legacy* instead of *loss*.

---

### Game Masters — one per world  ★ most important idea in the project
Every world gets a **GM** — a human or an AI — responsible for making that world fun
and engaging.

**Powers:** spawn events, spawn NPCs, decide how their world can be reached from
other worlds and how their members reach out.

**Spectrum of control:** basic tools that let a world just run autonomously → total
control to run it however they want.

**Marketing:** GMs advertise their world's character — *"hardcore survival economy,
room for 20 more players."* Proven pattern: Minecraft, Rust, ARK, FiveM, WoW private
servers. Discovery becomes community-driven.

**Campaign worlds:** a world need not live forever — it can be a finite collaborative
task with an ending. Pairs perfectly with a terminal beam: the campaign *is* the
beam's approach.

**Payment model:** charge for worlds. Proven (Minecraft Realms, game server hosting),
and it's account/server-level — which satisfies the Session 5 constraint that
monetization cannot live in the client.

**Why this is the most important idea here:** the #1 killer of MMOs is content
consumption outpacing content production, and a small team cannot out-produce its
players. Distributing content generation to GMs is the *only* realistic path to a
living MMO at this scale. It's not just a fun feature — it's what makes the project
feasible. It also costs almost no new architecture: a GM is an account with an
elevated API scope, and NPCs are already accounts.

#### ⚠️ Guardrails
1. **The GM must not be able to inflate the economy.** Spawning arbitrary goods
   into a player-driven market destroys it. GM powers should shape *events,
   terrain, narrative, and access* — not print tradeable value.
2. **GM actions should be public and logged.** Transparency is the check on
   favoritism and griefing. Players can see what was done to their world.
3. **Autonomous mode must be the default and must be genuinely good.** A world with
   an absent GM must still be worth playing — players blame *the game*, not the GM.
4. **Succession.** GMs burn out; most volunteer GMs quit. Worlds must survive GM
   departure by reverting to autonomous mode or transferring.
5. **Customer shift.** If GMs pay, GMs become the customer and players the product.
   Not wrong, but should be a deliberate choice.

#### ⚠️ Sharpest tension: GM sovereignty vs. the connected multiverse
If GMs fully control inter-world access, they can seal their world — and the
cross-world economy fragments into many small isolated co-op servers. That would
cost the "massively" in MMO.

**Proposed middle ground:** some routes are **cosmic law** (not GM-revocable);
GMs control the *terms* of additional routes — difficulty, cost, ritual, who may
pass — but not whether their world exists in the multiverse at all.

---

## Session 8 — World Cycles & the Shaping  ★ PILLAR + CORRECTION

### ⚠️ Thematic correction: the Sun God SHAPES, he does not destroy
Earlier notes over-read the cleansing as destruction. The correct framing is
**change, not destruction.** Some worlds he destroys — but the theme is
transformation. Worlds are *remade*, not merely ended.

This reframes several things:
- The beam is not a punishment. It is a force of change with a direction.
- Glass wastes are not a graveyard; they are an intermediate state on a longer path.
- "Legacy" is about what persists through transformation, not only what escapes ruin.

### World Cycles — a general system, not one event
The solar beam is **one example** of a *world cycle*. A world may have **any number
of cycles**, in any combination. The goal is a world that feels and stays changing.

Examples:
| Cycle | Effect |
|---|---|
| **Cleansing beam** | sweeping heat; melts, burns, vitrifies |
| **Seasons** | periodic rain / heat / cold shifting the whole climate envelope |
| **Earthquakes** | raise mountains, carve rivers, shatter glass back to sand |
| **Volcanism** | lava flows that cool to basalt and leave fertile soil |
| **Monsoon / storms** | regional moisture surges |

Cycles are the disturbance engine. The sim already proved (see `SIMULATION.md`) that
a world with **no** disturbance converges to a frozen equilibrium — so cycles are not
flavour, they are what keeps a world alive. More cycles, more life.

Each world's cycle set is also its **identity and difficulty**, which is exactly what
a Game Master should be configuring and advertising.

### Material chemistry — transformation chains, not one-way decay
Specific chains called out:

```
sand --(melt)--> LAVA --(cool)--> GLASS --(quake | water over time)--> SAND
                  |
                  +--(cool + weather)--> FERTILE SOIL --> FOREST

ocean + forest --> SWAMP / RAINFOREST
```

Lava is a real intermediate state, not a special effect. Glass has *two* ways back
(shattering by earthquake, slow dissolution by water). Volcanic soil is the fertile
path that grows forests.

### ★ Requirement: the biome graph must be strongly connected
**There must be a path to transform any hex from any biome into any other biome** —
even if it takes a long time or requires rare, difficult events.

**Sparse edges, total reachability.** Most biomes must NOT convert directly into most
others — that would make the world mush. Glass does not become rainforest. But glass
shatters to sand, sand can be watered to barren soil, soil grows grassland, grassland
becomes forest, and a wet enough forest becomes rainforest. The *direct* graph is
sparse and physically sensible; the *reachability* graph is complete.

This is a formal property and it is testable: compute the strongly connected
components of the transition graph. A single SCC means every biome can reach every
other by some path. More than one SCC means some biome is a trap (no way out) or
unreachable (no way in). This should be an automated invariant, checked on every
ruleset change — it is the generalisation of the absorbing-state problem from
Session 3, and it is cheap: one Tarjan pass over ~20 nodes.

Worth also reporting the **eccentricity** of the graph — the longest shortest-path
between any two biomes. That number is "how many transformations, at minimum, to turn
this hex into that one," which is a genuinely interesting design statistic and a good
sanity check that rare biomes are actually hard to reach rather than trivially close.

### Many biomes
The biome set should be substantially larger than the prototype's 12. Directions:
ocean/shallows/ice shelf; marsh/swamp; grassland/savanna/forest/rainforest/bloom;
tundra/glacier; desert/badlands; mountain/rock/basalt/lava/ash/glass/fertile soil.

### Cycle execution model — DECIDED
Cycles do **not** run simultaneously and do **not** reference each other. They run as an
ordered **stack**: on a day where several are active, one applies, then the next.

- **Order must be an explicit, stable priority** — never insertion order. Lazy
  fast-forward of unobserved regions only works if resolving a region 400 days later
  reproduces exactly what tick-by-tick would have. A reorderable stack breaks
  determinism silently.
- **One transition roll per tile per day, after the whole stack has run.** Cycles
  modify heat, moisture, and flags; the biome rolls once at the end. If each cycle
  could transition the biome independently, a tile could cascade sand → lava → glass
  in a single day, and every `medianDays` value is calibrated against exactly one roll
  per visit. Immediate change is still expressible: a flag-keyed rule with median 1.
- A tile's day is then legible as an ordered list — good for the event stream and for
  players understanding what changed them.

**Ordering yields emergence for free.** Quake-then-beam shatters glass to sand and then
melts that sand; beam-then-quake makes glass and shatters it back. Same two cycles,
same day, different result — with zero interaction code.

### Indirect interaction — via flags, not via cycles
Cycles never talk to each other. **Rules read the whole flag bitmask**, so combinations
are expressed in the ruleset:

| Flags on the tile | Outcome |
|---|---|
| `ERUPTION` | lava cools slowly → basalt → **fertile soil** → forest |
| `ERUPTION \| STORM` | lava quenched fast → **volcanic glass** |
| `QUAKE \| BEAM` | glass shattered to sand, then melted again |

This is real geology — slow cooling grows crystals, fast quenching makes glass — so the
same eruption yields *different materials* depending on what else happened that day.
Emergent chemistry from independent cycles and a flag check.

### Cycle schedules — not everything rotates  ★
Most cycles *should* rotate like the beam; a world where everything sweeps from one
direction reads as coherent and makes the sky legible. But the schedule is a per-cycle
property drawn from a family:

- **Rotational** — the beam, seasons. Predictable, visible, telegraphed.
- **Poisson / random** — scattered eruptions. Unpredictable by design.
- **Fixed-site** — a volcano that is always *there*, firing on its own rhythm.
- **Patterned but hidden** — a real, deterministic pattern players must discover.

### ★★ Knowledge of the pattern is currency
> "The wisdom of the pattern, even locally, is currency in itself."

Predictive knowledge of a world's cycles is a tradeable good — and it is the one
commodity that never inflates and never depletes. It joins "which worlds exist and how
to reach them" as an asset class that cannot be printed. It can be sold, hoarded,
leaked, or faked.

Why this is the strongest content type available here:
- **It is unauthored.** The pattern exists because the schedule is deterministic; the
  content is the inference problem, and it costs nothing to produce.
- **It is perfectly matched to the audience.** Bots collecting observations and doing
  statistical inference on eruption timings is exactly what a programmable-MMO player
  wants to do. This is the API pillar's payoff, not an exploit of it.
- **Partial knowledge has partial value.** You need not crack the global schedule to
  profit from knowing your own valley's rhythm. Value is a gradient, so there is always
  a next increment worth buying.
- It gives scholars, astronomers, and seers a real profession.

**A cracked pattern is a FEATURE, not a leak.** (Corrects an earlier framing here that
treated it as an economic risk to be plugged.) Solving a pattern does not consume the
content — it **triggers the next chapter**. The GM is standing right there to convert
the discovery into a new mechanic, a revelation, or a mission.

The strongest example: in discovering the pattern, a player uncovers a **death timer**,
and a greater mission to get offworld begins. A campaign world whose ending is
*announced* is a countdown; one whose ending is *discovered by a player reading the sky*
is a story. It also promotes inter-world travel from an unlock into the third act of a
world's life, giving campaign worlds a shape nobody has to author twice:

> **settle → discover → escape**

Per-world seeding still matters, but for freshness rather than defence: cracking one
world teaches nothing about the next, so every new world regenerates the whole arc.

#### ★ Implication: GM tooling needs TRIGGERS, not just spawn commands
For a GM — especially an **AI** GM — to respond to a discovery, they must know it
happened. GM tools therefore need **subscriptions and triggers**: notify me when a
player's observations cross a threshold, when someone reaches a location, when a
pattern is publicly solved, when a region's composition shifts.

A GM then becomes a program listening to an event stream and reacting — the same shape
as everything else in the design (NPCs are accounts, the API is the only door). Without
triggers, an AI GM can only act on a timer and world-running stays manual forever.

#### ★ Make pattern difficulty LOGISTICAL, not cryptographic
If a pattern is hard because it is mathematically obscure, one clever player runs a
regression over a weekend and it is finished — *alone*, which wastes the MMO entirely.

If it is hard because **observing it requires physical presence across a huge map over
months**, cracking it becomes an expedition: collaborators in different regions,
caravans stationed as instruments, someone paying for survey data. That difficulty
scales with systems that already exist — map size, travel time, fog of war — and it
produces cooperation rather than a solo puzzle. It also degrades gracefully: partial
coverage yields partial certainty, which is exactly the "even locally" value gradient.

**Layered secrets** follow naturally: a local rhythm crackable in weeks, a deeper
structure requiring a world-spanning effort that reveals the timer.

### Open Questions — Session 8
1. **Are rivers a biome or a tile overlay?** Earthquakes "carve rivers" — but a river
   is an edge/path feature, not an area. May need to be a separate layer.
2. **Are cycles GM-authorable**, or chosen from a fixed catalogue with tunable
   parameters and a per-world seed?
3. **How discoverable should hidden patterns be?** There is a tuning space between
   "trivially cracked in a day" and "indistinguishable from noise". Probably a family
   of difficulties, with the GM choosing.
4. **Can players record and sell observations** as an in-game item (a survey, an
   almanac), or is knowledge purely out-of-band between players?

---

## Session 9 — Metagame, Conflict & Inhabitants  ★ PILLAR

### ⚠️ Correction: knowledge cannot be physically gated
An earlier note proposed hauling observations as physical cargo so data could be
intercepted. **This does not survive contact with reality.** Players strategise
outside the game — Discord, wikis, spreadsheets. A cracked pattern is public within a
day and no in-game mechanic can prevent it.

### ★ Gate PREDICTION, not information
Knowledge of a pattern can be free. **Acting on it need not be.**

- Predicting requires **apparatus with real resource costs and upkeep** — observatories,
  orreries, calculating engines burning solar charge.
- Being handed a pattern gives you a *hypothesis*, not a *capability*.
- The gated thing is a physical asset inside the world, so the metagame cannot route
  around it.

**Verification is the other half.** Being told a pattern is not the same as trusting it
enough to move a city. Checking it against your own observations costs time and
presence. This creates a market not for secrets but for **trusted prediction** —
reputation becomes the scarce good, since anyone can publish a pattern and some will be
wrong or deliberately poisoned. Reputation cannot be leaked to a wiki.

### Conflict — required, but bounded
Conflict must exist beyond resource claims. The hard constraint:

> **No stronger players launching armies at lesser players.** Everyone should exist in
> this world and feel they are shaping it in their own way, even if small. A player who
> sets up a fishing hub and sells to passing merchants should get real value from the
> game on its own terms.

**The answer is logistics, not rules.** An army is a caravan: it eats, it moves at the
speed of its slowest member, and it cannot teleport spoils home. Marching on a fishing
village 200 tiles away costs more food than the village produces in a season. Griefing
is priced out by systems that already exist, without any PvP flag, safe zone, or rule
telling players what they may do.

**Consequence:** conflict concentrates where stakes justify the supply line — market
crossroads, bloom fields, rift sites, contested ground between established powers. High
value, short distances, peers against peers. Structurally absent from the quiet edges.

**What losing means.** Because power is flat, conflict threatens *position*, never
*existence*: a lost claim, a broken contract, a route denied, a town abandoned. Never
your roster. **You get displaced, not deleted.**

### ★★ Scripting is a CHARACTERISATION tool, not an optimisation tool
This reframes the automation pillar. Players are not programming units — they are
deciding **how people live**. The goal of scripting is to make the inhabitants of the
world feel real and immersive.

Implication for the API: it needs *life* verbs, not just operator verbs.

| Operator verb | Life verb |
|---|---|
| `move_to(hex)` | `settle here` |
| `transfer(item)` | `tend this` |
| `set_route(a, b)` | `trade with them` |
| `assign(station)` | `go home at dusk` |

This also locates the LLM/MCP layer properly. An LLM is mediocre at optimising
throughput and genuinely good at *"make this character behave like a person with this
history and these obligations."* Characterisation, not efficiency.

### The fishing village — canonical loop
> A player needs a place to restock food on the caravan route they established between
> two cities. So they take the time to build a caravan and start a fishing village. It
> may evolve on its own from there.

**The need creates the settlement.** No quest, no objective marker — the player's own
logistics generate the reason. The result is infrastructure other players can use, and
it may outgrow the reason it exists. Individual characters still need to go out, claim
land, and have a purpose; **players are the facilitators.** Characters are inhabitants;
players tell their story and instruct how they live their lives.

### Characters are fully obedient — DECIDED
Alone, a character does nothing. The player controls them entirely by assigning them to
jobs and caravans. **Personality is created by how they are played, their equipment, and
where they reside** — not by internal will or refusal.

**This makes the script the soul.** If characters had their own wills, a player's script
would compete with a personality the game already assigned. With full obedience there is
nothing to compete with — the script *is* the person. Two identical characters diverge
completely because two players played them differently, which is a stronger authorship
story than pre-baked traits. It also keeps the API deterministic (no command can be
refused), keeps bots reliable, and makes every outcome traceable to a player decision.

### Characters have identity and mechanics
Name, background, appearance. **Professions and classes.** Levels and stats.

### Conversation — characters speak as themselves
Characters can be addressed and can respond individually. Messages address the
`(character, caravan, player)` triple:

> **Argon** *(Eb's caravan — player paul)* asks **Billow** *(Cat caravan — player self)*:
> *"Do you have any extra fish?"*

The player may answer **as themselves or as the character** — their choice, purely for
roleplay.

**The payoff arrives with remote-AI caravans.** Players give their characters and
caravans distinct personalities. A GM can stand up a whole cast of NPCs from different
tribes across many caravans — rich worldbuilding at nearly zero authoring cost. This is
the content engine.

**★ Architectural requirement:** the conversation layer must live in the **API and the
event stream**, not the client UI. If it is a UI feature, remote-AI caravans — the
entire reason it is interesting — cannot participate. This is the strongest argument yet
for MCP as a first-class client: an LLM is mediocre at optimising throughput and
genuinely good at *"answer as Argon, a salt-flats fisher who distrusts city merchants."*

*Practical:* not every character should be LLM-driven (cost, latency). Most NPCs scripted
and cheap; a few genuinely conversational. The player or GM chooses which.

### ★★ Characters are an economy in themselves
Characters die and are born. **Creation by unnatural means is encouraged.** All of it
must be systematised.

> **Giving players infinite characters would break the game.** New players *starting*
> with characters is very strong in itself. As the world prospers, more characters come
> into existence. World cycles killing characters must be very real.

**Treat population with the same discipline as the terrain CA.** It has sources (birth,
unnatural creation), sinks (age, cycles, starvation, conflict), and feedback: prosperity
raises births; disaster cuts capacity; less capacity means less surplus means slower
recovery. It fails the same two ways — runaway growth until characters are worthless, or
a death spiral to extinction. It deserves the same treatment: **a headless population sim
over decades, checking it oscillates rather than converging.**

Consequences:
- **Population is the honest measure of a world's health** — it cannot be inflated, and
  it directly gates what anyone can attempt.
- **Extinction becomes a real outcome** — the mechanical form of a campaign world. A
  world whose population reaches zero has ended. A GM should choose whether theirs can.
- **Anti-hoarding is already handled**: characters eat. Stockpiling people carries a
  permanent food cost against a regional, finite supply. No cap needed.

---

## Session 10 — Locality, Visibility & Carrying Capacity  ★ DECISIONS

### Communication — two layers
| Layer | Scope |
|---|---|
| **Player ↔ player** | **global and immediate** |
| **Character ↔ character** | **localised to the shared tile** |

The metagame layer runs free; the diegetic layer costs distance. This concedes the
metagame (Discord exists) while keeping in-fiction interaction physical, and it makes
roleplay slightly less convenient on purpose.

### Trade requires the same tile
Goods change hands only between parties **on the same tile**. One rule enforces the
whole "markets are places, goods physically move, nothing teleports" pillar.

### Visibility — line of sight and fog of war
Knowledge of adjacent caravans and characters is determined by **line of sight and fog
of war**. Nobody gets whole-world information for free.

**Players may share locations on third-party sites — but the game only *verifies* what
you have seen.** This is the correct resolution to the metagame problem: you do not
prevent information sharing, you decline to certify it. Shared intel stays real but
unreliable, so scouting keeps its value without fighting Discord.

**★ Data-model consequence — sightings, not truth.**
Fog of war must return **remembered observations with timestamps**. The API should not
answer *"where is Eb's caravan"*; it answers *"you last saw Eb's caravan at (412, 88),
six days ago."* Everything downstream depends on this shape: clients render staleness,
bots reason about confidence, third-party intel becomes something you weigh rather than
know. Storing current state instead of timestamped records makes all of that
unbuildable later.

### Population — no hard cap, governed by resources
There is **no hard population cap**. Population is governed by the resources themselves.
**Famine is real, and so is agriculture.**

- A max-level farm with max-level workers might feed ~**50 characters**.
- There are only so many places a farm can exist.
- **The world constantly changes, so farm management is its own ongoing problem.**

**★ Carrying capacity MOVES.** Farms need specific terrain; terrain changes; so a
world's population ceiling drifts with its geography.

**★★ The beam's real damage is to farmland, not to people.** Deaths arrive weeks later,
from hunger, in settlements the beam never touched. Famine as the aftershock of a
disaster that already looked survivable — a far better disaster model than direct
casualties, and it emerges free from systems already designed.

**This gives caravans a reason to exist that is not profit.** Food grows where the land
allows; people live where the work is; the two keep moving apart. Hauling food between
them is the permanent, unglamorous, necessary job — exactly what a caravan is. The
fishing village is not a business, it is a link in a supply chain the player needs.

*Refinement:* at world scale, viable farm tiles will be numerous enough that theoretical
capacity vastly exceeds realistic population. The binding constraint should therefore be
**food where the people are** — distribution, not production. That keeps logistics
central rather than turning the game into a land grab for farm sites.

### Soil fertility — farmland depletes and recovers
Farmland is **not** infinite food. A farm requires **water, characters to work it, and
nutrient soil.** Farming one plot too long renders it unfarmable until the soil recovers.

**★ The disaster cycle IS the fertility cycle.** Lava cooling leaves fertile soil; ash
settles into it. The eruptions and burns that ruin a valley are what make it the best
farmland on the continent a generation later. A world with **no** disturbance would
slowly farm itself to exhaustion and starve — the same finding the terrain sim already
produced, arriving again in a different register. (Also true of the real world, which is
why people farm active volcanoes.)

**Data model:** soil fertility is a **per-tile scalar, separate from biome**. A grassland
farmed three years is not the same tile as a fresh one though it renders identically. It
depletes with use, recovers when fallow, and cycles inject fertility from outside.

Consequences:
- **Settlements get natural lifespans.** Villages expand, rotate, and eventually move.
  Abandoned settlements become *normal* texture, not evidence of failure — and caravans
  keep moving instead of settling into static routes.
- **Fertiliser is the industrial answer**, and it is exactly the theme: nature restores
  soil through catastrophe and time; humanity cannot wait for either, so it builds
  machines — composting, ash processing, bone meal, peat. Gives the factory layer
  permanent demand tied to survival, and gives ash and peat real value.
- **Tuning target:** the depletion-to-recovery ratio sets how much land a settlement
  needs. If N seasons of farming needs 2N fallow, a village needs 3× the land it works —
  which fixes settlement spacing and whether expansion is optional or compulsory. If
  recovery is too slow, soil depletion + famine + moving carrying capacity compounds into
  an inescapable doom spiral.

---

## Session 11 — Stations & Settlement  ★ SYSTEM

### One noun for every structure
**"Station"** represents *all* structures in the game — vehicle modules, city buildings,
outposts. One system, different slot types.

### Typed, tiered slots
Slots are typed by both **tier** (basic / advanced) and **container class**
(caravan / city / outpost). A station must match both.

| Container | Slots |
|---|---|
| **Basic caravan** | 4 basic caravan + 1 advanced caravan |
| **City** | 3 basic city + 2 advanced city |
| **Outpost** | 1 basic outpost |

Examples: an inn or market fits a *basic city* slot; a library requires an *advanced
city* slot. An outpost's single basic slot might hold a market or a farm.

### Tile density is limited by STATIONS, not by bodies
**Any number of characters and caravans may occupy a tile.** What limits density is
buildings. (This answers the Session 10 occupancy question.)

**★ The anti-Jita mechanism, completed.** Bounding a tile to one market bounds the number
of *venues*, not the *volume* — one market serving infinite traffic still centralises
world liquidity. But farms already require characters to work them, and if that
generalises: **station throughput is bounded by staff, staff must be fed, and food is
bounded by local carrying capacity.** The largest market in the world is therefore capped
by how many people can be fed on that tile — a terrain fact that changes over time.
Regional pricing survives with no special rule, *provided stations have staff-driven
throughput rather than binary existence.*

### ★★ Caravan ↔ Outpost — the game's most important verb
- **Any caravan can become an outpost**, gaining the outpost slot.
- Doing so renders the caravan **immobile**.
- **Mobilising again destroys the outpost slot**, returning a portion of construction
  materials.

This is how the world gets settled: every city on the map began with someone deciding to
stop moving. Infrastructure becomes a record of decisions rather than set dressing.

**The tradeoff underneath it: settling means you cannot run.** A caravan's entire
advantage is that it can leave. Trade that away for a build slot and the world's cycles
stop being something you avoid and become something you must *predict* — which is exactly
what makes pattern knowledge worth paying for. The station system, the cycle system, and
the knowledge economy are the same decision viewed from three angles.

### Structures, tiles, and spacing — DECIDED
- **One settlement per tile.** A tile may hold only one outpost / town / city. You cannot
  build where one already exists.
- **Stations are bound to the STRUCTURE, not to the tile.** The settlement owns the
  slots, not the hex.
- **Structure-specific spacing rules**, e.g.:
  - a **town** may not be built adjacent to another structure
  - a **city** may not be built within **5 tiles** of another structure

### ★★ Spacing rules ARE the conflict mechanic
A city excluding all structures within 5 tiles claims a hex disk of **~91 tiles**.
Placing one is not merely building — it **denies ninety hexes to everyone else**,
permanently, without a single soldier.

That is territorial competition with real stakes, resolved by arriving first and holding
on: exactly the bounded conflict required in Session 9. No armies, nobody deleted, and
the map is still genuinely contested. Combined with cities needing high carrying capacity
to feed their staff, **good city sites become the scarcest thing in the world.**
(This answers the "what does contesting a claim look like if not combat" question.)

**⚠️ Asymmetry to decide deliberately:** if a city cannot be built within 5 tiles of *any*
structure, then a 1-character outpost — the cheapest thing in the game — permanently
blocks the most expensive thing in the game across 91 hexes. Brilliant strategy or
griefing exploit depending on cost, and it will be discovered in week one. Options:
spacing applies only between same-or-higher tiers; upgrading absorbs nearby outposts you
own; or outposts do not count as blockers for larger settlements.

### Outposts require a manager
**An outpost requires at least one character managing it. When that ends, the outpost is
destroyed.** Therefore establishing an outpost *and leaving* requires a minimum of
**2 caravans and 2 characters** (one stays, one departs).

- **This solves abandonment with no decay timer** — the staffing requirement *is* the
  decay mechanism.
- **★ It makes population the real currency of expansion.** Every settlement permanently
  consumes a person who could be doing something else. How many places you can hold is
  bounded by population → bounded by food → bounded by terrain that keeps changing.
  Territory, people, agriculture and the cycles become one system: you cannot overextend
  territorially without an agricultural base, and the beam can remove that base.
- Founding a remote outpost is a genuine expedition, not a button.

### Character trading — ENCOURAGED
Trading characters between players is **encouraged**. The invariant: **a caravan or
structure always needs at least 1 character.**

Framing is professional, not chattel — a player whose business is training soldiers to
fight creatures in the mountains, or miners to work mines, is legitimate and encouraged.
This resolves the Session 9 slavery question: it is a **labour and apprenticeship
market**, not property.

**A training business is a factory that makes capability** — which fits "growth is
breadth, not power" exactly, and gives professions and levels an economic purpose beyond
flavour. Specialists become a manufactured good with a market price.

### Open Questions — Sessions 10–11
1. **★ What happens when a caravan or structure's LAST character dies?** (famine, the
   beam, a bad crossing) Something must happen to the vehicle, cargo, and stations.
   Proposal: it becomes a **derelict others can find and salvage** — the Legacy theme at
   the smallest scale, a reason to explore dangerous ground, and a way for materials to
   re-enter the economy instead of vanishing. The map then quietly accumulates the
   evidence of other people's failures, which is the right texture for a world of rising
   and falling civilisations.
2. **The mobilisation refund percentage is a real knob.** Too generous and settlements
   are disposable so nobody commits; too harsh and nobody un-settles, so the map
   calcifies with structures people cannot afford to remove — the very calcification the
   beam exists to prevent.
3. **Do settlement tiers upgrade** (outpost → town → city) as the progression axis? That
   keeps growth as breadth and forces spatial spread, consistent with flat power.
4. Does character price crash or spike during famine? Grim but real price signal.
5. What defines a valid farm site — biome, water access, soil fertility, all three?
6. Does line of sight vary by terrain (mountains see further, forest blocks)?

---

### Open Questions — Session 9
1. **★ Are characters traded, or contracted?** If characters are an economy, "buying and
   selling people" reads as slavery — which this setting *could* carry deliberately
   (necromancers, demons, unnatural creation) but should not back into by accident.
   Recruitment, contracts, and allegiance give identical economic mechanics — characters
   have a price, can be competed for, can be lost to a better offer. Same market,
   different noun, and the noun sets the tone of the entire game.
2. **Does communication have range?** Goods physically move and markets cannot teleport —
   should words? Player-to-player chat should probably be free (Discord exists; fighting
   the metagame is a known mistake). But *in-character* messages are diegetic, and making
   them local — or requiring couriers, relay towers, signal fires — would make distance
   matter socially as well as economically, and give message-carrying a real role.
3. What does contesting a claim actually look like mechanically, if not combat?
4. Can prediction apparatus be sabotaged? Conflict over *capability* rather than territory.
5. Is reputation a formal system or purely social?
6. How do levels and stats stay compatible with **flat power**? Levels must broaden what
   a character can *do* (professions, recipes, roles) rather than multiply how *strong*
   they are, or the no-exponential-progression pillar breaks.

---

## Session 12 — Salvage, Spacing & Combat  ★ SYSTEM

### Salvage is terrain-gated — biome consumption rate
Abandoned material becomes salvageable by other players **as long as the terrain has not
consumed it.** Every biome has a **consumption rate**:

| Biome | Consumption |
|---|---|
| Glass | never — preserved indefinitely |
| Forest / rainforest | slow decay |
| Lava | immediate |

This encourages **marauding players** to go out searching for abandoned settlements.

**★ The harsh biomes become the world's archive.** Where you die determines whether your
legacy survives — a caravan lost in the salt flats is findable a century later; the same
caravan lost in a rainforest is gone in a season. Real archaeology from one number per
biome.

**Convergence:** the wastes (glass, desert, badlands) were previously just *bad land*.
They are now simultaneously where salvage is **preserved**, where **nobody lives** (low
carrying capacity), where **marauders operate**, and where travel is **high-risk /
high-margin**. One geography doing four jobs. The beam also creates its own memorial: a
purge destroys settlements *and* glasses the ground, so the aftermath preserves exactly
what it killed.

### Spacing rules — RESOLVED
**The range restriction applies only to the thing being built**, checked against peers
and above — not against smaller structures.

- A **town** may be built within 3 of an existing city.
- A **city** may *not* be built within 3 of an existing town.
- Cities check against cities and towns, **not outposts**.

This makes blocking cost roughly proportional to what is being blocked, resolving the
Session 11 asymmetry. City and town ranges should probably both be **5** unless there is
a reason to differentiate. **Ranges must be dynamic (configurable).**

**★ Settlement spacing is therefore a GM dial for political density.** Tight ranges make
a crowded, contested world where every city site is fought over; wide ranges make a
frontier where people rarely meet. Same rules, different game, one number.

### Combat  ★
*(Note: these bandit NPCs are a completely different thing from the high-autonomy,
conversational, player/GM-run NPCs of Session 9. Separate systems.)*

**NPC conflict is the baseline.** Operating in a tile always presents some level of
conflict. A **bandit base** in one tile causes bandits to appear more frequently and more
strongly in adjacent tiles.

**Model:** simple simulated combat, in the spirit of *Dominions 6* but with far fewer
characters. **2v2 is the common case** between bandits and players.

**Equipment:** each character has an **armor slot, a tool slot, and an equipment slot**.
These may aid combat or may serve entirely non-combat purposes.

**Resolution:**
- Combat happens **immediately and in ticks**.
- **Before simulating, the player sees the result of that one tick.**
- Optionally watch a fast-forwardable / rewindable video of the battle.
- Defeating an opponent may take **several battles / ticks**.
- **Between ticks (6s) the player can act** — change gear, and crucially **other caravans
  and characters can come help.**
- Victory yields **loot or experience**.

**Rules of engagement (for now):** NPCs may attack players; players may attack NPCs.
Player-vs-player deferred.

**Structures fight too.** Structures have defensive/offensive mechanics — a castle with
walls and archers versus a caravan with artillery mounted on it. **The caravan itself
participates, provided a character is operating the station providing the assistance.**

#### ★★ Why multi-tick combat matters: rescue
If fights resolved instantly, nobody could ever come to anyone's aid and every fight
would be a private event. Stretching combat across ticks turns a fight into a **call for
help** — who is within five ticks, whose caravan is fast enough, who owes you a favour.
It ties combat to the map and to caravan speed, making your real defense your
**neighbours**.

#### Threat as a diffusing field
Bandit bases radiating into adjacent tiles is **the terrain CA again** — build it as one:
a diffusing field with sources (bases) and sinks (settlements, patrols). Same machinery.

- Danger gradients are **visible**, so risk is legible before you walk into it.
- Clearing a base lowers threat for **everyone** in the region — safety is a **public
  good**, with the free-rider problem that implies. Real regional politics with no rules
  attached.
- **Settlements suppress threat**, so civilisation is literally what makes land safe —
  and a depopulated region goes wild again. Rise and fall, mechanically.
- It fixes pacing: a uniform per-tile encounter rate would be exhausting, but as a field
  the settled interior sits near zero and the frontier is where you get jumped.

#### Defense costs population
A wall is worthless without someone on it, so defense costs **population → food →
terrain**. Militarisation becomes economically visible, and that is the quiet reason
army-dropping stays unattractive without a rule forbidding it: soldiers are people who
are not farming, and you must feed them the whole way there. Equipment slots do the same
at character scale — carrying mining tools means not carrying a weapon, so **every
fighter is an opportunity cost.**

#### ⚠️ Bandit loot must be RECYCLED, not CREATED
If bandits drop new materials, that is a **faucet in an economy built entirely on
scarcity** — and the worst kind, because it scales with player activity and never stops.

Bandits should hold **what they stole**: player goods taken from raided caravans,
re-entering circulation when someone takes them back. Bandits become a **redistribution
mechanism, not a mint.** Better fiction too, and it makes clearing a base exciting
because the loot is cargo somebody actually lost.

### Conflict design principle — fight over FLOWS, not STOCKS
Conflict over what is *moving* (cargo in transit, a claim being made, a route, a
contract) is repeatable, survivable, and generative. Conflict over what is *accumulated*
(your city, your roster, decades of investment) is existential — and with no power curve
to rebuild on, it feels terrible.

Licensed by this principle: caravan raiding (takes cargo, not existence), claim racing,
chokepoint control, market warfare, sabotage of prediction apparatus.
Ruled out: sieges, annihilation, army-dropping.

**Consent through exposure.** You opt into risk by where you go — the settled interior is
safe and thin-margin; the frontier is dangerous and rich. Nobody imposes conflict on the
fishing village; the fishing village chose a quiet tile, and that choice is why it is
quiet.

### ★★ Combat is LIGHT and AUTOMATED — DECIDED
> Combat is **not the core mechanic**. It must be light, and it must be automated. A
> player should be able to set up API callers to clear a bandit outpost **they can
> confidently clear**, and have it run with **no player intervention**.

**This resolves the deterministic-vs-distribution fork: outcomes must be deterministic or
tightly bounded.** "Confidently" requires predictability; real variance forces human
supervision, which contradicts the automation pillar outright.

**Combat is therefore a COST, not a gamble** — a logistics check. *Do I have enough
people, gear, and food to absorb this?* Yes → dispatch the bot. Exactly how every other
system in this game works.

**★ Enabling API primitive:** an assessment call —
`assess_engagement(force, target) → { outcome, expected_losses, ticks_to_resolve }`.
Without it a bot must *guess*, and "set it and forget it" quietly becomes "check on it
constantly." This one endpoint is the difference between the automation promise being
real and being aspirational.

**Uncertainty comes from the WORLD changing, not from combat rolls.** Your assessment was
correct on Tuesday; by Friday a new base spawned two tiles over and the threat field is
higher, so the fight your script signed up for is not the fight it is in. The surprise
comes from the map — the actual antagonist — while combat math stays honest. Rescue then
matters exactly when it should: not in routine clears, but when conditions moved.

**Consequences:**
- **Combat becomes a service.** "I clear bandits in your region for a fee," run entirely
  by a bot. Gives soldier-training enterprises a customer; adds a profession without
  adding a system.
- **Bandit camps are resource nodes that fight back** — predictable, farmable, requiring
  investment in people and gear, yielding recycled goods. Combined with recycled loot,
  clearing is a *salvage operation with a staffing cost*. Thematically right and
  economically safe. Nobody should design it as adventure content.
- **Resist complexity creep.** Three slots and a small stat set is enough. Every point of
  depth added to combat competes directly with the logistics and economy layers that are
  the actual game.

### Combat resolution model — SPEC
- **Deterministic from the player's side.** Combat has random elements, but they are
  resolved server-side up front; the preview is a **breakdown of what already happened.**
- **Hex grid, one character per hex.**
- **No tactical strategy.** You preconfigure team deployment. Everyone runs at the
  nearest enemy they can reach (unless stationed) and uses any action as soon as it is
  available (attack, use a thing, cast a spell).
- **AoE is friendly-fire-free**: damaging AoE only ever hits enemies; beneficial AoE only
  ever hits allies.
- **Combat runs on its own internal tick mechanic** — number of combat ticks per battle
  still to be calibrated.
- **One action per character per tick.** Moving, attacking, or any other action all
  consume the same single action.
- **Speed determines turn order** within a tick; higher speed acts first.

#### ★ Replays are RE-SIMULATIONS, not recordings
Reuse the terrain sim's primitive: `hash(battleId, combatTick, actorId, purpose)`, a pure
hash with no stored state. The server sends **initial conditions + battle id**; any client
recomputes the fight identically.

- Near-zero payload — no replay storage at all.
- Scrubbing, rewind, and fast-forward for free (re-run to tick N).
- **Third-party clients can render battles however they like** with no video format to
  define. Directly serves the open-client pillar.

#### Terminology — TURNS vs TICKS
- **Tick** = a world tick (6 real seconds).
- **Turn** = one round inside a combat. Combat turns are **entirely separate** from world
  ticks; the calibration question is *how many turns happen within one 6-second tick.*

**"Everything resolves at once"** was a statement about **presentation**, not resolution
order: you see the outcome of a turn rather than a blow-by-blow. **Sequential resolution
ordered by speed stands.**

#### Combat stats — SPEC
**Turns per combat is FLAT and CONSISTENT: 40.** Everything else tunes around it.

**Movement is cooldown-based, not distance-based.** Moving always moves exactly 1 tile;
what varies is how often. A fast character moves every 3 turns, a slow one every 5. Same
mental model as abilities — everything in combat is a cooldown.

**Character combat stats:**
| Stat | Meaning |
|---|---|
| **health** | at 0, the character dies |
| **speed** | determines turn order |
| **move** | how often they can move |
| **armor** | a layer on top of health; **resets each combat** |
| **damage** | how much a hit from their attack does |
| **accuracy** | chance to hit with an attack |
| **dodge** | chance to avoid being hit |

**Stats bound to the ACTION, not the character:** range, action speed (cooldown), and
similar. → **A character's combat role is entirely determined by their gear.** The same
person is a skirmisher with a bow and a brawler with a hammer, which lines up exactly with
the Session 9 decision that identity comes from equipment, placement, and how they are
played. Combat introduces no separate notion of what someone "is."

#### The 40-turn numbers resolve the melee-closing problem
At move cooldown 3 a character covers ~13 tiles per combat; at cooldown 5, ~8. Even a slow
melee character closes comfortably on any sane arena.

**Remaining tuning relationship:**
```
melee attacks  = (40 - closing_turns) / attack_cooldown
ranged attacks =  40 / attack_cooldown
```
With a 6-tile deployment gap a slow melee character arrives ~turn 26 and gets roughly a
third of a ranged character's attacks. Normal — melee compensates with damage — but it
means **deployment distance directly sets the melee damage multiplier.** Tune the two as a
pair, never independently.

#### The arena — SPEC
A horizontal grid, **10 long × 6 deep**, possibly with terrain variables:

```
  cols 1-4      cols 5-6      cols 7-10
 [ DEPLOY A ] [ NEUTRAL ]  [ DEPLOY B ]
  ^ back line = the caravan / structure
```

Each side pre-positions troops anywhere in its own **4×6 deploy zone**. The
**caravan or structure forms the back line.** The **2-column** middle zone is neutral —
nobody deploys there.

**Closing distances run 3 tiles** (both sides at their front edge) **to 9** (both at their
back). In 40 turns a character covers `floor(39/move) + 1` tiles:

| move cooldown | tiles per combat | can reach |
|---|---|---|
| 3 (fast) | 14 | anything |
| 5 (slow) | 8 | up to 8 — **not** a fully back-lined enemy at 9 |

**The 2-wide neutral zone is what makes slow melee viable.** At the closest deployment a
slow character crosses 3 tiles by turn 11, leaving **29 turns of attacking** — roughly
**10 attacks versus a ranged unit's 13**. Near parity. (The earlier 12-wide/4-neutral
layout gave melee about *one third* of ranged's attacks and required a large melee damage
multiplier to compensate; that compensation is now nearly unnecessary.)

→ **Deployment depth still matters**, but the penalty for getting it wrong is "you missed
the fight," not "melee is unplayable." Only the true worst case — both sides fully
back-lined at distance 9 — is unreachable for a slow character.

→ **Structures get a natural defensive advantage**: reaching the back line means crossing
the whole arena through everyone defending it. Structure-mounted weapons (castle archers,
caravan artillery) therefore need range in the **8–11 band** to contribute at all —
long-range by necessity, which is thematically right and gives those stations a clear
design target.

#### ⚠️ 72 hexes is large for the common 2v2
Two units per side in that much open space means positioning barely matters — they run at
each other across an empty field and the fight is a pure stat check. The arena is sized
for large battles (caravan vs. castle), which is correct, but most engagements will not
use it.

Probably acceptable given combat is meant to be light — but it means **arena terrain is
the only thing that can give small fights texture.**

#### ★ Generate arena terrain from the world tile's biome
The living map already knows every tile's biome. Use it:

| Biome | Arena effect |
|---|---|
| Forest / rainforest | scattered cover |
| Glass / desert | wide open, nowhere to hide |
| Mountain / rock | elevation, chokepoints |
| Marsh / swamp | slowed movement |

**Where** you fight becomes a real tactical input, at zero cost since the biome is already
known — and **the terrain sim changes your battlefields.** The valley you have defended
for a year becomes open ground after a purge glasses it.

Generate deterministically from `hash(tileIndex, biome, battleId)` so both sides see the
same field and replays reproduce, consistent with every other system.

#### Stalemates are FINE — DECIDED
Armor resets each combat, so a defender whose armor exceeds the damage an attacker can
push through in 40 turns takes **zero** health damage, indefinitely. **This is acceptable.**

> **Either party can always leave combat. There is no consequence to being attacked or
> attacking if you are not taking damage.**

The principle generalises: **no damage taken means nothing happened.** Two turtled forces
grinding at each other with zero effect are just wasting their own time, and either walks
away when it stops being worth it. It also means a well-armoured caravan is genuinely,
boringly safe from bandits that cannot hurt it — the right outcome, and it preserves the
legible *can I break their armor at all?* threshold a bot can evaluate before committing.

#### Fleeing and pursuit — DECIDED
**You can always flee a combat — but your caravan must move to a new tile, and the
attacker may pursue.** Because caravan movement is 1 tile per X ticks, **you remain stuck
in combat for several ticks while disengaging.** Fleeing is always available and never
free.

**★ This makes caravan speed the single most important stat in the game.** It already
governed travel time; it now governs escape cost too. One number expresses the core
tradeoff in both directions:

| Light & fast | Heavy & slow |
|---|---|
| mobile, escapes easily, low capacity | productive, valuable, hard to disengage |

Overloading a caravan was already a logistics decision; it is now a survival one, and both
point the same way.

**Pursuit is a hard threshold, not a gradient.** With both sides moving 1 tile per X ticks,
a *strictly faster* pursuer closes and re-engages; an equal-or-slower one never catches
you. No chase minigame, no rolls — `their_speed < your_speed`. A script can evaluate that
before taking a contract, consistent with "combat is a cost you assess, not a gamble."

**Emergent counter-structure, with nothing designed in:** fast light raiders can *catch*
heavy freight but may lack the punch to break its armor; escorts must be fast enough to
stay with the cargo they protect. Speed and armor trade against each other with no
rock-paper-scissors table anywhere.

### ★★ Tile activities — the vulnerability primitive
There are things to do in a tile that **require the caravan to remain stationary** while
they resolve — e.g. "research" this tile for **100 ticks**.

**This is the general form of a mechanic already in the design.** Pattern discovery
required observation to be *continuous and located*; "be here and don't move for N ticks"
is that, generalised. Surveying, mining, building, and observing cycles all run on one
primitive — and that primitive is **also what makes you vulnerable.**

**This is the missing reason bandits matter.** A caravan in transit can usually just leave.
A caravan 60 ticks into a 100-tick survey cannot — not without discarding an hour of real
time. So threat is only genuinely dangerous **where you have to stop**, which makes
clearing a region's bandits a real prerequisite to working it, and makes escorting a
service worth buying.

**⚠️ Open — does fleeing forfeit activity progress?** Keep it and interruption is a
nuisance; lose it and interruption is a disaster, so guards are obviously worth the food.
Partial loss is probably the sweet spot. **This one number sets the entire price of
protection.**

#### ⚠️ Action selection needs a deterministic rule
"Uses any action as soon as it is available" is underspecified when several are off
cooldown, and an arbitrary choice breaks replay reproduction. **Ordered priority list per
character, first available action fires** — simple, deterministic, fully automatable, and
it belongs in the **deployment template** alongside placement. That is also where much of
the real player expression lives without adding tactical complexity.

#### ~~Positions reset between ticks → melee can be structurally dead~~ — RESOLVED by 40 turns
*(Kept for the reasoning.)* At a low turn count, characters could still be closing when
the tick ended, so melee would take fire every tick, reset before contact, and never land
an attack — ranged winning every engagement by default. **Fixing turns at 40 removes
this**: even a slow character (move cooldown 5) covers ~8 tiles per combat.

Still worth a regression test: melee-vs-ranged at the chosen deployment distance,
asserting melee lands attacks in a large majority of engagements.

#### Damage persists across ticks; positions reset
The basic caravan's station list already includes *"a med station to heal wounded
characters"* — wounded implies wounds that last. So: **deaths and damage carry between
world ticks; positions reset to deployment each tick.** This is what makes "several ticks
to defeat an opponent" mean anything; otherwise each tick is an independent skirmish and
fights never converge. It also gives the med station a real job and makes
retreat-to-heal a genuine decision.

#### ~~Turn count does TWO jobs that pull opposite ways~~ — SETTLED by fixing turns at 40
*(Kept for the reasoning.)* Turn count governs both melee viability (more turns → melee
closes) and the reinforcement window (fewer turns → more 6s windows for help to arrive),
which pull opposite ways.

**Fixing it at 40 settles this by fiat** — melee viability is satisfied, and the rescue
window is now tuned by the *other* levers instead: how many ticks a fight takes to resolve
(damage vs. health/armour totals) and how fast neighbours travel. That is the better place
for it anyway, since both are already economy-facing numbers.

#### ⚠️ Targeting needs a deterministic tiebreak
On a hex grid, equidistant enemies are the common case. Without a stable rule, replays
will not reproduce. Suggested: **(nearest → lowest current HP → lowest entity id)**. The
HP term also makes units sensibly finish wounded targets without adding strategy.

#### "Movement costs your whole action" → deployment IS the gameplay
Ranged units get free hits while melee closes, so composition and initial placement decide
most fights. All skill expression moves into **preconfigured deployment** — which argues
for making **deployment templates a first-class, saveable, API-settable object**, not a UI
setting. Players will build, share, and iterate on them. That is the combat metagame.

#### Turns-per-tick is the RESCUE DIAL — but not only that
Fewer turns per tick → more 6-second world ticks to resolve a fight → more windows for a
neighbour to arrive. More turns → fights end before help can come. So it is calibrated
against how much reinforcement should matter, **not** against how long a battle "should"
feel — but see the two-jobs conflict below, because it also governs whether melee can
close at all.

#### Correction: assessment returns odds, not certainty
Because randomness is resolved server-side, `assess_engagement` returns **probability and
expected losses**, not a guarantee. "Confidently clear" means high probability with
acceptable expected casualties — better anyway, since it gives bot authors a real risk
threshold to configure rather than a binary.

### Open Questions — Session 12
1. How many combat ticks per battle? (See rescue dial above.)
2. What stops raiding from being griefing? Probably that you can only take what you can
   carry home — theft priced by logistics, like everything else.
3. How does experience→levels stay **breadth not power** (Session 9 Q6)?

---

## Technical Flags

- **Hex-on-a-sphere is not possible with hexes alone.** A closed hex globe requires
  exactly 12 pentagons (Goldberg polyhedron). Alternatives: cylindrical wrap
  (east-west only, special poles) or toroidal wrap (wraps both axes, seamless, no
  poles, but not visually a globe). Cheap to decide now, expensive later.
- **A chaotic terrain CA cannot be fast-forwarded with closed-form offline math.**
  This implies an authoritative server that simulates continuously — not a
  client-side idle game with an accrual formula. Biggest architecture fork so far.
