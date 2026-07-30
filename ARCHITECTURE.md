# Sunborn Legacy — Architecture

**Status:** v1 design, merged from five reviewed subsystem designs (persistence, API, simulation,
realtime, economy) plus their adversarial critiques.
**Fiction, cosmology, pillars, and design rationale live in [BRAINSTORM.md](./BRAINSTORM.md) and
[PITCH.md](./PITCH.md). Terrain findings live in [SIMULATION.md](./SIMULATION.md). This document is
technical only and does not restate them.**

Everything below is a decision unless it appears under §12 Open Questions. Where two subsystem
designs disagreed, §10 records which one won and what was given up. Where a critique found a defect
that is not fixed here, §11 records it as an accepted risk with rationale.

---

## 1. System overview

Five deployable units. All TypeScript, Node 24 native TS execution, PostgreSQL 16+.

```
                          ┌──────────────────────────────────────────┐
   third-party clients    │  auth.sunbornlegacy.com   (sl-auth)      │
   official web client ──▶│  OAuth 2.1 AS · JWKS · consent · step-up │
   bots / MCP agents      └──────────────────────────────────────────┘
          │                                  │ EdDSA JWT (aud-scoped, 10 min)
          ▼                                  ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │ api.sunbornlegacy.com          (sl-api, stateless, N replicas)   │
   │  REST · SSE · WebSocket · long-poll                              │
   │  DB roles: api_reader (RLS reads) / api_writer (EXECUTE only)    │
   └──────────────────────────────────────────────────────────────────┘
          │  reads: RLS-guarded observations       │ writes: SECURITY DEFINER fns
          ▼                                        ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │ PostgreSQL   core tier  ‖  terrain tier   (hard seam, no joins)  │
   └──────────────────────────────────────────────────────────────────┘
          ▲                                        ▲
          │ sim_writer                             │ sim_writer
   ┌──────────────────────────────────────────────────────────────────┐
   │ sl-worldsim  — ONE leased writer per world                       │
   │  coarse CA sweep · tile CA sweep · materialize · event queue     │
   │  market call auctions · world_log append · monetary controller   │
   └──────────────────────────────────────────────────────────────────┘
          │ Redis Stream  world_log:{world_id}
          ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │ sl-fanout — stateless WS/SSE fanout, reconciles gaps from PG     │
   └──────────────────────────────────────────────────────────────────┘

   mcp.sunbornlegacy.com (sl-mcp) — a *generated OAuth client*. No DB access,
   no service account. Every tool is an outbound HTTPS call to /v1/* with the
   user's own token.

   assets.sunbornlegacy.com — CDN, no auth, CC BY 4.0 art, immutable hashes.
```

**Load-bearing invariants**, each enforced by a CI gate (§9.6):

1. `api_reader` and `api_writer` have **no `SELECT`** on `region_terrain`, `region_coarse`,
   `region_static`, `deposit`, `market_book`. Fog of war is a Postgres grant, not a code convention.
2. Every world-scoped table's primary key is `(world_id, id)`. No exceptions.
3. Every row in `world_log` carries a non-null visibility tag, and exactly one function
   (`filterObservable`) turns rows into recipients — for WS, SSE, long-poll, REST replay, and MCP.
4. Tile coordinates are **never an input** to a live-terrain read, only an output.
5. `goods_ledger` has no `gm` cause value, and no GM scope grants inventory or mint.
6. The same request, made by the official client's `client_id` and by any other registered
   `client_id`, returns byte-identical responses.

---

## 2. Geometry, clocks, and the lattice hierarchy

### 2.1 One lattice, four granularities

The five designs proposed four different spatial units (16×16 regions, 64×64 regions, 32×32 chunks,
8×8 vision cells). They are unified into a single nesting so that storage, transfer, simulation LOD,
and visibility are the same objects:

| Unit | Size | Count (reference world) | Purpose |
|---|---|---|---|
| **tile** | 1 hex | 52,428,800 | fine simulation, entity position |
| **coarse cell** | 8 × 8 tiles | 819,200 | always-on low-LOD CA; vision granularity |
| **region** | 32 × 32 tiles = 4 × 4 cells | 51,200 | storage row, wire chunk, materialization unit, sweep band width |
| **province** | contiguous region set (fbm) | 40–80 | mineral suites (§8.2) |

Reference world: **10,240 × 5,120 tiles → 320 × 160 regions → 1,280 × 640 coarse cells.**

Constraints, enforced by `CHECK` **and** by a startup assertion per world:

```sql
CHECK (width  % 32 = 0)
CHECK (height % 64 = 0)   -- height/32 must itself be even (region-row parity at the seam)
CHECK (width  % 32 = 0)   -- band width must divide width exactly; see §4.1
```

> **Lattice topology is not uniform, and this matters.** The *tile* lattice and the *coarse cell*
> lattice are odd-r hex tori with 6 neighbours (the coarse lattice at 8× is a genuine approximation
> of tile adjacency; at region scale it would not be). The **region lattice is rectangular** — 4
> edge-adjacent neighbours, wrapping both axes. `ODD_R_NEIGHBOURS` must never be applied to a
> `region_idx`. This corrects a false premise in the persistence design that would have produced a
> silent shear in any region-to-region coupling.

Index arithmetic (no spatial index; the grid is its own index):

```ts
type TileIdx   = number & { readonly __tile: unique symbol };    // row * W + col
type CellIdx   = number & { readonly __cell: unique symbol };    // cellRow * (W/8) + cellCol
type RegionIdx = number & { readonly __region: unique symbol };  // rRow * (W/32) + rCol
type Tick      = number & { readonly __tick: unique symbol };
type Step      = number & { readonly __step: unique symbol };    // sweep step

const regionOf = (t: TileIdx, W: number) => ((t / W | 0) >> 5) * (W >> 5) + ((t % W) >> 5);
const cellOf   = (t: TileIdx, W: number) => ((t / W | 0) >> 3) * (W >> 3) + ((t % W) >> 3);
```

Proximity queries enumerate the hex disc's `tile_idx` values in TypeScript (two modulos for torus
wrap) and issue `WHERE tile_idx = ANY($1::bigint[])`. No PostGIS, no adjacency table.

### 2.2 Time: one authoritative clock, derived, never stored

```
tick  = f(now)      where f is piecewise, defined by an append-only skip log
step  = tick / 45   (45 ticks per sweep step)
day   = tick / 14400
```

```sql
CREATE TABLE world_time_skip (            -- append-only. The ONLY way world time bends.
  world_id      SMALLINT NOT NULL,
  id            BIGINT   NOT NULL,
  at_step       BIGINT   NOT NULL,        -- skip takes effect at this step
  skipped_steps BIGINT   NOT NULL CHECK (skipped_steps > 0),
  reason        TEXT     NOT NULL,        -- 'outage' | 'gm_pause'
  declared_at   TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (world_id, id)
);
```

```ts
// The single clock authority. Monotone by construction: skips only ever move the
// step number FORWARD relative to wall clock, never backward.
export function stepAt(w: WorldRow, skips: SkipRow[], nowMs: number): Step {
  const raw = Math.floor((nowMs - w.epoch_started_ms) / w.ms_per_step);
  let out = raw;
  for (const s of skips) if (raw >= s.at_step) out += s.skipped_steps;
  return out as Step;
}
```

**Rejected:** `world.tick_offset` (persistence) and mutating `epoch_start` (simulation). Both make
`now_tick` non-monotonic. A rewind un-fires `sated_until_step` deadlines, re-fires processed
`world_event` rows, refunds spent budgets, indexes movement paths backwards, and writes into sealed
`goods_ledger` partitions. `epoch_started_at`, `ms_per_step`, and `ticks_per_day` become **immutable
once `status='live'`** (enforced by a `BEFORE UPDATE` trigger, not by convention).

**Rejected:** `sweep_cursor.step_no` as simulation authority (simulation design). A stored counter
that lags wall clock forces a choice between "catch up with wrong day values, breaking replay" and
"skip, making `last_swept_step` lie." Instead the sweep is a **per-region catch-up loop** driven by
each region's own `last_swept_step`, idempotent on `(world_id, region_idx, step)`. `sweep_cursor`
survives only as an observability watermark with no authority, and its lag is public
(`GET /v1/worlds/{w}/clock → sweep_lag_steps`).

### 2.3 The three clocks

| System | Clock | Mechanism |
|---|---|---|
| movement, production, growth, consumption, budgets | **none** | timestamps + lazy resolve on read; CAS-versioned writes |
| terrain | **solar sweep** | 320 steps/day, one region column per step, 270 s wall per step |
| market clearing, combat, beam impact, contracts, arrivals | **event queue** | `world_event`, `FOR UPDATE SKIP LOCKED`, drained by the world's single writer |

Lazy resolution handles **values**. The event queue handles **transitions** — every piecewise
breakpoint with an externally visible consequence (arrival, food exhaustion, craft completion,
listing expiry, market clear, beam impact) gets exactly one queue row, superseded by bumping a
`generation` counter on the subject.

---

## 3. Data model

All world-scoped tables use `PRIMARY KEY (world_id, id)` with `id` a UUIDv7, globally unique by
construction so the public API can keep exposing a single opaque id. Every foreign key is composite.

> This is the persistence critique's blocking issue #1: `id UUID PRIMARY KEY` on a table declared
> `PARTITION BY HASH (world_id)` is a syntax error, and a single-column `UNIQUE (id)` is illegal on
> a partitioned table — so there is no incremental migration path later. The DDL below is intended
> to be **executable**, and CI runs it against a scratch Postgres on every commit.

### 3.1 World directory (global, unpartitioned)

```sql
CREATE TABLE world (
  id                SMALLINT PRIMARY KEY,
  slug              TEXT UNIQUE NOT NULL,
  display_seed      TEXT     NOT NULL,          -- HMAC(master, id). NOT the sim seed.
  width             INT      NOT NULL CHECK (width  % 32 = 0),
  height            INT      NOT NULL CHECK (height % 64 = 0),
  epoch_started_at  TIMESTAMPTZ NOT NULL,       -- IMMUTABLE once status='live'
  ms_per_step       INT      NOT NULL DEFAULT 270000,
  ticks_per_day     INT      NOT NULL DEFAULT 14400,
  ruleset_version   INT      NOT NULL,
  ruleset_epoch     INT      NOT NULL DEFAULT 0,  -- bumped on ruleset migration; re-keys rolls
  beam_mode         TEXT     NOT NULL CHECK (beam_mode IN ('off','rotating','terminal')),
  beam_transit_days REAL,                       -- SEVERITY: how fast it crosses
  beam_cycle_days   REAL,                       -- RECOVERY: gap between purges
  beam_width_cols   INT,
  beam_started_step BIGINT,
  status            TEXT     NOT NULL,          -- forming|live|stalled|ashen|archived
  tier              TEXT     NOT NULL,
  CONSTRAINT beam_saturates CHECK (
    beam_mode = 'off' OR beam_width_cols >= ceil(width::numeric / beam_transit_days)
  )
);

-- Secrets live in a separate schema owned by a role neither API role can read.
CREATE SCHEMA secret;
CREATE TABLE secret.world_secret (
  world_id    SMALLINT PRIMARY KEY REFERENCES world(id),
  sim_seed    BYTEA NOT NULL,     -- 128-bit. Derived HMAC(master_key, world_id); never displayed.
  terrain_dsn TEXT  NOT NULL      -- seam: where this world's terrain lives
);
REVOKE ALL ON SCHEMA secret FROM api_reader, api_writer, gm_writer;
```

> **Why the seed is a secret.** Both the API design (`seed_public`) and the persistence design
> (`world.seed` in the row every public endpoint reads) published it. The prototype's world is a
> pure function of `(seed, width, height, seaLevel)` and `hash32` is a 32-bit FNV mix, so a
> published 32-bit seed reproduces the day-0 map offline — and worldgen fixes where Rock (iron,
> stone, copper) and Ocean are. Measured terrain churn is ~1%/day, so a day-0 map stays >90%
> accurate for months. There is no revocation path for a leaked seed. Hence: 128-bit seed, keyed
> HMAC rolls (§4.4), separate schema, separate role, and a CI test asserting no serialized response
> contains it.

### 3.2 Terrain tier

No foreign key and no join ever crosses into the core tier. v1 deploys both in one Postgres; the
`terrain_dsn` indirection exists from day one so sharding a hot world is config, not code.

```sql
-- ALWAYS-ON coarse tier. One row per region, for EVERY region, materialized or not.
-- 16 cells × 8 B = 128 B, stays inline. 51,200 rows = 6.5 MB per world.
CREATE TABLE region_coarse (
  world_id        SMALLINT NOT NULL,
  region_idx      INT      NOT NULL,
  region_col      SMALLINT NOT NULL,          -- sweep predicate
  cells           BYTEA    NOT NULL,          -- 16 × { biome u8, _pad u8, moisture u16 (×100),
                                              --        entered_step u32 }
  last_swept_step BIGINT   NOT NULL,
  lod             TEXT     NOT NULL DEFAULT 'coarse' CHECK (lod IN ('coarse','tiles')),
  PRIMARY KEY (world_id, region_idx)
) PARTITION BY HASH (world_id);
ALTER TABLE region_coarse ALTER COLUMN cells SET STORAGE PLAIN;
CREATE INDEX ON region_coarse (world_id, region_col);

-- IMMUTABLE static worldgen fields, written once at first materialization, never rewritten.
-- Split from the hot blob so the sweep never touches it (WAL/TOAST amplification).
CREATE TABLE region_static (
  world_id   SMALLINT NOT NULL,
  region_idx INT      NOT NULL,
  fields     BYTEA    NOT NULL,   -- 1024 × { elev u16, damp u16, rough u16, tectonic u16 } = 8 KB
  PRIMARY KEY (world_id, region_idx)
) PARTITION BY HASH (world_id);

-- FINE tier. Present only where lod='tiles'. 1024 × 8 B = 8 KB.
CREATE TABLE region_terrain (
  world_id          SMALLINT NOT NULL,
  region_idx        INT      NOT NULL,
  region_col        SMALLINT NOT NULL,
  generation        INT      NOT NULL DEFAULT 1,   -- NEVER exposed publicly (side channel)
  materialized_step BIGINT   NOT NULL,
  last_swept_step   BIGINT   NOT NULL,
  content_hash      BYTEA    NOT NULL,             -- sweep skips the write when unchanged
  tiles             BYTEA    NOT NULL,   -- 1024 × { biome u8, flags u8, moisture u16,
                                         --          entered_step u32 } = 8 KB
  PRIMARY KEY (world_id, region_idx)
) PARTITION BY HASH (world_id);

-- Player-built ground features. Sparse. Pins the region against dematerialization.
CREATE TABLE tile_feature (
  world_id   SMALLINT NOT NULL,
  tile_idx   BIGINT   NOT NULL,
  kind       TEXT     NOT NULL,   -- road|waystone|ruin|rift|wreck|station|market|settlement
  region_idx INT      NOT NULL,
  owner_account_id UUID,
  built_step BIGINT   NOT NULL,
  data       JSONB    NOT NULL DEFAULT '{}',
  PRIMARY KEY (world_id, tile_idx, kind)
) PARTITION BY HASH (world_id);
CREATE INDEX ON tile_feature (world_id, region_idx);

-- Explicit pin accounting, so `max_pinned_regions` is enforceable and pins are revocable
-- when the beam destroys the structure that created them.
CREATE TABLE region_pin (
  world_id   SMALLINT NOT NULL,
  region_idx INT      NOT NULL,
  account_id UUID     NOT NULL,
  reason     TEXT     NOT NULL,   -- settlement|road|deposit|claim|market
  ref_id     UUID     NOT NULL,
  created_step BIGINT NOT NULL,
  PRIMARY KEY (world_id, region_idx, account_id, reason, ref_id)
);
```

### 3.3 Observation tier — fog of war storage

Snapshots are **deduplicated**: one immutable snapshot per region per change, shared by every
account that saw it; each account holds a 24-byte pointer plus its own seen-mask.

> This kills the simulation design's per-account 48 KB copy (measured at 7.2 GB/world for 500
> accounts × 300 regions — 11× the world itself) and the API design's per-observer tile rows
> (O(players × tiles), hot-updated on the most-polled endpoint in the game).

```sql
CREATE TABLE region_snapshot (           -- shared, immutable, refcounted
  world_id    SMALLINT NOT NULL,
  id          UUID     NOT NULL,
  region_idx  INT      NOT NULL,
  at_step     BIGINT   NOT NULL,
  detail      TEXT     NOT NULL CHECK (detail IN ('coarse','tiles')),
  blob        BYTEA    NOT NULL,        -- wire format: 1024 × 4 B fixed stride (§6.3)
  refcount    INT      NOT NULL DEFAULT 0,
  PRIMARY KEY (world_id, id)
) PARTITION BY HASH (world_id);
CREATE INDEX ON region_snapshot (world_id, region_idx, at_step DESC);

CREATE TABLE account_region_memory (
  account_id    UUID     NOT NULL,
  world_id      SMALLINT NOT NULL,
  region_idx    INT      NOT NULL,
  snapshot_id   UUID     NOT NULL,
  seen_mask     BYTEA    NOT NULL,      -- 128 B = 1024 bits. Authority on what is valid.
  last_seen_step BIGINT  NOT NULL,
  PRIMARY KEY (account_id, world_id, region_idx)
) PARTITION BY HASH (account_id);
ALTER TABLE account_region_memory SET (fillfactor = 70);   -- keep updates HOT

-- Historical visibility, for correct reconnect replay. 30-minute retention by partition drop.
CREATE TABLE observation_interval (
  account_id UUID     NOT NULL,
  world_id   SMALLINT NOT NULL,
  cell_idx   INT      NOT NULL,
  from_step  BIGINT   NOT NULL,
  to_step    BIGINT,                    -- NULL = currently observing
  PRIMARY KEY (account_id, world_id, cell_idx, from_step)
) PARTITION BY RANGE (from_step);
CREATE INDEX ON observation_interval (world_id, cell_idx) WHERE to_step IS NULL;
```

**Masking is unrepresentable, not filtered.** The stored blob and the wire response are the same
bytes, and every byte outside `seen_mask` is `0xFF` (unknown) in both. There is one constructor:

```ts
declare const MASKED: unique symbol;
export type MaskedRegionBlob = Uint8Array & { readonly [MASKED]: true };

/** The ONLY way to produce a MaskedRegionBlob. Zero-fills every tile outside the mask. */
export function applyMask(raw: Uint8Array, mask: Uint8Array): MaskedRegionBlob;

// Property test (required): for any (raw, mask), every 4-byte tile record outside the mask
// is 0xFFFFFFFF in the stored row AND in the serialized response.
```

`account_region_memory` is written **only on movement events** (region entry / tile advance emitted
by the movement worker), never inside a `GET`. A read that finds stale memory serves stale memory —
which is correct fiction as well as correct engineering.

### 3.4 Core tier — entities

```sql
CREATE TABLE account (
  id           UUID PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('human','program')),
  display_name TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL
);

-- Account-to-account control: a remote server program running 40 NPCs, GM succession,
-- abandoned-caravan adoption. Absent from every subsystem design; expensive to add later.
CREATE TABLE account_control (
  controller_account_id UUID NOT NULL REFERENCES account(id),
  subject_account_id    UUID NOT NULL REFERENCES account(id),
  scopes     TEXT[] NOT NULL,
  granted_by UUID   NOT NULL,
  granted_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  PRIMARY KEY (controller_account_id, subject_account_id)
);

CREATE TABLE character (
  world_id   SMALLINT NOT NULL,
  id         UUID     NOT NULL,
  account_id UUID     NOT NULL,
  kind       TEXT     NOT NULL,      -- human|beast|sunborn
  species_key TEXT    NOT NULL,      -- 'crabbeast' — mounts are characters, not a creature type
  name       TEXT,
  speed_ticks_per_tile INT NOT NULL, -- FLAT. There is no multiplier column anywhere.
  sated_until_step BIGINT NOT NULL,  -- food is a deadline, not a meter
  health     REAL NOT NULL, health_step BIGINT NOT NULL,
  sunborn_aspect TEXT,
  rev        BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (world_id, id)
) PARTITION BY HASH (world_id);

CREATE TABLE caravan (
  world_id   SMALLINT NOT NULL,
  id         UUID     NOT NULL,
  account_id UUID     NOT NULL,
  origin_tile BIGINT  NOT NULL,
  current_region INT  NOT NULL,      -- cache, refreshed at boundary events
  vision_radius SMALLINT NOT NULL DEFAULT 3,
  controller TEXT NOT NULL DEFAULT 'player',  -- player|npc|adopted
  generation INT  NOT NULL DEFAULT 0,          -- bumped on replan; stale events drop
  rev        BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (world_id, id)
) PARTITION BY HASH (world_id);
CREATE INDEX ON caravan (world_id, current_region);

-- Movement is a SEGMENTED immutable plan. One leg per region crossing.
-- Committed legs are never rewritten; the world may interrupt the FUTURE, never the past.
CREATE TABLE caravan_leg (
  world_id   SMALLINT NOT NULL,
  caravan_id UUID     NOT NULL,
  seq        INT      NOT NULL,
  tiles      BIGINT[] NOT NULL,
  ticks_per_tile INT  NOT NULL,      -- SNAPSHOT at leg commit ("slowest member" resolved once)
  start_step BIGINT   NOT NULL,
  state      TEXT     NOT NULL,      -- committed|provisional|stalled
  PRIMARY KEY (world_id, caravan_id, seq)
) PARTITION BY HASH (world_id);
```

Position resolves as a pure function of committed legs: binary-search cumulative ticks, index the
tile array. At each region-boundary event the worker **re-validates the next leg** against current
terrain (a route plotted five days ago may cross tiles the beam has since turned to Ash, or "coast
drowns" has turned to Shallows) and against `MIN(sated_until_step)` across the roster, truncating to
`stalled` if either fails. A `caravan_starve` event is scheduled at `MIN(sated_until_step)`.

```sql
CREATE TYPE slot_kind AS ENUM ('mount','wheel','character','station','cargo');
CREATE TYPE slot_size AS ENUM ('small','medium','large');

CREATE TABLE vehicle (
  world_id SMALLINT NOT NULL, id UUID NOT NULL,
  caravan_id UUID NOT NULL, chassis_key TEXT NOT NULL, position SMALLINT NOT NULL,
  container_id UUID NOT NULL,
  condition REAL NOT NULL DEFAULT 1.0 CHECK (condition BETWEEN 0 AND 1),
  PRIMARY KEY (world_id, id),
  FOREIGN KEY (world_id, caravan_id) REFERENCES caravan(world_id, id)
) PARTITION BY HASH (world_id);

CREATE TABLE vehicle_slot (
  world_id SMALLINT NOT NULL, vehicle_id UUID NOT NULL, slot_no SMALLINT NOT NULL,
  kind slot_kind NOT NULL, size slot_size NOT NULL,
  character_id UUID, equipment_id UUID,
  PRIMARY KEY (world_id, vehicle_id, slot_no),
  CHECK (num_nonnulls(character_id, equipment_id) <= 1),
  CHECK (kind IN ('mount','character') OR character_id IS NULL),
  CHECK (kind IN ('wheel','station')   OR equipment_id IS NULL)
) PARTITION BY HASH (world_id);
-- The real enforcement that nothing occupies two slots:
CREATE UNIQUE INDEX ON vehicle_slot (world_id, character_id) WHERE character_id IS NOT NULL;
CREATE UNIQUE INDEX ON vehicle_slot (world_id, equipment_id) WHERE equipment_id IS NOT NULL;

CREATE TABLE equipment (
  world_id SMALLINT NOT NULL, id UUID NOT NULL, item_def TEXT NOT NULL,
  quality    REAL NOT NULL CHECK (quality    BETWEEN 0 AND 1),
  durability REAL NOT NULL CHECK (durability BETWEEN 0 AND 1),
  container_id UUID, inner_container_id UUID,
  PRIMARY KEY (world_id, id)
) PARTITION BY HASH (world_id);
```

> **`quality` and `condition` are bounded [0,1] and affect durability and failure rate only —
> never throughput or yield.** They were the only unbounded scalars in the persistence design, and
> they sit on exactly the objects that gate production. A recipe whose output quality is a function
> of input quality compounds; within a month a veteran's station outproduces a newcomer's by orders
> of magnitude, and "iron matters in year three the way it mattered in week one" stops being true.
> Invariant test: no recipe's output quality may exceed the max of its input qualities, and no
> recipe's `hours` or `output_qty` may reference quality at all.

### 3.5 Core tier — containers, goods, ledgers

```sql
CREATE TYPE anchor_kind AS ENUM
  ('vehicle','settlement','equipment','market_escrow','character','wreck');

CREATE TABLE container (
  world_id SMALLINT NOT NULL, id UUID NOT NULL,
  anchor anchor_kind NOT NULL, anchor_id UUID NOT NULL,
  cap_mass INT NOT NULL, cap_volume INT NOT NULL,
  used_mass INT NOT NULL DEFAULT 0, used_volume INT NOT NULL DEFAULT 0,
  tile_cache BIGINT, tile_cache_step BIGINT,   -- CACHE ONLY. Authority is the anchor chain.
  PRIMARY KEY (world_id, id),
  UNIQUE (world_id, anchor, anchor_id),
  CHECK (used_mass <= cap_mass AND used_volume <= cap_volume)
) PARTITION BY HASH (world_id);

CREATE TABLE item_stack (
  world_id SMALLINT NOT NULL, container_id UUID NOT NULL,
  item_def TEXT NOT NULL, qty NUMERIC(14,3) NOT NULL CHECK (qty > 0),
  PRIMARY KEY (world_id, container_id, item_def)
) PARTITION BY HASH (world_id);

CREATE TABLE goods_ledger (
  world_id SMALLINT NOT NULL,
  id       BIGINT   NOT NULL,
  at_step  BIGINT   NOT NULL,
  item_def TEXT     NOT NULL,
  qty      NUMERIC(14,3) NOT NULL CHECK (qty > 0),
  src_container UUID, dst_container UUID,
  cause    TEXT NOT NULL,   -- harvest|craft|consume|trade|salvage|salvage_loss|decay|seed
  cause_id UUID NOT NULL,
  PRIMARY KEY (world_id, at_step, id),
  CHECK (src_container IS NOT NULL OR cause IN ('harvest','craft','seed')),
  CHECK (dst_container IS NOT NULL OR cause IN ('consume','decay','salvage_loss')),
  -- Idempotent retries. Without this, a retried craft double-credits and nothing detects it.
  UNIQUE (world_id, cause, cause_id, item_def, src_container, dst_container)
) PARTITION BY RANGE (at_step);
-- There is deliberately NO 'gm' cause value, and no GM scope grants inventory.
```

**The goods ledger is the only writer of `item_stack`.** `GRANT` on `item_stack` is revoked from
every application role; all mutations go through `sl_move_goods()` (`SECURITY DEFINER`), which
writes both rows in one transaction. A nightly reconciliation recomputes holdings from the ledger,
compares against `item_stack`, and writes a signed per-world checkpoint row so that post-rollup
audits chain back to a verified state. Without reconciliation, "provable money supply" is a
convention; with it, it is a proof.

Retention: full detail 90 days, then daily rollup per `(world_id, item_def, cause)`, with the
checkpoint chain preserving auditability across the rollup boundary.

Money is a **per-world balance**, not an item stack (§10.7):

```sql
CREATE TABLE account_balance (
  world_id SMALLINT NOT NULL, account_id UUID NOT NULL,
  available_sol NUMERIC(16,4) NOT NULL CHECK (available_sol >= 0),
  escrowed_sol  NUMERIC(16,4) NOT NULL CHECK (escrowed_sol  >= 0),
  version BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (world_id, account_id)
) PARTITION BY HASH (world_id);

CREATE TYPE sol_kind AS ENUM
  ('mint_civic','burn_tithe','burn_upkeep','burn_storage','trade','toll',
   'escrow_in','escrow_out','purse_fund','purse_spend');

CREATE TABLE sol_ledger (
  world_id SMALLINT NOT NULL, id BIGINT NOT NULL, at_step BIGINT NOT NULL,
  kind sol_kind NOT NULL, debit_account UUID, credit_account UUID,
  amount NUMERIC(16,4) NOT NULL CHECK (amount > 0), ref JSONB,
  PRIMARY KEY (world_id, at_step, id),
  CHECK (kind <> 'trade' OR (debit_account IS NOT NULL AND credit_account IS NOT NULL)),
  CHECK (kind <> 'mint_civic' OR debit_account IS NULL)
) PARTITION BY RANGE (at_step);

CREATE TABLE world_trade_daily (   -- rollup; the monetary controller reads 30 rows, not the ledger
  world_id SMALLINT NOT NULL, day INT NOT NULL,
  volume_sol NUMERIC(18,4) NOT NULL, volume_units NUMERIC(18,3) NOT NULL,
  player_volume_sol NUMERIC(18,4) NOT NULL,   -- excludes civic fills
  PRIMARY KEY (world_id, day)
);
```

Balances are mutated only inside `SELECT ... FOR UPDATE` alongside the ledger insert. Escrow is a
transfer to a per-world system escrow account, so it stays inside the conservation identity.

### 3.6 Core tier — event queue, budgets, log

```sql
CREATE TABLE world_event (
  world_id SMALLINT NOT NULL, id BIGINT NOT NULL,
  due_step BIGINT NOT NULL,
  kind TEXT NOT NULL,
  subject_type TEXT NOT NULL, subject_id UUID NOT NULL,
  generation INT NOT NULL DEFAULT 0,
  payload JSONB NOT NULL DEFAULT '{}',
  account_id UUID,
  idempotency_key TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  PRIMARY KEY (world_id, id)
) PARTITION BY HASH (world_id);
CREATE UNIQUE INDEX ON world_event (world_id, account_id, idempotency_key);
CREATE INDEX ON world_event (world_id, due_step) WHERE state = 'pending';
-- kinds: caravan.cross_region caravan.arrive caravan.starve production.complete
--        stock.spoils listing.expire market.clear beam.warning beam.impact
--        region.dematerialize contract.expire world.metric monetary.tick
```

> The idempotency index is `(world_id, account_id, idempotency_key)`, not `(world_id, key)`. Two
> accounts independently choosing `move-caravan-1` must not collide — that failure reports success
> and never happens. Reschedule keys embed the generation
> (`caravan:{id}:arrive:{generation}`) and the handler no-ops when the subject's current generation
> does not match.

```sql
CREATE TABLE budget (
  world_id SMALLINT NOT NULL,
  subject_type TEXT NOT NULL,      -- 'account' (focus) | 'caravan' (stamina) | 'vehicle' (charge)
  subject_id   UUID NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('focus','stamina','charge')),
  amount NUMERIC(12,4) NOT NULL,
  capacity NUMERIC(12,4) NOT NULL,
  regen_base NUMERIC(12,6) NOT NULL,
  updated_step BIGINT NOT NULL,
  version BIGINT NOT NULL DEFAULT 0,      -- CAS. Without this, N concurrent spends cost 1.
  PRIMARY KEY (world_id, subject_id, kind)
) PARTITION BY HASH (world_id);

-- Per-token sub-cap on spend. min(account budget, token budget) is the effective limit.
CREATE TABLE token_budget (
  grant_id UUID NOT NULL, world_id SMALLINT NOT NULL, kind TEXT NOT NULL,
  spent_today NUMERIC(12,4) NOT NULL DEFAULT 0,
  cap_per_day NUMERIC(12,4),
  day INT NOT NULL,
  PRIMARY KEY (grant_id, world_id, kind)
);
```

### 3.7 `world_log` — the single source of all push

```sql
CREATE TYPE vis_kind AS ENUM ('public','account','spatial','market','party','broadcast','sealed');

CREATE TABLE world_log (
  world_id SMALLINT NOT NULL,
  seq      BIGINT   NOT NULL,        -- per-world. NEVER sent to clients (gap side channel).
  at_step  BIGINT   NOT NULL,
  type     TEXT     NOT NULL,
  subject_id    UUID,
  subject_owner UUID,                -- lets projectionFor() distinguish owner from bystander
  rev      BIGINT,                   -- per-subject monotonic; client idempotency key
  vis_kind vis_kind NOT NULL,
  vis_account     UUID,
  vis_cells       INT[],             -- 8×8 coarse-cell indices
  vis_market      UUID,
  vis_accounts    UUID[],
  vis_broadcaster UUID,
  payload          JSONB NOT NULL,   -- owner projection (superset)
  observer_payload JSONB,            -- NULL => identical to payload
  PRIMARY KEY (world_id, seq),
  CONSTRAINT vis_tagged CHECK (
       (vis_kind='public')
    OR (vis_kind='sealed')
    OR (vis_kind='account'   AND vis_account     IS NOT NULL)
    OR (vis_kind='spatial'   AND vis_cells       IS NOT NULL)
    OR (vis_kind='market'    AND vis_market      IS NOT NULL)
    OR (vis_kind='party'     AND vis_accounts    IS NOT NULL)
    OR (vis_kind='broadcast' AND vis_broadcaster IS NOT NULL))
) PARTITION BY RANGE (seq);
CREATE INDEX ON world_log USING GIN (vis_cells) WHERE vis_kind='spatial';
```

`sealed` exists from day one: private contracts, direct messages, and failed negotiations must never
appear in a concluded world's public replay, and adding an enum value after third parties have
shipped `switch` statements over `vis_kind` is a breaking change.

---

## 4. Simulation architecture

### 4.1 Two-tier LOD, both of them real cellular automata

**The coarse tier is an 8×8-tile CA, not a mean-field proportion vector.** This is the single
largest correction to the merged design and it is empirically forced.

> The simulation design's linchpin was a 12-element biome-proportion vector per region, and the
> critique measured it into the ground. Every land/water rule in `biomes.ts` is a **threshold** on
> `waterNeighbours` (`>=3`, `>=4`, `<=2`), and the real neighbour distribution is extreme-bimodal:
> at 1280×640, day 300, 98.8% of land tiles have zero water neighbours and none have ≥4. Mean-field
> assumes every tile in a region has `6·p_water` water neighbours. Over 200 regions: real tiles
> eligible for "sea takes it" = **0**, mean-field prediction = **9,702**; "silt builds" real = 0,
> predicted = 16,393. Jensen's inequality against a hard threshold, and the error is not drift, it
> is 0 versus thousands. The same defect flattens `livingNeighbours()`, which scales every regrowth
> rule 1..25 and is the **only** counter-force to the absorbing states BRAINSTORM names as the top
> risk. `world_metric` — the heat-death alarm — would have been computed from the tier that was
> wrong, so the alarm would measure its own approximation.

Coarse tier: 819,200 cells per world, `{biome u8, moisture u16, entered_step u32}` ≈ 6.5 MB
resident, one sweep per cell per day = **9.5 evals/sec/world** (~0.05% of a core at the measured
throughput). It runs the **identical rule set** as the tile tier, with neighbour coupling intact,
over the coarse hex torus.

Fine tier: materialized regions only. Fully materialized world = 51,200 regions × 8 KB = 410 MB
tiles + 410 MB immutable static.

**When a region is materialized, its coarse cells are a projection, not an independent simulation.**
At the end of every tile sweep the worker recomputes each of the 16 coarse cells from its 64 tiles
(modal biome, mean moisture, min entered_step). This is explicit because otherwise the two tiers
drift precisely where players live, and `world_metric`, beam forecasts and the supply model would
all read a fabricated state for the inhabited parts of the world. `sl-lab` asserts the projection
holds.

### 4.2 The sweep

```ts
const STEP_MS = 270_000;                 // 86_400_000 / 320
const MAX_CATCHUP_STEPS = 960;           // 3 real days, then status='stalled'

async function worldPass(w: WorldRuntime, budgetMs: number): Promise<void> {
  if (!w.lease.valid()) return release(w);
  const target = stepAt(w.row, w.skips, Date.now());
  if (target - w.step > MAX_CATCHUP_STEPS) return markStalled(w);   // human decision required

  const deadline = Date.now() + budgetMs;
  while (w.step < target && Date.now() < deadline) await sweepStep(w);
  await drainEvents(w, target);
  await drainCommands(w);
  if (w.step % 320 === 0) await writeWorldMetric(w);
}

// One step = one transaction. Reads a 3-region-column window (band + halo), writes 1 column.
async function sweepStep(w: WorldRuntime): Promise<void> {
  const rCol = w.step % REGION_COLS;                      // 320 columns; width % 32 === 0 exactly
  const band = await loadRegionColumn(w, rCol, /*halo*/ 1);
  coarseSweepColumn(w, band);                             // always, every region
  tileSweepColumn(w, band);                               // materialized regions only
  projectCoarseFromTiles(w, band);                        // materialized regions only
  await commitBand(w, band);   // skips region_terrain writes whose content_hash is unchanged
}
```

**Double-buffered within a band** (Jacobi inside the band, Gauss-Seidel across bands): tiles read the
pre-step snapshot of same-band neighbours and the post-step state of already-swept bands behind the
gaze. The prototype writes in place, so information propagates 32 tiles instantly within a band — a
visible directional artifact and the unanswered Session 3 OQ2. Double-buffering gives a well-defined
light cone (≤1 band/step along the sweep, ≤1 tile/revolution perpendicular), which is exactly the
bound materialization needs. **This changes simulation output, so it is a `ruleset_version` bump,
not a silent fix.**

`content_hash` comparison before write is what makes the storage model affordable: measured late-run
churn is ~1%/day, so a fully materialized world writes ~500 of 51,200 region blobs per day rather
than all of them. Without it, an 8 KB TOASTed blob rewritten 51,200×/day generates ~1–2 GB/day of
WAL per world plus an equal volume of dead TOAST tuples — three orders of magnitude above the
simulation design's stated 7 KB/s, and the number that would have made Postgres the whole project.

### 4.3 Materialization — constrained upsampling with a pinned boundary

```ts
export interface MaterializeInput {
  coarse:   CoarseCell[];        // 4×4 = 16 cells of THIS region
  neighbourCoarse: CoarseCell[]; // the surrounding ring, for interpolation
  static_:  StaticFields;        // 1024 × {elev, damp, rough, tectonic}, immutable
  boundary: BoundaryRing | null; // already-canon edge tiles of materialized neighbours
  step: Step;
}

/** O(1) in elapsed time. Deterministic in (sim_seed, region_idx, step, generation). */
export function materializeRegion(w: World, r: RegionIdx, in_: MaterializeInput): Uint8Array {
  // 1. Bilinearly interpolate coarse moisture and heat across the 32×32 tile field.
  // 2. Score each tile for each biome from (static fields, interpolated climate).
  // 3. Assign per 8×8 block so the block's modal biome equals its coarse cell's biome,
  //    with the remaining tiles drawn from the neighbour-blended mix (a coastline cell
  //    renders as a coastline because its neighbours are water, not because a histogram said so).
  // 4. PIN the boundary ring to already-canon neighbour edge tiles.
  // 5. Run 3 relaxation passes of the real tile CA with the boundary held fixed.
}
```

**The halo problem is solved by refusing to fabricate.** A caravan at the edge of a materialized
region sees into the neighbouring unmaterialized region at **coarse resolution** — the API returns
`detail: 'coarse'` and 8×8 blocks, explicitly and visibly. It never returns synthesized tiles that a
later materialization could contradict.

> The persistence design's `haloTile()` returned per-tile values for virgin ground from a function
> whose only inputs were the neighbour region's *whole-region histogram at time t*. Nothing
> constrained a later `materialize()` to agree, and because thresholds were taken at histogram
> quantiles, the same halo tile flipped biome day to day with no CA-legal transition. Concretely: a
> caravan camps for a week watching an ocean tile at a region boundary; on crossing, materialization
> renders it desert — while the *materialized* region's own CA spent that week counting
> `waterNeighbours` from water that never existed. Serving coarse detail at the frontier costs
> fidelity exactly where fidelity was a lie.

**Dematerialization**: a region with zero `region_pin` rows, no caravan in
`caravan(world_id, current_region)`, and no observer for 30 real days folds its tiles back into its
16 coarse cells and drops `region_terrain`. `region_static` is **kept** (immutable, and discarding
it is what would make rematerialization re-sort a contiguous strip and read as a bug). Exhausted
deposits (`remaining <= residual_floor`) drop their pin, so worked-out ground can fold back. The
observer check is derived from the caravan index, never a mutable `observers` counter — a worker
crash between increment and decrement either pins a region forever or dematerializes ground someone
is standing on.

### 4.4 Determinism

```ts
export const enum RollLayer { Tile = 1, Coarse = 2, Materialize = 3, Combat = 4, Market = 5 }

/** Keyed HMAC, 128-bit seed. Observing outcomes must not permit seed recovery. */
export function roll(
  simSeed: Uint8Array, layer: RollLayer, cellId: number,
  step: Step, ruleKey: number, rulesetEpoch: number,
): number;

/** Integer comparison, not float. Math.cos/Math.pow are not bit-reproducible across
 *  V8 versions or architectures, and a near-threshold float compare is exactly where
 *  a coastline's fate diverges on replay. */
export function accepts(h: number /*u32*/, p: number): boolean {
  return h < ((p * 0x1_0000_0000) >>> 0);
}
```

Four changes from the prototype, each required:

1. **`ruleKey` replaces the rule's array index.** The prototype calls
   `rollAt(this.seed, i, day, r)` where `r` is the loop position in `RULES_BY_BIOME[current]`.
   Adding, removing, or reordering a rule re-keys every historical roll for that biome — so any
   world resolved lazily after a ruleset edit produces different terrain from the one players
   explored. `ruleKey = hash32(rule.id)` with a stable string id makes the ruleset a data
   dependency, not a source-order dependency.
2. **Key on `step`, not `day`.** A crashed step rolls back and re-runs bit-identically.
3. **`rulesetEpoch` in the key**, bumped on ruleset migration, so a rules change does not produce
   correlated artifacts from reused roll keys.
4. **Moisture becomes fixed-point u16 (×100) end to end**, not float. u8 quantization (0.4/LSB)
   freezes the diffusion field entirely — `next = m + (target - m) * 0.5` rounds any gradient under
   ~0.8 to zero, killing the continental interior gradient that produces deserts without hand
   authoring. Float feeding threshold comparisons (`heat > SCORCHING`) reintroduces cross-platform
   replay divergence.

`sl-lab verify --seed X --days 1000 --expect-hash Y` is a required CI gate.

### 4.5 The beam

```ts
export interface BeamConfig {
  mode: 'off' | 'rotating' | 'terminal';
  transitDays: number;   // SEVERITY — dwell per tile
  cycleDays:   number;   // RECOVERY — gap between purges; dormant 83% of the time at 60/360
  widthCols:   number;   // BAND ONLY. Constraint: >= ceil(width / transitDays)
  startedStep: Step;
  direction: 1 | -1;
}
```

⚠️ **`widthCols` and its constraint are band-only, and the band is no longer the default
shape.** The prototype's beam is now `shape: 'band' | 'blob'` defaulting to `blob` — a hex disc
of `radiusHexes` travelling a sinusoidal track, swept along the day's arc (decision `0008`).
Under a blob the severity dial is `radiusHexes`, and the constraint `widthCols >= ceil(width /
transitDays)` — which exists so a full-height wall cannot step over a column without lighting it
— has no analogue: a blob is *expected* to miss most of the world on any given day, and what
bounds it instead is `2·radiusHexes + 1 < min(width, height)` so the disc cannot wrap onto
itself. The band survives as the validated `anvil` configuration and every number recorded
against it still reproduces; a `BeamConfig` for the shipped default needs a radius, not a width.

**Two knobs, not one.** The simulation design collapsed these into `periodDays`, which SIMULATION.md
documents as producing the *opposite* of the intended effect: a longer period means a slower beam,
so each tile bakes for longer and the world sterilises (at a single-knob 900-day period, water
reached 0%). The API returns both plus a derived `dormant_until`.

**Width saturation is a hard constraint, not a guideline.** At `width=10240, transit=60d, width=3`
the beam moves 170.7 cols/day, dwell is 0.018 days, so fractional exposure is 0.0176 — giving a
1.2% burn probability on the one lit visit and a heat bonus of +1.2 against `SCORCHING=78`. The
vitrification chain never fires; 98.8% of tiles survive a purge. The cleansing pillar silently stops
working, and the only signal is the churn alarm computed from the coarse tier. `beam_saturates` is a
table `CHECK`, and GM beam settings are additionally validated server-side against the `sweep.ts`
viability window (entropy > 0.65, churn > 0.15%, living land > 30%, waste < 45%, ≥8 biomes above
0.5%) before being accepted.

**Heat is applied at peak, not averaged.** The rules are threshold functions; averaging a +70 spike
over an exposure window destroys it. `exposure` modulates only the rule `pressure` channel:

```ts
// TileContext gains beamExposure and loses underBeam.
readonly beamExposure: number;   // 0 = dark; >0 = lit at some point since last visit
// heat += (beamExposure > 0 ? 70 : 0)
// cleansing rules:  when: (c) => c.beamExposure
```

### 4.6 Required ruleset repairs

These are terrain-sim changes the economy critique proved necessary; they are not optional polish.

| Defect | Measured | Repair |
|---|---|---|
| **Rock is a true absorbing state** | Every path back to Rock is gated on existing Rock (`Ocean→Rock` needs `counts[Rock]>=1`, `Shallows→Rock` needs `>=2`). Only `Tundra→Rock` is unconditioned, and needs heat<28 AND moisture<40. Rock exits to Barren at 70d whenever moisture>25. Measured 2.0% at worldgen → 0.03% (no beam) / 0.00% (beam) by day 800, never recovering. Once global Rock is 0 the uplift rules can never fire again — mathematically irreversible, and Rock carries the entire metal economy. | Add a static `tectonic` fbm channel to worldgen (already reserved in `region_static`). Add `Barren → Rock`, medianDays ~300, `when: c => c.tectonic > T ? 1 : 0`. Permanent mountain provinces that reliably regenerate — which is also what province mineral suites need geographically. |
| **Bloom has no hysteresis** | Entry needs `moisture>78 AND heat∈(52,70)` at 18d; exit fires on `heat>62 OR moisture<60` at 5d. The exit window strictly *contains* the entry window and fires 3.6× faster, so Bloom is structurally a transient — killing sunpetal/nectar/essence, the game's keystone charged materials. | Every rule pair gets a hysteresis gap. Bloom exit: `heat > 72 OR moisture < 52`. |
| **Marsh is squeezed from both sides** | Drowns at ≥3 water neighbours, dries at heat>62 with ≤2, with one rare entry geometry. | Widen `Grassland→Marsh` (already present at 16d, `waterNeighbours>=2 AND moisture>WET`) and raise the drying threshold. |
| **Ash/char/cinder are unobtainable** | Ash sits at 0.00% of the map whenever the beam is off. | Move ash/char/cinder to `origin='salvage'` — recovered from beam ruins, not harvested from a biome. |
| **`run.ts` beam flag is inert** | `run.ts:51` passes `beamPeriodDays` to a `WorldOptions` that declares only `beamTransitDays`/`beamCycleDays`. Node strips types without checking, so `--beam-period` has never done anything. `package.json`'s `sim:long` passes `--sweeps`, which `run.ts` does not read. | Add `typescript` devDep + `tsc --noEmit` to CI. Fix flags to `--beam-transit`/`--beam-cycle`. **Re-derive all beam-vs-survival numbers before trusting them** (§11.2). |

Session 8's requirement that the biome transition graph be a **single strongly connected component**
is a Tarjan pass over ~20 nodes and runs on every ruleset change, alongside eccentricity reporting.

### 4.7 Single writer, fenced

One `sl-worldsim` process leases a world and performs **all** simulation-domain writes. Split-brain
is prevented by a fencing token, not a TTL: `world_lease.lease_epoch` increments on acquisition and
every sim write carries `AND lease_epoch = $mine`, so a stale writer's updates affect zero rows.
After N acquisition failures the world enters `status='stalled'` rather than being repeatedly picked
up and re-crashed by fresh workers.

~64 worlds per process on a cooperative scheduler with a per-world time budget; `worker_threads`
reserved behind a `world.tier='heavy'` flag. The workload is 99.99% idle: a fully materialized world
needs ~600 tile-evals/sec against a measured 12.2M/sec single-core (~1.9M/sec if static fields are
recomputed rather than cached — hence `region_static`).

**Write boundary**, enforced by DB role grants rather than by review: `sl-api` mutates state owned by
exactly one account (moving an item within your own caravan, renaming a character, fitting a slot)
through `SECURITY DEFINER` functions with row locks. Anything that arbitrates between accounts or
touches terrain is submitted as a command row and executed by the owning worldsim.

---

## 5. API contract and authorization

### 5.1 Three visibility planes

Declared per operation as `x-visibility-plane`, CI-enforced.

- **cosmic** — physics. World size, tick rate, sweep phase, beam ephemeris. Unauthenticated.
- **public** — the Chronicle. Facts someone deliberately published, the GM log, the world directory.
- **private** — the actor's observations. Every handler wrapped in `withActor()`.

### 5.2 Roles and the enforcement of fog

```sql
-- CI GUARDS (migration test suite; all must return false):
--   has_table_privilege('api_reader','region_terrain','SELECT')
--   has_table_privilege('api_reader','region_coarse','SELECT')
--   has_table_privilege('api_writer','region_terrain','SELECT')
--   has_table_privilege('api_writer','market_book','SELECT')
--   has_table_privilege('gm_writer','item_stack','INSERT')
--   has_table_privilege('gm_writer','sol_ledger','INSERT')
--   has_table_privilege('gm_writer','region_terrain','UPDATE')
```

`api_reader` has `SELECT` on observation and owned tables only, under RLS.
`api_writer` has **zero table privileges** — only `EXECUTE` on `SECURITY DEFINER` functions
(`sl_place_market_order`, `sl_enqueue_caravan_order`, `sl_apply_survey`, `sl_move_goods`) that
internally read truth and return only a receipt, an error code, and observation rows the actor was
already entitled to.

> This resolves the API design's central contradiction: `withActor` did `SET LOCAL ROLE api_reader`,
> which by its own `REVOKE` cannot read `market_state` — so standing in a market and trading, the
> one legitimate live-truth read the "goods physically move" pillar requires, was unimplementable.
> The obvious fix (an `api_writer` with `SELECT` on truth) would have reinstated a truth read path
> inside the API process, where one `RETURNING *` or one logged error leaks it.

The API pool **logs in as** `api_reader`/`api_writer`. It does not `SET ROLE` into them, and holds
no membership in `sim_writer` or the table-owner role — otherwise a single reachable `RESET ROLE`
restores full truth access inside a live request transaction. Every owned table carries
`owner_account_id`, an RLS policy, and `FORCE ROW LEVEL SECURITY`.

Grant narrowing is a **DB-visible fact**, not application code:

```sql
ALTER TABLE account_region_memory ENABLE ROW LEVEL SECURITY;
CREATE POLICY memory_visible ON account_region_memory FOR SELECT TO api_reader USING (
  account_id = current_setting('app.actor_id')::uuid
  AND EXISTS (SELECT 1 FROM grant g
              WHERE g.id = current_setting('app.grant_id')::uuid
                AND g.revoked_at IS NULL
                AND (g.world_id IS NULL OR g.world_id = account_region_memory.world_id))
);
```

Without this, a third-party map site narrowed to world A receives world B's observations from any
handler that filters on the path parameter rather than on `tok.wld` — and the database agrees,
because the player does own those rows.

**Set-based, never per-row.** `couldObserve(account, tag, step): Promise<boolean>` was specified as
a per-row async predicate imported by four transports; reconnect replay over a busy world is
thousands of rows, so the hottest path in the system would be an N+1 that scales with
(reconnects × rows) — presenting as the database falling over during exactly the network blips that
cause correlated reconnects. The primitive is:

```ts
export function filterObservable(
  account: AccountId, world: WorldId, rows: LogRow[],
): Promise<LogRow[]>;   // ONE query, joining candidates against observation_interval
```

### 5.3 Auth

OAuth 2.1 against `auth.sunbornlegacy.com`, a separate origin. Three profiles:
authorization-code + PKCE (interactive), RFC 8628 device-code (headless bots and NPC operators with
no browser), and self-issued **agent keys** (opaque, rotatable, mintable by an account for its own
programs, sharing the same grant/revocation tables).

```ts
interface SunbornAccessToken {
  iss: 'https://auth.sunbornlegacy.com';
  aud: 'https://api.sunbornlegacy.com';   // REQUIRED. Distinct audience per service.
  sub: string;   // acc_… the ACCOUNT. NPCs included; there are no accountless actors.
  azp: string;   // cli_… which client is speaking
  gid: string;   // grant id — object narrowing and spend caps resolve from this
  scope: string;
  wld?: string;
  act?: 'human' | 'program' | 'gm';
  rev: string;   // effective dated revision, clamped to [client.min_revision, current]
  jti: string; exp: number; iat: number;
}
```

`aud` is mandatory and derived from RFC 8707 `resource` at `/authorize`. Without it, the MCP server
— which explicitly holds the user's token — can replay it against the auth server's own APIs. This
is textbook token confusion and it is unfixable once third parties depend on the token shape.
`refresh_token` with rotation and reuse detection exists (`offline_access`), because a 10-minute
access token with no refresh grant makes headless bots — the pillar's primary audience — impossible,
and third parties would route around it by asking players for master credentials, which Session 5
calls unrecoverable.

Authority is three orthogonal dimensions:

```
scopes            chronicle.read  world.observe  roster.read  caravan.read  industry.read
                  commerce.read   account.read
                  caravan.command industry.command settlement.command market.trade
                  treasury.spend  contract.sign  chronicle.publish  diplomacy.write
                  survey  research
elevated          account.manage      (see below)
gm                gm.event  gm.npc  gm.route  gm.terrain  gm.moderate  gm.world
meta              offline_access

grant_object      narrows a grant to specific caravan/settlement/character ids.
                  Zero rows for a type => the grant covers all of that type.
caps              spend_cap_sol_per_day, max_standing_orders, token_budget sub-caps
```

> **`account.manage` is obtainable by any registered client**, via step-up authorization
> (`prompt=login&max_age=0`, short-TTL access token, no refresh, no `offline_access`). The API
> design made it "permanently non-delegable to third-party clients, i.e. a first-party session,"
> which is by construction a set of endpoints only the official client can call — a direct violation
> of the pillar and of the PITCH's stated goal ("build a better UI than the official one; that's the
> goal"). A player on a third-party client could not mint an agent key, revoke a grant, or buy a
> world. The genuinely first-party-only parts (credential change, card entry) are **hosted pages on
> the auth origin** that every client redirects to equally — that privileges an origin the auth
> server owns, not a client. The official client ships using exactly this flow.

### 5.4 Budgets, not 429s

Three in-world budgets, lazily resolved, CAS-written:

- **stamina** per caravan — movement, load/unload, forage, build
- **charge** per vehicle — craft, refine, survey scan, long-range signal
- **focus** per **account** — orders, negotiation, contracts, cartography, chronicle publishing

```ts
/** Additive by construction: resolve(t2) == resolve(resolve(t1), t2) for any t0<t1<t2.
 *  Property test required — non-additive lazy fast-forward is the definitional break. */
export function resolve(b: BudgetRow, at: Step, w: WorldPhase): number {
  const dt = at - b.updated_step;
  if (b.kind !== 'charge') return Math.min(b.capacity, b.amount + b.regen_base * dt);
  // Solar charge regen breathes with the gaze. Both gaze phase and a travelling caravan's
  // column are closed-form functions of step, so this is an INTEGRAL, not a sample.
  return Math.min(b.capacity,
    b.amount + b.regen_base * gazeIntegral(w, b.subject_id, b.updated_step, at));
}
// gazeIntegral is normalised so the revolution-average multiplier is exactly 1.0.
```

> The API design sampled `world.gazeProximity()` at read time and multiplied it by the whole elapsed
> interval. Spend charge while the gaze is distant (×0.4), wait a day, read at the moment the gaze
> crosses your column (×1.6), and 14,400 ticks of regen get scaled by 1.6 — a 4× swing controlled
> entirely by read timing, free, deterministic, and available only to bots. Separately, with band 8
> on width 240 the gaze is over any column ~3% of the time, so the mean multiplier was ~0.44:
> `regen_base` silently meant "less than half of `regen_base`."

Over-spend returns `409` with an in-fiction problem type carrying `required`, `available`, and
`restored_at` — computed from **wall clock**, so a bot schedules against it instead of retrying.
`restored_at` accuracy is contractual; if it is optimistic, well-behaved bots degrade into polling
bots and the 429 problem returns through the front door.

Reads are free and never gated by budgets. HTTP 429 exists only as an infrastructure floor
(40 req/s sustained per token, 8 sockets per account, plus a per-IP bucket on the unauthenticated
cosmic plane), documented as infrastructure, not balance.

`x-budget-cost` is an **expression over request parameters**, validated in CI against the handler's
actual cost function, with hard schema bounds:

```yaml
x-budget-cost: { charge: "25 + 6 * radius^2" }     # survey; radius <= 3 enforced in schema
x-budget-cost: { stamina: "2 * path_length" }      # move
x-budget-cost: {}                                  # every GET
```

A static `{ charge: 25 }` on a `radius`-parameterized survey is either a lie the SDKs, docs and MCP
tool schemas all propagate, or the truth — in which case `radius: 200` buys ~120,000 observations
for 25 charge and deletes fog of war in one call at the price of a 2-hex scan.

### 5.5 Endpoints

```
COSMIC — unauthenticated, geometry only, no terrain and no ownership
  GET /v1/worlds                          directory, tags, open slots, GM identity
  GET /v1/worlds/{w}                      width, height, topology, ticks_per_day, epoch,
                                          display_seed (NOT the sim seed), asset pack
  GET /v1/worlds/{w}/clock
      -> { step, tick, day, sweep_lag_steps,
           beam: { mode, transit_days, cycle_days, width_cols, leading_column,
                   direction, dormant_until } }
  GET /v1/worlds/{w}/beam/forecast?col={col}&horizon=P30D
      -> { col, passes: [{ enters_at, exits_at, days_until }] }
      # COLUMN ONLY. Pure orbital geometry; reveals no terrain and no site.

PUBLIC — the Chronicle
  GET  /v1/worlds/{w}/chronicle?since=&kind=
  GET  /v1/worlds/{w}/gm/log              append-only, no GM opt-out (§7.3 for the delay rule)
  GET  /v1/worlds/{w}/economy/monetary    supply, target, civic index, 30d volume
  GET  /v1/worlds/{w}/economy/purse       GM budget balance and spend history
  GET  /v1/worlds/{w}/economy/endowment   accounts spawned, endowment pool remaining
  GET  /v1/worlds/{w}/leaderboards        breadth of industry, tonnage hauled, routes run
  POST /v1/worlds/{w}/chronicle           scope chronicle.publish; costs 4 focus

PRIVATE — cartography. Observations only, never truth.
  GET /v1/worlds/{w}/view?since={seq}&limit=5000
      -> { cursor, tiles: [...], features: [...], removed: [...] }
      ETag: W/"{account}:{max_seq}"        # If-None-Match => 304
  GET /v1/worlds/{w}/regions/{r}
      -> { detail: 'tiles'|'coarse', blob: base64(masked), seen_mask, observed_at,
           observed_step }                 # 404 if never witnessed
  GET /v1/worlds/{w}/regions?rect={rx,ry,w,h}&since={versions}
      Cache-Control: private, must-revalidate    Vary: Authorization
      # w*h <= 64 regions per request; 400 rect_too_large otherwise
  GET /v1/worlds/{w}/sync?since_memory_version={n}
      -> one-call resync; cursor guaranteed <= snapshot point
  GET /v1/worlds/{w}/search?material=iron&max_age=P7D&near={caravan}
      # queries account_region_memory ONLY; RLS makes a leak impossible even if wrong

  POST /v1/worlds/{w}/caravans/{id}/survey  { radius }     # radius <= 3; costs charge
  POST /v1/worlds/{w}/caravans/{id}/orders                 # Idempotency-Key required
       Sunborn-Dry-Run: true                               # quote + validation, zero effect
       body: { kind: 'move_to', to, route: 'known'|'direct' }
           | { kind:'load'|'unload'|'forage'|'camp'|'craft', ... }
       -> 202 { order_id, eta_estimate, confidence, unknown_tiles, cost, budgets }
       -> 409 problems/insufficient-stamina { required, available, restored_at, subject }
  DELETE /v1/worlds/{w}/caravans/{id}/orders/{orderId}
  POST /v1/worlds/{w}/caravans/{id}/split | /merge

  GET  /v1/worlds/{w}/markets?near={tileIdx}&within=32     # discovered markets only
  GET  /v1/worlds/{w}/markets/{id}/board                   # 404 unless observed
       -> { as_of, staleness_seconds, source, present, asks, bids, stockroom, next_clear_at }
  POST /v1/worlds/{w}/markets/{id}/lots                    # REQUIRES presence
  PATCH/DELETE .../lots/{l}                                # remote OK; goods stay put
  POST /v1/worlds/{w}/markets/{id}/take                    # REQUIRES presence
  POST /v1/worlds/{w}/markets/{id}/bids                    # escrows sol; fills on delivery
  POST /v1/worlds/{w}/contracts/haul  |  .../accept

  GET  /v1/me                  { scopes, objects, caps[], limits, worlds[] }
  GET  /v1/me/entitlements
  GET  /v1/me/budgets
  GET  /v1/me/agents | /v1/me/grants   (step-up required; any client may do it)

DELIBERATELY ABSENT AT EVERY SCOPE
  GET /v1/worlds/{w}/tiles                      any coordinate-parameterized live read
  GET /v1/worlds/{w}/state
  GET /v1/markets?sort=price                    any cross-market index or price feed
  any per-site beam forecast on the cosmic plane
  any endpoint returning `generation` or `materialized_step`
```

**Three information oracles were closed** that none of the designs' own defences caught, because the
leak was in a return value rather than in row access:

1. **Route quotes.** Dry-run `cost` and `eta`, `search`'s `est_travel_ticks`, and `arrives_at` are
   all scalar functions of terrain. A bot dry-runs `move_to` against the 6 neighbours of a probe
   point and reads back a per-tile terrain signal without moving — ~3.4M probes/day/token at the
   documented infra floor, enough to resolve a 52M-tile world's traversability class in days.
   **Fix:** all route planning, costing, and ETA are computed from `account_region_memory` only,
   substituting the region's coarse climate prior for unwitnessed cells. Every quote returns
   `unknown_tiles` and `confidence`, is explicitly non-binding across unwitnessed segments, and
   `arrives_at` is revised forward at each region crossing. A CI gate fails any code path reachable
   from a `private` operation that touches the truth-plane pathfinder.
2. **Per-site beam forecast.** `daysUntil: Record<SiteId, number>` on a `public` push channel
   leaks position, because the forecast is a function of the site's location and the beam's
   geometry alone. Under the band this was *exactly* invertible against the prototype's
   `daysUntilBeam(col)` — `col = w·(daysUntil + intoCycle)/transitDays` — so a spectator token
   yielded the exact column of every settlement in the world, refreshed live. **The closed form
   is band-only and no longer holds in the general case:** the prototype's signature is now
   `daysUntilBeam(col, row)`, because the shipped beam is a disc on a sinusoidal track and a
   column no longer determines an arrival time — a tile the track misses returns `Infinity`,
   meaning *never*, not *not yet* (decision `0008`). That weakens the inversion to a constraint
   rather than an equation, which is a smaller leak and not a closed one: a series of forecasts
   over time still narrows a site to the track's neighbourhood. **Fix, unchanged:** the cosmic
   plane serves column geometry only. Per-site forecasts are `vis_kind='account'` (your own
   sites) or region-gated.
3. **Breakeven calculator.** The economy design's unauthenticated
   `GET /v1/economy/breakeven?atTile=` returned `localYieldPerDay` (deposit richness after crowding)
   and `amortHorizonDays` (days until beam). Iterating enumerable tile ids yields a complete geology
   map **plus** a rival-activity map, free, without an account. **Fix:** split into a stateless
   calculator taking only hypothetical scalars and no world identifiers, and an authenticated
   `POST /v1/worlds/{w}/economy/breakeven` whose `build` block is served only for tiles in the
   caller's survey set.

**Uniform `404`, never `403`, with constant-time lookup.** Unwitnessed and nonexistent are
indistinguishable for tiles, settlements, markets, caravans, characters, and contracts; a `403` is
an existence oracle that maps every settlement in the world without moving. The same applies to
`/tiles/{t}/deposits`: unsurveyed, nonexistent, unmaterialized, and out-of-range all return an
identical body, in constant time, so response latency does not leak the materialization frontier
either. Materialization must also carry a small constant-time floor — otherwise a bot detects "this
region had no row" from latency, which leaks that nobody has ever been here.

`POST /survey` requires the caravan to be on or adjacent to the target tile, validated server-side
against its lazily-resolved position.

### 5.6 Versioning

URL major `/v1` (multi-year events) plus Stripe-style dated revisions
(`Sunborn-Revision: 2026-07-29`) **frozen at OAuth client registration**, so an abandoned
third-party client keeps working without its author ever having heard of the header. Requests are
**clamped to `[oauth_client.min_revision, current]`**: retiring a revision for a security reason
raises `min_revision` on every client at once and is the one documented exception to the 180-day
sunset window. Without the clamp, a client registered today can keep requesting a dated revision
that was retired for over-sharing a field, and the back-render shim will faithfully serve it.

Because tokens carry `azp`, sunset notices go to the humans actually affected.
`GET /v1/deprecations` lists what the calling client specifically still depends on.

### 5.7 MCP

The MCP server is a **generated OAuth client**, not a peer. Each tool declares
`x-composes: [operationIds]` and is code-generated from the OpenAPI spec; it holds no service
account and no DB access, and performs every action as an outbound `/v1/*` call with the user's own
token. A tool requiring authority no REST operation grants cannot be generated.

Two rules specific to MCP, both CI-checked:

- **Coarse tools compose only fine-grained calls the same token could make itself.** A tool must not
  aggregate across cells in a way no single call would reveal.
- **"nearest_*" searches are restricted to regions with an `account_region_memory` row** and return
  `{ found: false, regions_searched: n }` otherwise, stated in the tool contract so agent authors
  design around it. `send_caravan_to({target:'nearest_water'})` answered truthfully over unseen
  terrain is a triangulation oracle, and it would hand LLM clients a capability REST clients lack —
  contradicting both "no privileged endpoints" and "same authority, different granularity."

```
survey_surroundings(caravan, depth?)     read_the_sky(world, col?)
send_caravan_to(caravan, target, dry_run?)   plan_supply(material, rate, settlement)
plan_trade_run(caravan, budget?)         post_haul_contract(...)
await_events(timeout_s)                  what_can_i_do()
```

`dry_run` defaults to **true** on the first call in a session, so a hallucinated plan cannot silently
burn a caravan's stamina before the human sees it. Budget 409s render as in-fiction prose plus
`restored_at`, which is what makes an agent wait rather than retry-loop.

---

## 6. Realtime layer

### 6.1 One log, one audience resolver

Nothing is pushed that is not a durable `world_log` row. Push, catch-up, audit, GM transparency, and
replay are one mechanism. WebSocket, SSE, and long-poll carry an identical envelope and share
`filterObservable`.

```ts
export interface Envelope<T extends EventType = EventType> {
  seq: number;      // GAPLESS, per-connection, assigned at delivery. The world seq is never sent —
                    // gaps in a global sequence tell you how much happened where you cannot see.
  type: T;
  step: number;
  at: string;
  subject?: EntityId;
  rev?: number;
  proj: 'owner' | 'observer';   // idempotency key is (rev, proj), not rev alone
  data: EventPayload<T>;
}
```

> `projectionFor()` originally received only the visibility tag, which contains no ownership
> information — so your own caravan, arriving via the `vision` channel's spatial rows, would get the
> redacted observer projection. Emitting two rows per event made it worse: both carry the same
> entity `rev`, so the client's `rev > local` guard drops whichever arrives second,
> non-deterministically. Hence `world_log.subject_owner`, one row with both projections, delivery-time
> selection, and a `proj` discriminator in the envelope. The observer projection is contractually a
> strict field-subset of the owner projection.

### 6.2 Channels

```ts
export type Channel =
  | 'self'                       // your entities.        scope self:read
  | 'vision'                     // fog-filtered world.   scope world.observe
  | 'world'                      // GM announcements, gm log, beam geometry. world:read
  | `market:${MarketId}`         // requires a stationed clerk or presence
  | `broadcast:${AccountId}`;    // opt-in, delayed. world:read
```

**There is no coordinate-parameterized channel.** `vision` takes no coordinates at all — the server
sends what your observers cover. An endpoint whose parameter space can be enumerated will be
enumerated, and subscribe-denied responses are themselves an oracle, so subscribing to a topic you
cannot see yields an **empty subscription, never an error**.

`entity:{id}` is deleted: your own entities already arrive on `self` and observed ones on `vision`,
and its only unique function was subscribing to something outside your sight. `broadcast` gets a
first-class `vis_kind` and is emitted as a **separate, delayed, independently projected row** — not
a time-shifted copy of a spatial row — so `filterObservable` remains the single evaluator. CI asserts
`Channel` members map 1:1 onto `vis_kind` values.

**Broadcast publishes only what the broadcaster owns.** Other accounts' entities appear as
anonymized presence at coarse-cell granularity or not at all. A unilateral decision by one account
must not publish third parties' asset positions to the world; the 10-minute delay is sized against
ephemeral intel and is irrelevant for the durable intel (where cities are, which routes are used)
that a parked broadcaster leaks.

### 6.3 Map delivery — three tiers

| Tier | Auth | Content | Caching |
|---|---|---|---|
| **atlas** | `world:read` | one dominant biome per region, 51,200 bytes, **static at worldgen** | public, CDN, immutable |
| **region memory** | `world.observe` | 4 KB fixed-stride blob + 128 B mask, per account | `private, must-revalidate`, `ETag`, `Vary: Authorization` |
| **live patches** | `world.observe` | `terrain.swept` deltas inside current sight | stream |

The atlas is **static at worldgen** rather than refreshing. A live atlas is a free global
commodity-change feed — a bot diffs it daily and detects terrain transitions worldwide, which is
precisely the scouting value the design wants to keep scarce. A `world.atlas_policy` knob retains
`'discovered'` and `'none'` for GMs who want strict fog.

Wire chunk format is **fixed stride**: always 1024 tiles × 4 bytes, unseen tiles zero-filled, with
`seen_mask` as the sole authority on validity.

```
byte 0  biome    u8      byte 2  flags    u8   (b0 hazard, b1 beam-forecast, b2 yours,
byte 1  feature  u8      byte 3  moisture u8    b3 other-owned, b4 ruin, b5 coarse-detail)
```

Variable-stride "4 bytes per *seen* tile" — the schema comment in the realtime design — contradicted
its own "exactly 4 KB, upload as a 32×32 RGBA8 texture" claim, required CPU scatter-expansion the
render pipeline never described, and made a single newly-seen tile shift every subsequent offset, so
deltas degenerated to full resends on exactly the chunks that are actively changing. Fixed stride
zstd-compresses a mostly-zero block to tens of bytes and uploads directly.

**Snapshot version and patch stream are separate clocks.** A chunk's effective state is
`snapshot@snapshot_step` plus all retained `terrain.swept` patches with `step > snapshot_step`; a
patch is discarded only when a snapshot with `snapshot_step >= patch.step` arrives. Without this
split, coalescing memory writes (the mitigation for write amplification) rolls a player's map
backwards by a day on any cache eviction — a data-loss bug that only manifests after a cache miss
and so never appears in development.

### 6.4 Reconnection

Opaque server-side cursor (Redis, 15 min TTL) holding `{log_seq, cells_at_disconnect, channels}`.
Replay filters through **visibility as of event time** via `observation_interval`, unioned with the
snapshotted disconnect cell set — replaying through *current* visibility is wrong in both directions.
Beyond the window: `stream.lagged` → single-call `/sync` → resubscribe, with revision-keyed
idempotent apply, so the resync path uses the same apply code as live and is exercised constantly.

`/sync` accepts `?since_memory_version=` and returns only changed regions. Returning a veteran's
entire chunk index (tens of thousands of entries, ~1 MB of JSON) on every reconnect is
self-reinforcing failure on a flaky mobile link: the resync is large enough to fail, triggering
another resync.

The SDK ships a chaos toggle (`createStream({ chaos: { dropEveryMs } })`) enabled by default in dev
builds, because resync is the most-executed path in production and the least-tested in development.

### 6.5 Assets

CC BY 4.0 with an explicit trademark carve-out (name, wordmark, logo, and the "official client"
badge are reserved). Public versioned manifest at `assets.sunbornlegacy.com/v1/manifest.json`,
content-hashed, `public, max-age=31536000, immutable`, no auth. Chunk routes live on a different
hostname so the CDN config cannot reach them.

Cosmetics are a server-set field on the entity (`skin: 'sunforge_wagon'`) whose asset is in the
public manifest. Third-party clients render paid cosmetics correctly and cannot grant them; the
entitlement check is a server-side write guard on the field. Encrypted/entitled asset delivery is
rejected — trivially defeated, costs a DRM pipeline, and contradicts the open-ecosystem pillar.

---

## 7. Economy

### 7.1 Materials: harvest flows vs. permanent geology

- **HARVEST** — renewable flow, tied to the *current* biome and continuous climate fit. These can
  legitimately vanish when a biome does.
- **DEPOSIT** — finite stock, **permanent geology**. A deposit's existence never depends on biome;
  the biome sets an `exposure` multiplier from 0 (ocean, unreachable) to 1.0 (glass/barren, exposed).

This is the fix for the largest measured economic failure: with materials as a property of biome,
Bloom/Marsh/Ash/Glass going extinct in the stationary distribution deletes 12 of 36 materials
permanently and bricks every recipe depending on them. Permanent geology means terrain change
**reprices** the map (a copper seam under forest is expensive to mine; the same seam under glass is
cheap) instead of annihilating it — preserving the "living world is the supply curve" synergy while
removing the risk that a ruleset tweak silently deletes a production chain.

**Province mineral suites** break the collinearity. Measured: 36 declared materials collapse to only
11 distinct global-availability values, because all three materials of a biome are always exactly as
common as that biome — silica/glasslite/prism are indistinguishable in scarcity forever, so the
trade graph has ~12 economically distinct nodes rather than 36, and two forests 400 tiles apart are
economically identical. Worldgen partitions the world into 40–80 provinces; each draws a suite of
2–4 deposit materials.

Worldgen constraint solver (not emergent — the CA actively destroys these):

- (a) every province holds ≥1 material in the world's bottom availability quartile;
- (b) every deposit material occurs in ≥3 provinces (no single-source chokepoint one player can
  monopolize or the beam can erase);
- (c) every province satisfies a survival floor — food, water, fuel, and a structural material within
  N tiles, where **N is derived from starting caravan speed and food consumption**, not asserted.

### 7.2 Recipes and progression

Inputs are specified as material **classes** (fiber, fuel, ore, flux, stone, grain) for most slots;
only `charged` and `living` materials (sunstone, prism, essence, sunpetal, pearl, rime) are
non-substitutable keystones. Substitutability makes demand elastic, prevents a scarce material's
price running to infinity, and means a biome going extinct raises prices instead of bricking a chain
— and it is thematically exact that only solar-charged and living materials are irreplaceable.

**Class membership is lossy, via potency.** A class slot requiring qty Q consumes `Q / potency` units
of the chosen member; scarcer members carry higher potency.

> Without potency, classes cancel provinces: buyers purchase only the cheapest member, every scarcer
> member trades at the cheapest member's price or not at all, and the trade graph collapses from 36
> material prices to ~8 class prices — the exact failure province suites were introduced to fix,
> reintroduced from the demand side. The `affinity IN ('charged','living') <=> classes = '{}'` iff is
> also relaxed to a one-way implication: an inert material with no class is a legitimate
> non-substitutable non-keystone.

**Station throughput is flat across the entire game.** There are no faster, more efficient, or
higher-yield station tiers. Progression is (recipes known) × (station slots owned) × (places
operated). The only efficiency lever is recipe substitution, capped at **1.5×** total across the
whole tech graph — a real but bounded reason to research rather than a treadmill.

**Diminishing returns exist in the account, not only the tile.** Per-tile crowding is
`yield = 1 / (1 + load / carrying_capacity)` over all stations drawing that material from that tile
regardless of owner — which correctly makes breadth beat depth. But on a 52M-tile torus, unclaimed
good tiles are effectively unlimited, so marginal yield on a *new* tile is always full yield while
marginal upkeep is constant: profit reinvests at constant margin, which is geometric growth in total
wealth. Flat power would be preserved per unit and violated in aggregate — a veteran would not have
a better smelter, they would have ten thousand smelters. **Fix:** `load` counts the same account's
stations *in the same province* at a higher weight, so the fifth outpost in a province earns
meaningfully less than the first. Expansion is still rewarded; expansion *in one place* is not.

Vehicle-mounted stations contribute to `tile_extraction_load`. Otherwise parking a caravan train on
one tile bypasses crowding entirely — the exact depth-over-breadth exploit crowding exists to
prevent.

### 7.3 Yield is an integral, not a sample

```sql
-- Append-only epoch tables, written by the sweep and by station create/destroy.
CREATE TABLE tile_biome_epoch (
  world_id SMALLINT NOT NULL, tile_idx BIGINT NOT NULL,
  from_step BIGINT NOT NULL, biome SMALLINT NOT NULL,
  PRIMARY KEY (world_id, tile_idx, from_step)
) PARTITION BY HASH (world_id);

CREATE TABLE tile_load_epoch (
  world_id SMALLINT NOT NULL, tile_idx BIGINT NOT NULL, material_id TEXT NOT NULL,
  from_step BIGINT NOT NULL, load NUMERIC(10,3) NOT NULL,
  PRIMARY KEY (world_id, tile_idx, material_id, from_step)
) PARTITION BY HASH (world_id);
```

Production resolves as a **sum over epochs intersecting `[last_collected_step, now]`**.

> Evaluating the endpoint instead of the integral has two exploitable failures. A tile that was
> Forest (exposure 0.15) for 29 days and is glassed (1.0) today pays 30 days at 1.0 — a 6.7×
> windfall, farmable by simply not collecting until the beam passes. And when a rival builds a
> station, everyone else's accrued-but-unread yield is silently repriced, so output depends on read
> order rather than elapsed time. This is the one place the designs assumed a tick loop where lazy
> resolution was required, and it cannot be patched later because it is a missing table. Rows accrue
> only for materialized tiles, consistent with lazy materialization.

Deposits deplete to a `residual_rate` (tailings), never to zero, and the beam re-stamps a fresh
deposit at full richness on any tile it glasses or bares — giving the rolling frontier a real
economic identity and making monopolies impermanent without an anti-monopoly rule. Re-stamping is
keyed on `stamped_purge_index = floor(day / cycle_days)` with
`INSERT … ON CONFLICT DO NOTHING`, **not** a wall-clock `stamped_at`: at most one stamp per deposit
per purge, derived from world-day arithmetic, deterministic under replay, and immune to beam dwell
time. A wall-clock timestamp would make a slow beam a richness fountain and make geology a function
of when the server ran.

### 7.4 Markets

A market is a building with a physical `stockroom` measured in kg — a hard physical ceiling on hub
size. Selling requires a caravan present to deposit; buying requires presence to take. Only three
things are remote: changing your lot's ask price, cancelling a lot (goods stay put, marked
reserved), and posting standing bids that fill on physical delivery.

**Clearing is a discrete call auction on the event queue** (`market.clear` re-enqueued every N
minutes, owner-configurable above a floor), not continuous matching. Even with physical escrow,
continuous matching rewards submission latency and reintroduces the APM advantage the whole design
exists to avoid; discrete clearing also makes market resolution deterministic under the single-writer
model. Owner-configurable cadence makes clearing speed a competitive feature of a market, which is
exactly the Schelling-point emergence Session 6 wants — the floor prevents a race to continuous.

**No global index, no cross-market matching, no price feed.** `GET /markets` takes `near` + `within`
(capped server-side) and returns only markets in the caller's memory. Market prices are
fog-gated and are themselves a tradeable, decaying good: the board requires presence, a stationed
broker, or a valid `price_report`, and otherwise returns your own cached observation stamped with
`observed_at` and `staleness_seconds`. Perfect price information collapses regional prices even when
goods move slowly, because everyone converges on the same expectation instantly.

The database index `(world_id, market_id, item_def, unit_price)` exists. The index
`(world_id, item_def, unit_price)` **deliberately does not** — a future engineer who ships a global
best-price scan will notice it is a sequential scan.

**Storage rent.** Per-kg-per-day rent on all stockroom contents including reserved lots, with
auto-forfeit to the market owner on non-payment or after a bounded reservation window. Without it,
any player permanently fills a rival market's finite stockroom for the one-time cost of hauling
worthless bulk goods in and cancelling the lot — and "build a competing market three tiles away"
does not help, because the attacker squats that one too and cheap construction makes the attack
cheaper than the defence.

Goods in a stockroom are at risk: destroyed by the beam, lost if the settlement falls. Beam
destruction of a market tile moves escrow to a `('wreck', …)` container on the same tile with a
salvage window, rather than silently voiding every open order.

### 7.5 Freight, and the two-tier goods split

Freight is derived, not authored:

```
freight_per_unit = (caravan_upkeep_per_hour · 2 · distance / speed) · material_mass / capacity_mass
```

Anchors: 400 kg capacity, 20 tiles/hr, ~2.5 sol/hr upkeep → a mass-5 grain unit costs 0.31 sol per
100 tiles, ~31% of its base value. Bulk goods are structurally regional past ~250 tiles.

CI invariants, re-run whenever **vehicle design changes** (a 3× capacity hauler silently makes bulk
goods global and kills regional pricing without anyone touching an economy file):

```
freight_ratio(m, 100 tiles)  ∈ [0.25, 0.50]   for every form='bulk'
freight_ratio(m, 1000 tiles) <  0.05          for every form='fine'
```

Fine goods need a **distance-dependent** term, not just the mass-independent handling fee. A
per-touch handling charge is paid exactly twice on a direct haul whether the destination is 50 tiles
or 5,000 away, so it does not stop fine goods converging on one global price. Added: a transit
capital cost (`unit_value · daily_rate · transit_days`) plus a route-hazard premium, both growing
with distance, and a second stockroom limit in reference-value terms alongside the kg cap so
fine-goods hubs face a ceiling too.

**Haul contracts** are first-class (escrowed payout, carrier collateral, deadline). This is the
day-one job: a new player with two characters and one wagon has no capital and no territory, but has
time and a vehicle.

### 7.6 Money

One currency per world (`sol`). Currency **cannot cross worlds**; cross-world trade is barter and FX
is discovered through goods. Route tolls are denominated in **goods** — a percentage of manifest mass
surrendered at the origin — because a percentage toll settled in one world's sol and credited to a
route owner resident in another is a currency bridge, and the blast-radius argument for per-world
currency depends on there being none.

**The faucet is distributed civic demand**: every settlement continuously posts standing bids funded
by mint, scaled to its population, which is bounded by local food supply, which is bounded by
terrain. Because both the goods sink and the money source exist at every settlement in proportion to
population, every region has a permanent local price floor and there is no gravitational pull toward
one market.

Two corrections make it actually work:

1. **Civic bids are anchored to a locally computed marginal-cost index**, not to trailing local
   price, and civic fills are **excluded from the price EWMA**.

   > Anchoring to `local_reference_price · discount` with the discount clamped strictly below 1,
   > while civic demand *is* the marginal buyer on the frontier by design, means the EWMA converges
   > on its own discounted output: `p(t+1) = EWMA(p(t)·discount)`. Frontier prices decay
   > geometrically toward zero, the money faucet decays with them, and the mechanism produces
   > exactly the centralization it was built to prevent — selectively against new and remote
   > players, since established hubs with real player volume are unaffected.

2. **The controller targets a real quantity and actuates on quantity.**

   > `target_supply = 12 · trailing_30d_daily_trade_volume` denominated in sol is a positive
   > feedback loop with a self-referential target: raising the civic bid raises sol minted per unit
   > *and* the sol value of recorded volume, which raises the target, which the controller reads as
   > needing more supply. And the only lever for fighting inflation was lowering the civic bid —
   > i.e. cutting the frontier price floor, deliberately shocking the periphery the faucet exists to
   > protect. Fixed: target is denominated in trailing 30-day **units/mass** traded times a fixed
   > sol-per-unit constant; the actuator modulates civic bid **quantity** per settlement against
   > population while holding the price at the cost anchor. Bounded, slew-limited to ≤1%/day,
   > publicly auditable at `/economy/monetary`, and shadow-run against replayed logs and proven
   > contractive before it is allowed to move.

**Anti-wash-trading**, because the reference price is the base for civic bids, the tithe, and purse
purchases, and a market owner can set their own `sale_fee_bp` to 0:

- reference price is volume-weighted with a minimum-volume floor before it moves at all;
- trades where buyer and seller share a beneficial owner, or where either party owns the market, are
  excluded;
- the civic bid is capped at `min(local_ref, k · world_median_ref)`, k ≈ 2–3;
- reference movement is slew-limited per day, mirroring the controller.

Without these, the round-trip cost of a wash trade is the 1.5% tithe and the payoff is minted sol at
an administered price the attacker set — an uncapped money printer available to any account with two
characters and a warehouse, while every stated guardrail points at GMs.

**Sinks:** per-day upkeep on every station, building, vehicle and market; storage rent; a 1.5%
protocol tithe burned on every sale. Territory is a liability as well as an asset, so abandoned
infrastructure decays and the map does not fill with derelict optimal builds.

**Settlements are specified**, because the rate variable of the only faucet cannot be left implicit:

```sql
CREATE TABLE settlement (
  world_id SMALLINT NOT NULL, id UUID NOT NULL,
  tile_idx BIGINT NOT NULL, owner_account_id UUID,
  population NUMERIC(10,2) NOT NULL,
  food_stock_kg NUMERIC(14,2) NOT NULL,
  carrying_capacity NUMERIC(10,2) NOT NULL,     -- from biome, per tile
  last_resolved_step BIGINT NOT NULL,
  PRIMARY KEY (world_id, id)
) PARTITION BY HASH (world_id);
-- Population resolves lazily as a logistic step against food_stock_kg and carrying_capacity.
-- Daily mint per settlement is capped at population * per_capita_sol_cap, INDEPENDENT of price,
-- so "haul food in to raise the mint rate" tops out at a known ceiling.
```

Civic demand belongs to the **settlement**, not to a market, and is fillable at any market in that
settlement regardless of `access_policy` (or by direct delivery). Otherwise a market owner excludes
competitors and captures the world's primary faucet as private income — a worse abuse than the fee
gouging that `access_policy` was worried about, and one competition cannot fix because a rival market
three tiles away has no civic demand of its own.

---

## 8. Game Masters and monetization

### 8.1 GM powers are bounded inputs, not writes

Every design claimed structural prevention of GM economic inflation; every critique broke it. The
merged position:

| GM verb | How it was reachable | Bound now |
|---|---|---|
| `gm.terrain` | Terrain **is** the supply side. Flip regions to Rock → iron forever; bloom a region → the scarcest materials in the game. Logged at `economic_impact_sol = 0`. | Not a write. `INSERT INTO region_pressure (world_id, region_idx, kind, magnitude, announced_step, effective_step)`, consumed by `sim_writer`, `effective_step >= announced_step + 1 day`. It multiplies rule `pressure`, so the RNG still decides. Bounded magnitude budget in region-days per beam cycle. Cannot raise a region's extractive-biome share above its climate equilibrium. |
| `gm.npc` | Every account spawn carries a starting endowment (2 characters, vehicle, supplies) written by onboarding, not by `gm_writer` — so 1,000 NPCs consolidated into one settlement is pure goods creation. | Finite, public `endowment_pool` decremented by **every** account spawn, player or NPC, rendered in `/economy/endowment` and the GM log, refilled only by world rules the GM cannot call. `controller_account` is logged and rejected if it shares a payment instrument or entitlement account with the GM. |
| treasure cache | "Purchased from `event_purse` at reference price" materializes goods anywhere with zero freight — a freight teleporter with a price tag, and arbitrageable by pricing off a distant market. | The purse cannot materialize goods. It posts escrowed `haul_contract` or `standing_bid` rows that players fulfil physically, or sources from a real stockroom within N tiles hauled by an NPC account. |
| beam config | A GM cannot inflate but *could* starve: measured Grassland and Forest collapse under bad settings destroys the world's food and wood base. | Validated server-side against the `sweep.ts` viability window and the `beam_saturates` CHECK before acceptance. Beam schedule is fixed at world creation and immutable; **only `cause='beam'` re-stamps deposits**, so GM terrain pressure cannot mint geology. |
| `gm.route` | Assigning `route.owner_account_id` and `toll_bp` hands over a monopoly rent stream, logged at zero impact. | `economic_impact_sol` is computed and non-zero for route grants and territory-value transfers. Cosmic-law routes are not GM-revocable (`409 problems/cosmic-law-route`). |

`gm_writer` holds `INSERT` on `region_pressure`, `world_log`, `gm_action_log`, and the NPC spawn
function only. It has no `INSERT`/`UPDATE` on `item_stack`, `sol_ledger`, `market_lot`,
`region_terrain`, or `region_coarse`.

### 8.2 GM transparency without publishing a treasure map

`gm_action_log` is append-only and public, with **two tiers**: `action`, `at_step`,
`gm_account_id`, and computed `economic_impact_sol` publish immediately with location coarsened to
`province_id`; exact `params` publish after a delay exceeding the walking time to the location, or
after the event resolves. Publishing full params immediately turns the accountability log into a
treasure map — the transparency guardrail and the fog pillar collide, and neither may simply win.

**GM fog exemption:** none through `/v1`. Running a world plausibly requires seeing it, but a GM who
can play with x-ray is the single largest hole available. GMs read truth through a separate, heavily
logged console; those reads land in the public log like every other GM action.

`world_role(account_id, world_id, role, scopes[], granted_by, granted_at, revoked_at)` replaces a
scalar `gm_account_id`, so co-GMs, scope subsetting, succession, and audited transfer are all
expressible — Session 7 guardrail 4 requires worlds to survive GM departure, and a nullable UUID
cannot express a transfer, let alone audit one.

### 8.3 Monetization

Sold: **world hosting** (`world_host` entitlement — content generation, inflates nothing, the Session
7 revenue line), account-flag cosmetics, and operator-cost meters (storage retention, compute
quota).

**Not sold: `caravan_slots`, `roster_slots`, `standing_order_slots`, or any input to a budget cap or
regen rate.** Both the API and simulation designs sold entity count.

> Buying roster slots buys focus, i.e. actions per day — a throughput multiplier indistinguishable
> from the exponential progression the pillars forbid. Buying caravan slots buys parallel stamina
> *and* buys the one thing the design worked hardest to withhold: park a one-character caravan at
> 200 markets and you own a live global order book, purchased with money, defeating the entire
> "no cross-market query surface" decision. It also reopens the multi-accounting answer — per-entity
> budgets defuse alts only if entity count is not itself for sale.

Hence: `focus` is a **per-account pool with a fixed capacity** from which characters draw. More
characters buy breadth (skills, simultaneous presence), never rate. In-world capacity is an earned
entitlement from settlements and infrastructure.

Enforcement is at command validation, server-side. `GET /v1/me/entitlements` is a normal read so any
client can render the limit; a client that ignores entitlements simply gets a `409` with an
in-fiction problem type. With an open client ecosystem the official client can never be the paywall.

---

## 9. Cross-cutting mechanics

### 9.1 Idempotency

Every value-moving `POST` requires `Idempotency-Key`. Receipts are keyed
`(grant_id, idempotency_key)` with a hash of the canonicalised body, retained **7 days**, returning
`409 problems/idempotency-key-reused` on hash mismatch. A home server down for 26 hours then
replaying its queue must not re-execute every order, and two clients on one account must not collide.

### 9.2 Concurrency

Every lazy accumulator (`budget`, `account_balance`, station output, caravan stock) carries `version`
and is written with a CAS predicate, retried on zero rows. This is enforced structurally by column
grants: no application role may `UPDATE` these tables outside the `SECURITY DEFINER` function that
carries the predicate. Without it, N concurrent `POST /orders` each read `value=10`, each write `5`,
and you took N actions for the price of one — bypassing the anti-bot and multi-accounting defence
with the most obvious thing a bot does.

### 9.3 Caching

Responses report raw facts (`observed_at`, `(amount, updated_step, regen)`) rather than
server-computed derivatives (`staleness_days`, resolved budget values), so bodies are stable and
strong `ETag`s derived from `max(seq)` actually match. `If-None-Match` returns 304. This makes
"polling is structurally worthless" literally true rather than aspirational — it matters because
bandwidth, not CPU, is the scaling wall and the 429 lever has been deliberately given up.

### 9.4 Partitioning

Hash-partition into a fixed count (64) with `world_id` leading every index. Shard whole worlds across
physical databases when one outgrows a node. `PARTITION BY LIST (world_id)` was rejected: world
hosting is a sold entitlement, so world count is the growth axis, and past a few thousand LIST
partitions per table Postgres planning time on the hot `/view?since=` path is tens of milliseconds,
per-backend relcache grows into hundreds of MB, and autovacuum starves across 10k+ relations.

Sequences: one world-scoped `bigint` sequence, not per-observer. Per-observer sequences at
500 accounts × N worlds is a catastrophic count of sequence objects, and the counter-row alternative
serialises writes on exactly the path nominated as the storage optimization.

Sight-share **never duplicates rows** into a group observer id; only the scout's private row is
written and sharing is expressed in the RLS predicate via an active `sight_share` join — so
revocation is instant and leaving an alliance does not delete the map you drew.
`grant.redelegate_sight boolean DEFAULT false` gates whether a delegated token inherits alliance
intel: without it, "join alliance, authorize scraper" is a cheap, socially plausible fog bypass that
needs no alt accounts.

### 9.5 Ruleset migration

Worlds pin `ruleset_version`. Changing it is a scheduled, GM-visible event ("the sun's law changed")
that also bumps `ruleset_epoch`, re-randomizing the roll stream. Ruleset changes are migrations, not
deploys: the ruleset is a live world's physics, and silently shipping a tuned `medianDays`
retroactively invalidates every player's mental model of their region and breaks replay.

### 9.6 CI gates (all blocking)

```
1.  DDL executes against a scratch Postgres. Every table has PK (world_id, id).
2.  has_table_privilege assertions for api_reader / api_writer / gm_writer (§5.2).
3.  Every `private` operation's handler routes through withActor().
4.  No schema reachable from a cosmic/public response references a truth-plane type or the sim seed.
5.  No code path reachable from a `private` operation touches the truth-plane pathfinder.
6.  Channel union members map 1:1 onto vis_kind values.
7.  Every EventType in code appears in asyncapi.yaml and vice versa.
8.  Differential client test: identical request sequence under an `official=true` client_id and a
    plain one yields byte-identical responses and identical stream event sequences.
9.  tsc --noEmit (the repo has no TypeScript devDependency today; Node strips types unchecked).
10. sl-lab verify --seed X --days 1000 --expect-hash Y   (golden-world regression)
11. sl-lab lod-agreement: per-region KL divergence AND per-rule activation-count agreement
    between tile-tier and coarse-tier runs; plus patch-size distribution and two-point
    correlation of biome identity at lags 1–8, aggregated over ≥300 regions spanning the
    climate space. (A chi-square over one 16×16 region's 12 bins has no statistical power:
    ~21 expected per bin, and biomes are strongly spatially autocorrelated by construction,
    so effective sample size is the number of contiguous patches — maybe 5–20. Such a test
    creates confidence without evidence, which is worse than no test.)
12. Biome transition graph is a single strongly connected component (Tarjan); report eccentricity.
13. Freight ratio invariants (§7.5), re-run on vehicle-design changes.
14. Budget additivity property test: resolve(t2) == resolve(resolve(t1), t2).
15. Mask property test: every byte outside seen_mask is 0xFF in row and on the wire.
16. Ledger reconciliation: SUM(goods_ledger) == holdings; SUM(sol_ledger) == balances, per world.
17. oasdiff: a breaking spec change without a new dated revision fails.
```

---

## 10. Decisions and tradeoffs

Conflicts between subsystem designs, resolved.

**10.1 Coarse tier: mean-field proportion vector vs. real CA at reduced resolution.**
Winner: real CA at 8×8 tiles per cell (819,200 cells, 6.5 MB, 9.5 evals/sec/world).
The proportion vector was measured to predict thousands of rule firings where reality has zero,
because every land/water rule is a threshold on a bimodal neighbour count. *Given up:* the
persistence design's beautiful property that a virgin world is one row and a seed. Regions now
always have a small row (51,200 per world, ~6.5 MB) — but tiles, the 1000× cost, remain lazy.
The pillar's substance survives; its purest form does not.

**10.2 Region size: 16 vs. 32 vs. 64 tiles.** Winner: 32×32. It makes the storage row, the wire
chunk (exactly 4 KB as an RGBA8 texture), the materialization unit, and the sweep band the same
object, and nests cleanly over 8×8 coarse/vision cells. *Given up:* 16×16 would have bounded the
vision over-approximation tighter; 64×64 would have halved row count. 32 also keeps the region row
under TOAST pressure once split into hot/static/coarse tables.

**10.3 Fog enforcement: storage shape vs. DB grant vs. visibility tag.** Winner: all three, layered,
with the grant as the backstop. Each alone had a demonstrated bypass — the grant model could not
express a market write, the storage model leaked at the halo, the tag model had two untagged
channels. *Given up:* conceptual minimalism; there are now three places to reason about, and §9.6
gates 2, 3, 5, 6 exist to keep them consistent.

**10.4 Halo tiles: synthesize vs. serve coarse.** Winner: serve coarse, explicitly labelled.
*Given up:* a seamless-looking frontier. Players see 8×8 blocks past the edge of materialized
ground. This is honest — the fine detail did not exist — and it is the only way materialization
cannot contradict something a player already watched.

**10.5 Market clearing: continuous vs. call auction.** Winner: call auction, owner-configurable
above a floor. *Given up:* immediacy. A trader who arrives 30 seconds after a clear waits. That is
the cost of removing every latency advantage a bot has over a human, which is the same fairness
argument the whole rate-limit pillar rests on.

**10.6 Observation storage: per-observer rows vs. per-account blob vs. shared snapshot + pointer.**
Winner: shared snapshot + 24-byte pointer + per-account mask. *Given up:* the ability to store
genuinely per-observer detail grading in the same table; detail grade now lives on the snapshot
(`coarse` vs `tiles`) and finer grading (surveyed yields) lives in separate `deposit_knowledge` rows.

**10.7 Money: ledger balance vs. physical freight.** Winner: per-world ledger balance; friction is on
goods, not money. *Given up:* the persistence critique's argument that a remote buyer with a ledger
balance can outbid every local. Mitigated by requiring physical presence on **both** sides of a fill
and by standing bids escrowing at post time, so the only remote action is committing money to a
place, and the goods still have to arrive. Rejected the alternative (money as an `item_stack` with
mass) because it makes onboarding brutal, makes every market a robbery target, and adds a second
freight problem to solve.

**10.8 Deposits: `depositAt(seed, tile, biome)` pure function vs. permanent geology + provinces.**
Winner: permanent geology. The pure function ties material existence to current biome, so biome
extinction deletes materials; the measured extinction of four biomes would have removed 12 of 36
materials. *Given up:* zero-storage deposits. `deposit` rows are created on discovery and pinned
until exhausted.

**10.9 Rate limits: per-account vs. per-entity budgets.** Winner: split — `focus` per account
(capped, so alts and paid roster slots buy no throughput), `stamina` per caravan and `charge` per
vehicle (so in-world investment is the way to scale). *Given up:* the clean "everything per entity"
answer to multi-accounting; land grab by alts remains unaddressed here and is a world-join policy
problem (§11.5).

**10.10 Replay: regenerate from seed vs. keyframes.** Winner: keyframes.
Both the realtime and persistence designs claimed terrain is regenerable from
`(seed, beam schedule, GM log)`. It is not: `rollAt` supplies the dice but the *threshold* comes from
`medianToProbability(medianDays / when(ctx))`, and `ctx` carries moisture (a stateful diffusion
filter over six neighbours) and neighbour biome counts. Terrain at step T requires replaying the
whole world from step 0 — ~55 billion tile evaluations before the first frame of a
`from=1,500,000` request. Materialization and dematerialization are additionally triggered by player
movement, which no log captured, so tile state feeds back into the coarse field and terrain history
becomes a function of the complete player action log. **Fix:** `region_snapshot` doubles as the
keyframe store; `/replay` seeks to the nearest keyframe and rolls forward using `terrain.swept` rows,
and serves the **public projection only**, uniformly for every token. *Given up:* per-account
historical replay beyond the 30-minute reconnect window, and the claim that the intervention log is
non-omittable because it is the replay input.

---

## 11. Accepted risks

Issues raised by the critiques that are **not** fixed here, with rationale.

**11.1 Materialization fidelity is still the highest-risk function in the system.** Constrained
upsampling with a pinned boundary and 3 CA relaxation passes should produce coherent geography, but
"should" is doing real work. If freshly materialized ground reads as visibly procedural next to
CA-evolved ground, that is worse than any storage cost. Gate: §9.6 item 11 must pass before any of
§4.3 ships. Fallback: raise the coarse tier to 4×4 tiles per cell (4× cost, still ~38 evals/sec).

**11.2 The beam-vs-survival numbers are unverified.** The economy design's "Grassland 31.5% → 4.1%
under a 90-day beam" does not reproduce: the `--beam-period` flag has never been wired (§4.6), so
that comparison was a beam run against a no-beam run. Re-measurement gives Grassland 21.4% → 17.3%
and Forest 6.5% → 10.0%. **The beam viability validator is still built**, because the underlying
concern is real (test 2 does fail at 1200 days with the beam: 0 generic, 5 thin), but it must be
calibrated against re-derived numbers, not the phantom ones. Until then it warns rather than rejects.

**11.3 Materialized area grows monotonically in a mature world.** Dematerialization refuses on
pins, and worked ground acquires pins. A mature world converges toward fully materialized: 410 MB of
tile blobs and 600 evals/sec. Accepted, because `content_hash` skipping makes the *sweep write* cost
proportional to actual churn (~1%/day ≈ 500 region writes/day) rather than to materialized area.
Storage is bounded and cheap; the WAL disaster is the part that is fixed.

**11.4 Broadcast and the Chronicle can be weaponized as a collective fog bypass.** A thousand
alt-spectators publishing everything they see reconstructs a public world map; a third-party site
aggregates it. This is arguably legitimate emergent play (intel networks), and levers exist if it
goes wrong (focus cost per publication, publishing only degraded observations, delay scaling with
how much vision the broadcaster has). Not pre-emptively restricted, because guessing wrong here
kills the spectator experience that makes bot-run worlds watchable.

**11.5 Multi-accounting is unaddressed for land grab.** Per-entity budgets defuse alts for
throughput; fifty accounts still claim fifty starting caravans and fifty spawn regions. This is a
world-join policy and entitlement problem, not an API one, and it needs a GM-configurable answer per
world.

**11.6 Cross-world rift transactions are unsolved.** A rift transfer spans two worlds owned by two
different single-writer processes. A two-phase commit reintroduces exactly the distributed
coordination the design avoids everywhere else, and goods duplicated or destroyed at a rift boundary
is an economy-ending bug. The proposal to evaluate is a shared `cosmos.transit` table holding goods
in a limbo owned by neither world, converting one distributed transaction into two local ones with
escrow between — but the limbo state is visible and someone will find a way to strand goods in it.
**Nothing depends on rifts until phase 6 of the build sequence.**

**11.7 Blob terrain forecloses SQL predicates on biome.** "Find all glass tiles in the world" is a
full blob decode. Any feature needing it (a global commodity heatmap for spectators — which is also
a fog question) requires a derived index table maintained by the sweep. Decide before the first such
feature, not after.

**11.8 `world_id SMALLINT` caps the multiverse at 32,767 worlds.** Accepted; it is a wide-reaching
migration if ever hit, since every composite key changes.

**11.9 Terrain determinism still depends on fixed-point discipline holding everywhere.**
Quantizing the acceptance test and moving moisture to u16 fixed-point removes the two known float
paths into rule thresholds, but heat is still computed in float (`latitudeHeat` uses `Math.cos`).
Either pin the worldsim build or move heat to fixed-point too; the second is correct and is deferred
to the first replay-divergence report.

**11.10 The revision back-render shim is a permanent tax and a permanent bug surface**, and it is
where a fog leak will eventually hide (an old shape including a field later removed for visibility
reasons). Rule: a revision transform may only remove or rename fields, never re-add a field a later
revision removed for a security reason — and `min_revision` clamping (§5.6) is the enforcement.

**11.11 Class-substituted recipes are a real cognitive and UI burden**, and they make naive bots
much worse than good ones. Accepted as depth; `plan_supply()` exists specifically so an LLM agent
and a human can both get a straight answer.

---

## 12. Open questions

1. **How far ahead of a caravan do we materialize?** Vision radius (3 tiles) is the minimum;
   pre-fetching 8 removes arrival latency but multiplies materialized area ~7× and widens the
   latency side channel. Needs a measured answer once movement speeds are fixed. Materialization is
   *predictive* (scheduled at route time, executed in the worldsim's idle time), and
   `region.materialized` must be an internal event with no player-visible topic — otherwise it leaks
   rival caravan movement hours ahead of arrival.
2. **Vision granularity.** 8×8 cells mean touching one corner of a region can reveal up to 8 tiles
   beyond true sight at cell boundaries, and the memory blob is masked per tile but the *interval*
   is per cell. Is that acceptable flavour ("a glimpse at the edge of vision") or does it need 4×4?
   Direct cost consequence on `observation_interval` volume.
3. **What counts as "observing"?** (Session 3 OQ1, still open.) A caravan present is clear. Owning a
   settlement in the region? A watchtower with a radius? Any account or per-account? This sets
   `observation_interval` semantics, how many regions stay materialized, and the demat window — it
   has direct scaling consequences and cannot stay open past phase 3.
4. **Does an old observation degrade?** Currently permanent-but-stale, which makes cartography
   tradeable — but one lucky early circumnavigation gives a bot a permanent world map of biome
   classes. Given measured churn (~1%/day), how long until a remembered map is worthless? Cheap
   answer available from the existing simulator; needed before beta.
5. **Terminal-beam world endings.** After the single crossing, does the world stay live so the bloom
   cycle runs behind it (making "terminal" a slow rotating beam), or enter `status='ashen'` and stop
   accepting spawns? The latter is the campaign framing but needs a defined duration and archive
   path. Retention is cheap (~10 MB terrain + ledger rollups) and is probably a product feature.
6. **Depletion rate calibration.** Too fast and territory is worthless; too slow and the first-mover
   monopoly the terrain sim exists to break survives anyway. Interacts directly with beam cycle
   (which re-stamps), so the two must be tuned together. Add an `assessDepletion()` pass to `sl-lab`.
7. **Sweep step legibility.** 320 steps/day means the gaze advances 1/320th of the world every 4.5
   minutes — a discrete jump, not a moving line. Client-side interpolation of gaze position costs
   nothing and probably answers this, but confirm before the band width is baked into the region
   grid (sub-dividing the write unit would 4× the WAL on the acknowledged bottleneck).
8. **Do characters/caravans live in core or the world shard?** Core makes inter-world travel a single
   `UPDATE`. But if a GM ever exports or self-hosts their world, its population must travel with it.
   Cheap now, brutal later.
9. **Bootstrap.** Does a new world start with sol in circulation, or barter its way to a money
   supply? `seed_reference_price` (from recipe depth and mass) seeds civic demand and decays out over
   30 days as the EWMA takes over — but the very first trades have no reference at all.
10. **Are province mineral suites visible to the GM before players survey them?** Yes gives GMs real
    narrative planning power and a favouritism vector; no makes regional storylines impossible.
11. **Do cycles beyond the beam (seasons, quakes, volcanism) ship in v1?** Session 8 makes the beam
    one example of a general world-cycle system, and SIMULATION.md shows a world with no disturbance
    freezes. The architecture supports N cycles (each is a `pressure` source over the sweep), but
    only the beam is specified here.
12. **Anti-abuse for open OAuth client registration.** Open registration is required for a real
    ecosystem; a malicious client named "Sunborn Legacy Official" harvesting grants is the standard
    phishing attack. Probably a verified-publisher tier plus a scary consent screen for unverified
    clients — but that is UX work with real ecosystem-chilling potential.
13. **What is `entered_step` for?** 4 bytes per tile (200 MB on a fully materialized world) is dead
    weight under today's memoryless `medianToProbability` hazards. BRAINSTORM Session 3 explicitly
    wants Weibull/log-normal hazards, which need it, and it cannot be backfilled. Kept on that basis
    — confirm non-geometric hazards are actually wanted before phase 2 locks the byte layout, and if
    so, whether the coarse tier needs a per-biome age distribution rather than a single age.

---

## 13. Build sequence

Dependency-ordered. Each step states what it proves or de-risks, and nothing later starts until its
predecessor's gate is green.

### Phase 0 — Make the prototype trustworthy (days)
Add `typescript` + `tsc --noEmit` to CI. Fix `run.ts` flags (`--beam-transit`, `--beam-cycle`) and
`package.json`'s dead `--sweeps`. Give every rule a stable string id and switch `rollAt` to
`ruleKey`. Move moisture to u16 fixed-point. Add `acceptsU32`. Add the golden-world hash test and the
SCC/eccentricity check.
**Proves:** that any number produced by the simulator can be trusted, and that a ruleset edit no
longer silently re-keys history. *Every subsequent phase's calibration depends on this and only this
phase can find that a measurement was a phantom.*

### Phase 1 — `packages/sim-core` + `sl-lab`, and the LOD gate (1–2 weeks)
Extract `worldgenAt(seed, col, row)` as a pure function (no whole-grid allocation), add the
`tectonic` channel, apply the §4.6 ruleset repairs, implement the 8×8 coarse CA and double-buffered
band sweep. Build `sl-lab lod-agreement` with per-rule activation counts, patch-size distribution,
and two-point correlation.
**Proves or kills the entire storage model.** If the coarse tier does not agree with the tile tier on
rule activation and spatial statistics, everything downstream — lazy materialization, the beam
forecast, `world_metric`, the supply model — is built on fiction. This is the one gate that can
invalidate the architecture, so it comes before any database.

### Phase 2 — Persistence skeleton and the fog seam (2 weeks)
Execute the §3 DDL against a real Postgres in CI. Create the four roles and land §9.6 gates 1–2.
Implement `materializeRegion`, `dematerializeRegion`, `region_snapshot` dedup, `applyMask`, and the
`stepAt` clock with `world_time_skip`.
**Proves:** the DDL is executable (the persistence design's was not), that `(world_id, id)` keys hold
throughout, that fog of war is a grant rather than a convention, and that world time is monotone
across an outage.

### Phase 3 — `sl-worldsim`: leases, sweep, event queue (2–3 weeks)
Fencing token, cooperative scheduler, per-region catch-up sweep with `content_hash` skipping, event
queue with `SKIP LOCKED`, `world_metric` per revolution, `region_pressure` consumption.
Measure WAL with `pg_stat_wal` on realistic blobs.
**Proves:** one world runs unattended for a week without a human, survives a crash mid-step
bit-identically, and generates WAL in the megabytes-per-day range rather than the gigabytes the
naive blob write would have. **De-risks the single biggest operational unknown.**

### Phase 4 — `sl-auth` + `sl-api` read plane (2–3 weeks)
OAuth 2.1 AS with all three profiles, `aud`, refresh rotation, step-up for `account.manage`, grants
with object narrowing and `redelegate_sight`. RLS policies keyed on `app.grant_id`.
`/clock`, `/beam/forecast`, `/regions`, `/view`, `/sync`, `/me`. OpenAPI as source of truth; generate
`@sunborn/types`. Land §9.6 gates 3–5 and 8.
**Proves:** a third-party client can be a complete replacement for the official one, and that no read
path can serve unwitnessed ground even when a handler is written carelessly. **Auth first, because
retrofitting delegated auth is brutal and any window of credential sharing is unrecoverable.**

### Phase 5 — Movement, budgets, and the write plane (2 weeks)
`caravan_leg` segmentation with boundary re-validation, `sated_until_step` and `caravan_starve`
events, CAS budgets with the analytic gaze integral, `SECURITY DEFINER` write functions,
`Idempotency-Key` receipts, dry-run quoting from memory only. Land §9.6 gates 14 and 5.
**Proves:** the "no tick for movement" claim survives contact with a world that changes underneath a
route, that budgets cannot be farmed by read timing or by concurrency, and that route quotes are not
a terrain oracle. **This is the first playable loop.**

### Phase 6 — Realtime (1–2 weeks)
`world_log` with visibility tags, `filterObservable`, Redis Stream fanout, WS/SSE/long-poll,
`observation_interval` with partition-drop retention, cursor replay, `@sunborn/sdk` with the chaos
toggle. Land §9.6 gates 6–7.
**Proves:** reconnect replay is exactly the set of events the account could observe at the time —
the single most likely place a fog leak ships, and the reason it gets a dedicated property test
(random observer trajectories, random cursors, assert exact set equality).

### Phase 7 — Economy (3–4 weeks)
Materials catalogue with province suites and the worldgen constraint solver; deposits with the
epoch-integral yield; containers, stacks, `goods_ledger` with reconciliation; settlements with
logistic population; markets with call auctions, storage rent, and observation-gated boards; the
monetary controller **shadow-running only**; haul contracts. Land §9.6 gates 13 and 16.
**Proves:** "every start is a niche" is a worldgen invariant rather than a hope, that the money
supply is provable, and — via the shadow run — that the controller is contractive before it is ever
allowed to move a price.

### Phase 8 — GM, monetization, MCP (2–3 weeks)
`world_role`, `region_pressure` with telegraphed effect and a magnitude budget, `endowment_pool`,
two-tier `gm_action_log`, beam viability validator, entitlements, generated MCP server.
**Proves:** a GM can make a world interesting without being able to inflate or starve it, and that
the MCP surface holds no authority the same token lacks.

### Phase 9 — Multiverse (open-ended)
Cosmic-law route graph, `cosmos.transit` limbo, mass-capped transits, barter FX.
**Blocked on §11.6.** Deliberately last: nothing before it depends on rifts, and getting goods
duplication wrong at a rift boundary ends an economy.

---

*Terrain findings: [SIMULATION.md](./SIMULATION.md) · Design foundation:
[BRAINSTORM.md](./BRAINSTORM.md) · Product framing: [PITCH.md](./PITCH.md)*
