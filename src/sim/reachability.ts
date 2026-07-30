/**
 * WHICH BIOMES A WORLD CAN EVER HAVE — the transition graph restricted to the flags a
 * given cycle set can actually raise.
 *
 * This is the analysis `invariants.ts` prints as "reachable core per cycle preset", and
 * it is the single most useful description of a cycle set that exists, because it is
 * MEASURED rather than asserted: with no tectonics nothing raises Uplift, so no rule
 * into `mountain` can ever fire, so a world without tectonics does not have mountains —
 * or granite, or silver, or skyquartz. That is the GM's dial expressed as connectivity.
 *
 * It lives here rather than in `invariants.ts` for one blunt reason: that file is a
 * SCRIPT. It runs eight checks and calls `process.exit` at module scope, so importing a
 * function from it would run a 70-second test suite and then kill the importer. The
 * functions below are pure (R-007: no I/O in `src/sim`), which is what lets both the
 * invariant checker and the viewer ask the same question and get the same answer from
 * the same code.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS ANALYSIS DOES AND DOES NOT CLAIM
 * ---------------------------------------------------------------------------
 * It is KIND-LEVEL, not parameter-level. A cycle's flag vocabulary comes from its
 * catalogue entry — the flags that kind is capable of raising — so `seasons` counts as
 * a source of Freeze even if its heat amplitude is set to 0, and a monsoon with
 * `moisture: 0` still counts as a source of Storm. Restricting to the flags a
 * PARTICULAR parameterisation can raise would need a second model of every cycle's
 * geometry, and this repo has already been bitten twice by a second implementation of
 * the beam's geometry drifting from the first.
 *
 * So the honest reading is: **"unreachable" is a hard fact, "reachable" is a
 * possibility.** A biome reported unreachable genuinely cannot occur — no cycle in the
 * set raises any flag any rule into it needs. A biome reported reachable is reachable
 * given flags the set can raise; whether the parameters chosen actually raise them
 * often enough to matter is what `npm run sim` measures. Anything stronger would be a
 * half-correct reachability claim, which is worse than none because it would be
 * believed.
 */

import {
  BIOME_COUNT, BIOMES, Biome, RULES, type Rule, type TileContext,
} from './biomes.ts';
import { CYCLE_FLAG_NAMES, CycleFlag, cycleCatalogueEntry } from './cycles.ts';

// ---------------------------------------------------------------------------
// The graph
// ---------------------------------------------------------------------------

/** Adjacency as sets of target biomes, optionally restricted to a live rule subset. */
export function buildAdjacency(rules: readonly Rule[]): Set<Biome>[] {
  const adj: Set<Biome>[] = Array.from({ length: BIOME_COUNT }, () => new Set<Biome>());
  for (const r of rules) if (r.from !== r.to) adj[r.from]!.add(r.to);
  return adj;
}

/**
 * Tarjan's strongly connected components, iterative.
 *
 * Recursive Tarjan is shorter, but this runs inside a check that is supposed to be
 * unconditionally safe to call on any ruleset, including a pathological one, and an
 * invariant checker that can stack-overflow is not an invariant checker.
 */
export function tarjan(adj: readonly Set<Biome>[]): Biome[][] {
  const n = adj.length;
  const index = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const onStack = new Uint8Array(n);
  const stack: number[] = [];
  const out: Biome[][] = [];
  let counter = 0;

  for (let root = 0; root < n; root++) {
    if (index[root] !== -1) continue;
    // frame = [node, iterator position over its successors]
    const work: [number, number][] = [[root, 0]];
    const succ: Biome[][] = [];
    succ[root] = [...adj[root]!];
    index[root] = low[root] = counter++;
    stack.push(root);
    onStack[root] = 1;

    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const v = frame[0];
      const kids = succ[v]!;

      if (frame[1] < kids.length) {
        const w = kids[frame[1]!]!;
        frame[1]++;
        if (index[w] === -1) {
          index[w] = low[w] = counter++;
          stack.push(w);
          onStack[w] = 1;
          succ[w] = [...adj[w]!];
          work.push([w, 0]);
        } else if (onStack[w]) {
          if (index[w]! < low[v]!) low[v] = index[w]!;
        }
        continue;
      }

      work.pop();
      if (work.length > 0) {
        const parent = work[work.length - 1]![0];
        if (low[v]! < low[parent]!) low[parent] = low[v]!;
      }
      if (low[v] === index[v]) {
        const comp: Biome[] = [];
        for (;;) {
          const w = stack.pop()!;
          onStack[w] = 0;
          comp.push(w as Biome);
          if (w === v) break;
        }
        out.push(comp);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Satisfiability: can this rule ever fire at all?
// ---------------------------------------------------------------------------

/**
 * Flag combinations worth probing.
 *
 * Not the full power set — the ruleset only ever tests a handful of combinations, and
 * the ones that matter are the ones a real cycle can produce together. Focus never
 * appears without Beam or Eruption, and Uplift never appears without Quake, because
 * that is how cycles.ts raises them.
 *
 * ★ THE SAME IS TRUE OF THE SIX WEATHER FLAGS AND IT IS WHY THEY APPEAR IN PAIRS. A
 * storm has ONE type per day, and a heavy type always raises its light partner — a
 * downpour is `Rain | HeavyRain | Storm`, never `HeavyRain` alone. Probing the bare
 * heavy bit would be probing a state the simulation cannot produce, which is the same
 * class of error as a rule gated on a flag no cycle raises: it would report an edge as
 * live that nothing can ever fire.
 */
export const FLAG_COMBOS: readonly number[] = [
  0,
  CycleFlag.Beam,
  CycleFlag.Beam | CycleFlag.Focus,
  CycleFlag.Quake,
  CycleFlag.Quake | CycleFlag.Uplift,
  CycleFlag.Eruption | CycleFlag.Focus,
  CycleFlag.Ashfall,
  CycleFlag.Ashfall | CycleFlag.Eruption,
  CycleFlag.Storm,
  CycleFlag.Heatwave,
  CycleFlag.Heatwave | CycleFlag.Drought,
  CycleFlag.Freeze,
  CycleFlag.Drought,
  CycleFlag.Beam | CycleFlag.Focus | CycleFlag.Quake,
  // Weather: one type per storm-day, heavy always carrying its light partner.
  CycleFlag.Rain,
  CycleFlag.Rain | CycleFlag.HeavyRain | CycleFlag.Storm,
  CycleFlag.Cloud,
  CycleFlag.Cloud | CycleFlag.HeavyCloud,
  CycleFlag.Wind,
  CycleFlag.Wind | CycleFlag.HeavyWind,
  // Weather composes with the calendar, and the drying ladder is where they meet: a
  // gale during a drought is the driest thing the world produces, and cloud during a
  // heatwave is the mildest.
  CycleFlag.Wind | CycleFlag.HeavyWind | CycleFlag.Drought,
  CycleFlag.Cloud | CycleFlag.HeavyCloud | CycleFlag.Heatwave,
];

const HEATS: number[] = [];
for (let h = -20; h <= 200; h += 5) HEATS.push(h);
const MOISTS: number[] = [];
for (let m = 0; m <= 100; m += 5) MOISTS.push(m);

const scratchCounts = new Int32Array(BIOME_COUNT);

/**
 * A river ring mask that is ACHIEVABLE on the grid and maximally spread, indexed by how
 * many river neighbours the probe placed.
 *
 * ★ WHY NOT SWEEP ALL 64 MASKS. `satisfiable` already costs
 * (unsatisfiable rules × flag combos × 23×23 neighbour pairs × 7 water counts × 45 heats ×
 * 21 moistures), which is 30 s on a restricted world; another factor of 64 would make the
 * viewer's reachability endpoint useless and `sim:check` unrunnable.
 *
 * ★ WHY A SINGLE MASK PER COUNT IS STILL SOUND. This function's job is to answer "can this
 * rule EVER fire", so it only has to be able to reach a witness, and it must never
 * manufacture one that the grid cannot produce. Every mask below is a real neighbourhood —
 * n river tiles placed as far apart as the ring allows — so a `true` here is honest. The
 * spread choice is the one that reaches the admitting side of `CHANNEL_OK`; a clustered
 * choice would report `the channel extends` as UNSATISFIABLE, which is a loud false alarm
 * rather than a silent false pass. Note 4+ has no spread option at all: the largest
 * independent set on a 6-cycle is 3, so those masks are genuinely adjacent-containing.
 */
const SPREAD_RING: readonly number[] = [
  0b000000, // 0 — no river neighbours
  0b000001, // 1 — a tip
  0b000101, // 2 — 120° apart: a hole in a channel
  0b010101, // 3 — a three-way confluence hole
  0b010111, // 4+ — cannot avoid an adjacent pair; refused, correctly
  0b011111,
  0b111111,
];

function makeContext(
  biome: Biome,
  heat: number,
  moisture: number,
  waterNeighbours: number,
  probeA: Biome,
  probeB: Biome,
  flags: number,
): TileContext {
  scratchCounts.fill(0);
  // Water neighbours are modelled as ocean, which is the common case; frozen sea and
  // shallows differ only in which counts bucket they land in and both are covered by
  // sweeping probeA/probeB over every biome.
  scratchCounts[Biome.Ocean] = waterNeighbours;
  const land = 6 - waterNeighbours;
  const a = Math.ceil(land / 2);
  scratchCounts[probeA]! += a;
  scratchCounts[probeB]! += land - a;
  // ★ EVERY `TileContext` FIELD MUST BE FILLED HERE. The probe runs against a context this
  // function builds by hand rather than against `World.buildContext`, so a field added to
  // the interface and forgotten here does not fail to compile into anything visible — it
  // silently probes a malformed world, and every rule that reads it is mis-reported.
  // River neighbours are all treated as upstream, which is the permissive case and is
  // achievable (a spring on a ridge above every one of them).
  const riverNeighbours = scratchCounts[Biome.River]!;
  return {
    biome,
    heat,
    moisture,
    waterNeighbours,
    neighbourCounts: scratchCounts,
    riverRing: SPREAD_RING[Math.min(riverNeighbours, 6)]!,
    upstreamRiverNeighbours: riverNeighbours,
    // A tile with somewhere for water to go in every direction — a peak, which is
    // achievable and is the permissive case for the two nucleation gates.
    downhillNeighbours: 6,
    flags,
    underBeam: (flags & CycleFlag.Beam) !== 0,
  };
}

/**
 * Does `rule.when` ever return a positive pressure, anywhere in climate x neighbour x
 * flag space? A rule that never can is dead code, and dead code in the ruleset is
 * usually a typo'd threshold rather than an unused feature — an edge the graph is
 * counting on that will never actually fire.
 *
 * `allowedFlags` restricts the probe to what a given world can produce, which is how
 * the reachable core below is computed.
 */
export function satisfiable(rule: Rule, allowedFlags = -1): boolean {
  const combos = FLAG_COMBOS.filter((f) => (f & ~allowedFlags) === 0);
  // Single-composition pass first: it covers every rule in the current set and is
  // ~22x cheaper. Only rules that fail it pay for the pairwise sweep.
  for (const probe of BIOMES) {
    for (const flags of combos) {
      for (let w = 0; w <= 6; w++) {
        for (const heat of HEATS) {
          for (const moisture of MOISTS) {
            const c = makeContext(rule.from, heat, moisture, w, probe.id, probe.id, flags);
            if (rule.when(c) > 0) return true;
          }
        }
      }
    }
  }
  for (const pa of BIOMES) {
    for (const pb of BIOMES) {
      if (pa.id === pb.id) continue;
      for (const flags of combos) {
        for (let w = 0; w <= 6; w++) {
          for (const heat of HEATS) {
            for (const moisture of MOISTS) {
              const c = makeContext(rule.from, heat, moisture, w, pa.id, pb.id, flags);
              if (rule.when(c) > 0) return true;
            }
          }
        }
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Flag vocabulary of a cycle set
// ---------------------------------------------------------------------------

const FLAG_BIT: ReadonlyMap<string, number> = new Map(CYCLE_FLAG_NAMES.map(([bit, n]) => [n, bit]));

/** Bitmask for a list of flag names. Unknown names contribute nothing. */
export function flagMask(names: Iterable<string>): number {
  let mask = 0;
  for (const n of names) mask |= FLAG_BIT.get(n) ?? 0;
  return mask;
}

/**
 * Every flag the given cycle KINDS can raise between them.
 *
 * Takes kinds rather than built cycles deliberately: the question "what can this world
 * ever contain" must be answerable in a configuration UI, before any world exists.
 */
export function flagMaskForKinds(kinds: Iterable<string>): number {
  let mask = 0;
  for (const kind of kinds) mask |= flagMask(cycleCatalogueEntry(kind).flags);
  return mask;
}

// ---------------------------------------------------------------------------
// The reachable core
// ---------------------------------------------------------------------------

/**
 * A biome that cannot take part in the world's terrain cycle, and WHY — which is three
 * genuinely different statements that must not be conflated:
 *
 *   inEdges 0   nothing in this world can create it. (A world can still be SEEDED with
 *               some at day 0 by worldgen; when they are gone they do not come back.)
 *   outEdges 0  it can appear and then never change again — a one-way sink.
 *   neither     it sits in a smaller closed loop of its own, reachable from nowhere in
 *               the main cycle or unable to return to it.
 */
export interface OutsideCore {
  readonly biome: Biome;
  /** `BIOMES[biome].key`, so a consumer needs no second lookup table. */
  readonly key: string;
  /** Live rules that can turn something else INTO this biome. */
  readonly inEdges: number;
  /** Live rules that can turn this biome into something else. */
  readonly outEdges: number;
}

export interface ReachableCore {
  /** The flag vocabulary this was computed for. */
  readonly allowedFlags: number;
  readonly allowedFlagNames: readonly string[];
  /** Distinct biome→biome edges whose rule can fire under `allowedFlags`. */
  readonly liveEdges: number;
  /** Strongly connected components of the restricted graph. */
  readonly componentCount: number;
  /** Biome ids in the largest strongly connected component. */
  readonly core: readonly Biome[];
  /** Biomes OUTSIDE that component — the world's missing chemistry, with the reason. */
  readonly outside: readonly OutsideCore[];
}

const CORE_CACHE = new Map<number, ReachableCore>();

/** A previously computed core, or undefined. Free; never starts a computation. */
export function cachedReachableCore(allowedFlags: number): ReachableCore | undefined {
  return CORE_CACHE.get(allowedFlags);
}

/**
 * The transition graph restricted to rules that can fire under `allowedFlags`, reduced
 * to its largest strongly connected component — as a generator that yields after every
 * rule it tests.
 *
 * The yielding is not decoration. MEASURED on this ruleset — 185 rules, six cycle kinds,
 * whose flags between them are mask 65535 — the sweep costs:
 *
 *                                            wall   unsatisfiable   flag combos admitted
 *     all six kinds (mask 65535)             1.1 s        0                22
 *     no cycles at all (mask 0)              5.9 s       69                 1
 *     seasons + monsoon + tectonics (972)   34.9 s       51                 8
 *
 * ★ THE CONFIGURATION IS THE RULESET, NOT A WORLD. No grid is built and no world size
 * enters; the only input is the flag mask. The seconds are wall clock from one run on one
 * machine (Node 24) and are a guide to the ORDER of magnitude and to the ratio between the
 * rows — the ratio is the durable part, the absolute seconds are not something to regress
 * against.
 *
 * The cost is (unsatisfiable rules × admitted flag combinations), because a rule that
 * CAN fire exits on its first probe while a rule that cannot must exhaust
 * 23×23 neighbour pairs × 7 water counts × 45 heats × 21 moistures for every admitted
 * combination. A restricted world is therefore the expensive case, and a 35-second
 * synchronous call would freeze the viewer's event loop completely. Callers that must
 * stay responsive drive this generator and yield to their event loop between rules;
 * `reachableCore` below is the blocking convenience form, for scripts.
 *
 * Cached by flag mask. The result is a pure function of the mask, so the cache cannot
 * go stale within a process.
 */
export function* reachableCoreSteps(
  allowedFlags: number,
): Generator<{ done: number; total: number }, ReachableCore, void> {
  const hit = CORE_CACHE.get(allowedFlags);
  if (hit !== undefined) return hit;

  const live: Rule[] = [];
  for (let i = 0; i < RULES.length; i++) {
    const rule = RULES[i]!;
    if (satisfiable(rule, allowedFlags)) live.push(rule);
    yield { done: i + 1, total: RULES.length };
  }

  const adj = buildAdjacency(live);
  const components = tarjan(adj);
  const core = components.reduce((a, b) => (b.length > a.length ? b : a), [] as Biome[]);
  const inCore = new Set(core);

  const inDegree = new Int32Array(BIOME_COUNT);
  for (let b = 0; b < BIOME_COUNT; b++) for (const w of adj[b]!) inDegree[w]!++;

  const result: ReachableCore = {
    allowedFlags,
    allowedFlagNames: CYCLE_FLAG_NAMES.filter(([bit]) => (allowedFlags & bit) !== 0).map(([, n]) => n),
    liveEdges: adj.reduce((n, s) => n + s.size, 0),
    componentCount: components.length,
    core,
    outside: BIOMES.filter((d) => !inCore.has(d.id)).map((d) => ({
      biome: d.id,
      key: d.key,
      inEdges: inDegree[d.id]!,
      outEdges: adj[d.id]!.size,
    })),
  };
  CORE_CACHE.set(allowedFlags, result);
  return result;
}

/** Blocking form. Fine in a script; see `reachableCoreSteps` before using it in a server. */
export function reachableCore(allowedFlags: number): ReachableCore {
  const steps = reachableCoreSteps(allowedFlags);
  for (;;) {
    const next = steps.next();
    if (next.done === true) return next.value;
  }
}

/** The reachable core of a world made of these cycle kinds. */
export function reachableCoreForKinds(kinds: Iterable<string>): ReachableCore {
  return reachableCore(flagMaskForKinds(kinds));
}
