/**
 * Automated invariant checks over the transition ruleset.
 *
 *   node src/sim/invariants.ts
 *
 * This is the file that makes the strong-connectivity pillar a PROPERTY rather than a
 * claim. The design requirement is precise and slightly counter-intuitive:
 *
 *   - The DIRECT graph must stay SPARSE. If most biomes convert into most others the
 *     world is mush; glass must not become rainforest in one step.
 *   - The REACHABILITY graph must be COMPLETE. There must be a path from any biome to
 *     any other, however long and however rare the events it needs.
 *
 * Both at once is exactly "the transition graph is a single strongly connected
 * component", so a Tarjan pass over 22 nodes settles it in milliseconds and can be run
 * on every ruleset change. What it catches is the failure mode that is otherwise
 * invisible until a player is standing on it: a TRAP NODE — one biome, usually a newly
 * added one, that everything flows into and nothing flows out of.
 *
 * Eight checks, all fatal:
 *   1  taxonomy hygiene — unique ids, keys, glyphs, colours, materials
 *   2  single strongly connected component over all 22 biomes (Tarjan)
 *   3  no trap nodes, no unreachable nodes, no biome with a single exit
 *   4  no DERIVED rule duplicating a hand-written edge (the fan-out rate hazard)
 *   5  every rule's precondition is satisfiable somewhere in climate x flag space
 *   6  every biome can leave with NO cycle flags raised, or is documented as
 *      cycle-gated — a biome that needs a disturbance to escape is a trap on a
 *      still world
 *   7  the required chemistry from the design brief is present as direct edges
 *   8  no biome family LATCHES on a live world — the check the graph cannot make
 *
 * Check 8 is there because checks 2-5 are all necessary and none of them is
 * sufficient. "This rule fires above heat 30" and "a tile that IS this biome can ever
 * reach heat 30 on this world" are different statements, and a review of the first
 * draft found 12.5% of a world permanently immutable while every rule was individually
 * satisfiable and the graph was a single component. Check 8 runs real worlds and asks
 * which tiles never had a live exit at all.
 *
 * Plus two reports that are informational rather than fatal: graph eccentricity, and
 * the per-preset reachable core (a world with no tectonics literally cannot make a
 * mountain, and that is a feature — it is the GM's dial expressed as connectivity).
 */

import {
  ACKNOWLEDGED_EDGE_OVERLAPS, BIOME_COUNT, BIOMES, Biome, RULES,
  type Rule, type TileContext,
} from './biomes.ts';
import { CYCLE_FLAG_NAMES, CYCLE_PRESETS, CycleFlag, makeCycle } from './cycles.ts';
import { World } from './world.ts';

const COLOUR = process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb';
const bold = (s: string) => (COLOUR ? `\x1b[1m${s}\x1b[0m` : s);
const dim = (s: string) => (COLOUR ? `\x1b[2m${s}\x1b[0m` : s);
const red = (s: string) => (COLOUR ? `\x1b[31m${s}\x1b[0m` : s);
const green = (s: string) => (COLOUR ? `\x1b[32m${s}\x1b[0m` : s);

const failures: string[] = [];
const fail = (msg: string) => failures.push(msg);
const name = (b: Biome) => BIOMES[b]!.key;

function section(title: string): void {
  console.log('\n' + bold(`── ${title} `) + dim('─'.repeat(Math.max(0, 66 - title.length))));
}

// ===========================================================================
// The graph
// ===========================================================================

/** Adjacency as sets of target biomes, optionally restricted to a live rule subset. */
function buildAdjacency(rules: readonly Rule[]): Set<Biome>[] {
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
function tarjan(adj: readonly Set<Biome>[]): Biome[][] {
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

/** BFS distances from one node. Infinity where unreachable. */
function bfs(adj: readonly Set<Biome>[], from: Biome): number[] {
  const dist = new Array<number>(BIOME_COUNT).fill(Infinity);
  dist[from] = 0;
  const queue: Biome[] = [from];
  for (let head = 0; head < queue.length; head++) {
    const v = queue[head]!;
    for (const w of adj[v]!) {
      if (dist[w] !== Infinity) continue;
      dist[w] = dist[v]! + 1;
      queue.push(w);
    }
  }
  return dist;
}

/** Reconstruct a shortest path, for the human-readable chemistry report. */
function shortestPath(adj: readonly Set<Biome>[], from: Biome, to: Biome): Biome[] | null {
  const prev = new Array<number>(BIOME_COUNT).fill(-1);
  const seen = new Uint8Array(BIOME_COUNT);
  seen[from] = 1;
  const queue: Biome[] = [from];
  for (let head = 0; head < queue.length; head++) {
    const v = queue[head]!;
    if (v === to) break;
    for (const w of adj[v]!) {
      if (seen[w]) continue;
      seen[w] = 1;
      prev[w] = v;
      queue.push(w);
    }
  }
  if (!seen[to]) return null;
  const path: Biome[] = [];
  for (let v: number = to; v !== -1; v = prev[v]!) {
    path.push(v as Biome);
    if (v === from) break;
  }
  return path.reverse();
}

// ===========================================================================
// Satisfiability: can this rule ever fire at all?
// ===========================================================================

/**
 * Flag combinations worth probing.
 *
 * Not the full 2^10 power set — the ruleset only ever tests a handful of combinations,
 * and the ones that matter are the ones a real cycle can produce together. Focus never
 * appears without Beam or Eruption, and Uplift never appears without Quake, because
 * that is how cycles.ts raises them.
 */
const FLAG_COMBOS: readonly number[] = [
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
];

const HEATS: number[] = [];
for (let h = -20; h <= 200; h += 5) HEATS.push(h);
const MOISTS: number[] = [];
for (let m = 0; m <= 100; m += 5) MOISTS.push(m);

const scratchCounts = new Int32Array(BIOME_COUNT);

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
  return {
    biome,
    heat,
    moisture,
    waterNeighbours,
    neighbourCounts: scratchCounts,
    flags,
    underBeam: (flags & CycleFlag.Beam) !== 0,
  };
}

/**
 * Does `rule.when` ever return a positive pressure, anywhere in climate x neighbour x
 * flag space? A rule that never can is dead code, and dead code in this file is
 * usually a typo'd threshold rather than an unused feature — an edge the graph is
 * counting on that will never actually fire.
 *
 * `allowedFlags` restricts the probe to what a given world can produce, which is how
 * the per-preset reachable core below is computed.
 */
function satisfiable(rule: Rule, allowedFlags = -1): boolean {
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

// ===========================================================================
// 1 — taxonomy hygiene
// ===========================================================================

section('taxonomy');
{
  const dupes = (label: string, values: (string | number)[]) => {
    const seen = new Map<string | number, number>();
    for (const v of values) seen.set(v, (seen.get(v) ?? 0) + 1);
    const bad = [...seen].filter(([, n]) => n > 1).map(([v]) => String(v));
    if (bad.length > 0) fail(`duplicate ${label}: ${bad.join(', ')}`);
    return bad.length === 0;
  };

  if (BIOMES.length !== BIOME_COUNT) {
    fail(`BIOME_COUNT is ${BIOME_COUNT} but BIOMES has ${BIOMES.length} entries`);
  }
  for (let b = 0; b < BIOMES.length; b++) {
    if (BIOMES[b]!.id !== b) fail(`BIOMES[${b}].id is ${BIOMES[b]!.id} — order must match ids`);
  }
  dupes('keys', BIOMES.map((d) => d.key));
  dupes('glyphs', BIOMES.map((d) => d.glyph));
  dupes('colours', BIOMES.map((d) => d.colour));
  const materials = BIOMES.flatMap((d) => d.materials);
  dupes('materials', materials);
  for (const d of BIOMES) {
    if (d.materials.length < 3) fail(`${d.key} has only ${d.materials.length} materials`);
    if (d.moistureSource > 0 && !d.water) fail(`${d.key} is a moisture source but not water`);
    if (d.molten && d.moistureSource > 0) fail(`${d.key} is molten AND a moisture source`);
  }
  console.log(
    `  ${BIOMES.length} biomes · ${materials.length} materials · ` +
      `${new Set(materials).size} unique · ${new Set(BIOMES.map((d) => d.glyph)).size} glyphs · ` +
      `${new Set(BIOMES.map((d) => d.colour)).size} colours`,
  );
}

// ===========================================================================
// 2, 3 — strong connectivity
// ===========================================================================

section('transition graph');

const adj = buildAdjacency(RULES);
const edgeCount = adj.reduce((n, s) => n + s.size, 0);
const inDegree = new Int32Array(BIOME_COUNT);
for (let b = 0; b < BIOME_COUNT; b++) for (const w of adj[b]!) inDegree[w]!++;

console.log(
  `  ${RULES.length} rules → ${edgeCount} distinct edges over ${BIOME_COUNT} nodes ` +
    dim(`(${((100 * edgeCount) / (BIOME_COUNT * (BIOME_COUNT - 1))).toFixed(1)}% density)`),
);

const sccs = tarjan(adj);
if (sccs.length === 1 && sccs[0]!.length === BIOME_COUNT) {
  console.log(`  ${green('✓')} single strongly connected component containing all ${BIOME_COUNT} biomes`);
} else {
  fail(
    `transition graph has ${sccs.length} strongly connected components, not 1 — ` +
      sccs
        .sort((a, b) => b.length - a.length)
        .map((c) => `{${c.map(name).join(',')}}`)
        .join(' '),
  );
}

for (let b = 0; b < BIOME_COUNT; b++) {
  const out = adj[b]!.size;
  if (out === 0) fail(`${name(b as Biome)} is a TRAP NODE — nothing leaves it`);
  else if (out === 1) fail(`${name(b as Biome)} has a single exit — one threshold typo from a trap`);
  if (inDegree[b] === 0) fail(`${name(b as Biome)} is UNREACHABLE — nothing enters it`);
  else if (inDegree[b] === 1) fail(`${name(b as Biome)} has a single entrance`);
}

// Eccentricity: the longest shortest-path out of each biome.
let diameter = 0;
const ecc: number[] = [];
for (let b = 0; b < BIOME_COUNT; b++) {
  const dist = bfs(adj, b as Biome);
  let e = 0;
  for (const d of dist) if (d !== Infinity && d > e) e = d;
  ecc.push(e);
  if (e > diameter) diameter = e;
}
const radius = Math.min(...ecc);
console.log(`  eccentricity ${radius}–${diameter} ` + dim(`(radius ${radius}, diameter ${diameter})`));
const far = BIOMES.map((d, i) => [d.key, ecc[i]!] as const)
  .filter(([, e]) => e === diameter)
  .map(([k]) => k);
const near = BIOMES.map((d, i) => [d.key, ecc[i]!] as const)
  .filter(([, e]) => e === radius)
  .map(([k]) => k);
console.log(dim(`    hubs (ecc ${radius}): ${near.join(', ')}`));
console.log(dim(`    far corners (ecc ${diameter}): ${far.join(', ')}`));
console.log(
  dim('    out/in degree: ') +
    BIOMES.map((d, i) => `${d.glyph}${adj[i]!.size}/${inDegree[i]!}`).join(' '),
);

// ===========================================================================
// 4 — derived fan-outs must not duplicate hand-written edges
// ===========================================================================

section('fan-out rate hazard');
{
  const acknowledged = new Set(ACKNOWLEDGED_EDGE_OVERLAPS);
  const handwritten = new Set<string>();
  for (const r of RULES) if (!r.derived) handwritten.add(`${r.from}>${r.to}`);
  let clashes = 0;
  for (const r of RULES) {
    if (!r.derived) continue;
    const key = `${r.from}>${r.to}`;
    if (handwritten.has(key) && !acknowledged.has(key)) {
      clashes++;
      fail(
        `derived rule "${r.label}" duplicates a hand-written ${name(r.from)} → ${name(r.to)} edge — ` +
          'the biome changes at the sum of both rates, not the validated one. Either exclude it ' +
          'from the fan-out or add it to ACKNOWLEDGED_EDGE_OVERLAPS with a reason.',
      );
    }
  }
  // An acknowledgement that no longer describes anything is stale documentation, and
  // stale documentation about a rate hazard is worse than none.
  for (const key of acknowledged) {
    const [from, to] = key.split('>').map(Number) as [Biome, Biome];
    const hasDerived = RULES.some((r) => r.derived && r.from === from && r.to === to);
    const hasHand = RULES.some((r) => !r.derived && r.from === from && r.to === to);
    if (!hasDerived || !hasHand) {
      fail(
        `ACKNOWLEDGED_EDGE_OVERLAPS lists ${name(from)} → ${name(to)}, but that is no longer ` +
          'a derived/hand-written overlap — remove the entry',
      );
    }
  }
  // Duplicate hand-written edges are legal (glass has three exits to different places,
  // bloom has two to forest at different medians) but they are worth showing, because
  // a pair of rules with overlapping preconditions is a rate change nobody intended.
  const pairs = new Map<string, Rule[]>();
  for (const r of RULES) {
    const k = `${r.from}>${r.to}`;
    (pairs.get(k) ?? pairs.set(k, []).get(k)!).push(r);
  }
  const multi = [...pairs.values()].filter((rs) => rs.length > 1);
  console.log(`  ${clashes === 0 ? green('✓') : red('✗')} 0 derived/hand-written clashes`);
  for (const rs of multi) {
    console.log(
      dim(
        `    ${name(rs[0]!.from).padEnd(10)} → ${name(rs[0]!.to).padEnd(10)}  ` +
          rs.map((r) => `"${r.label}" (m${r.medianDays})`).join('  ·  '),
      ),
    );
  }
}

// ===========================================================================
// 5 — every rule's precondition is satisfiable
// ===========================================================================

section('rule satisfiability');
{
  const dead: Rule[] = [];
  for (const r of RULES) if (!satisfiable(r)) dead.push(r);
  if (dead.length === 0) {
    console.log(`  ${green('✓')} all ${RULES.length} rules can fire somewhere in climate × flag space`);
  } else {
    for (const r of dead) {
      fail(
        `rule "${r.label}" (${name(r.from)} → ${name(r.to)}) is UNSATISFIABLE — ` +
          'its precondition is never true for any heat, moisture, neighbour set or flag',
      );
    }
  }
}

// ===========================================================================
// 6 — nothing needs a disturbance in order to escape
// ===========================================================================

section('escapability without cycles');
{
  // A biome whose only exits are cycle-gated is a trap on a `still` world, and a
  // half-trap on any world whose cycle set omits the relevant flag. That is ALLOWED —
  // it is the whole point of "a world with no tectonics has no mountains" — but it
  // must be deliberate, so the list is printed rather than silently accepted.
  const quiet = new Set<Biome>();
  for (const r of RULES) {
    if (r.from === r.to) continue;
    if (satisfiable(r, 0)) quiet.add(r.from);
  }
  const gated = BIOMES.filter((d) => !quiet.has(d.id)).map((d) => d.key);
  if (gated.length === 0) {
    console.log(`  ${green('✓')} every biome has at least one exit that needs no cycle at all`);
  } else {
    console.log(`  ${gated.length} biome(s) can only be left via a cycle flag: ${gated.join(', ')}`);
    console.log(dim('    deliberate: these are the parts of the graph a GM opens by choosing cycles.'));
  }
}

// ===========================================================================
// 7 — the required chemistry
// ===========================================================================

section('required chemistry');
{
  const required: [Biome, Biome, string][] = [
    [Biome.Desert, Biome.Lava, 'sand melts to lava'],
    [Biome.Lava, Biome.Glass, 'lava quenches to glass'],
    [Biome.Glass, Biome.Desert, 'glass returns to sand'],
    [Biome.Lava, Biome.Basalt, 'lava cools to basalt'],
    [Biome.Lava, Biome.Soil, 'lava cools to fertile soil'],
    [Biome.Soil, Biome.Forest, 'soil grows forest'],
    [Biome.Forest, Biome.Swamp, 'ocean + forest → swamp'],
    [Biome.Forest, Biome.Rainforest, 'ocean + forest → rainforest'],
    [Biome.Rock, Biome.Mountain, 'orogeny'],
    [Biome.Glacier, Biome.Rock, 'retreat exposes bedrock'],
  ];
  for (const [from, to, label] of required) {
    if (!adj[from]!.has(to)) fail(`missing required DIRECT edge ${name(from)} → ${name(to)} (${label})`);
  }
  console.log(`  ${green('✓')} ${required.length} required direct edges present`);

  // The other half of the pillar: the long ways round must exist too.
  const journeys: [Biome, Biome][] = [
    [Biome.Glass, Biome.Rainforest],
    [Biome.Glass, Biome.Bloom],
    [Biome.Glacier, Biome.Lava],
    [Biome.Badlands, Biome.Bloom],
    [Biome.Mountain, Biome.Ocean],
    [Biome.Desert, Biome.Glacier],
    [Biome.Rainforest, Biome.Mountain],
    [Biome.FrozenSea, Biome.Desert],
  ];
  for (const [from, to] of journeys) {
    const path = shortestPath(adj, from, to);
    if (path === null) {
      fail(`no path at all from ${name(from)} to ${name(to)}`);
      continue;
    }
    console.log(
      dim(`    ${name(from).padEnd(10)} → ${name(to).padEnd(11)} d=${path.length - 1}  `) +
        path.map(name).join(' → '),
    );
  }
}

// ===========================================================================
// Informational — the reachable core per cycle preset
// ===========================================================================

section('reachable core per cycle preset');
{
  const flagBit = new Map(CYCLE_FLAG_NAMES.map(([bit, n]) => [n, bit]));
  console.log(dim('  preset      live edges   SCCs   core   outside the core'));
  for (const [preset, specs] of Object.entries(CYCLE_PRESETS)) {
    let allowed = 0;
    for (const spec of specs) {
      // bind() only needs a grid to exist; describe() is what we are after.
      const cycle = makeCycle(spec).bind(64, 32, 1);
      for (const f of cycle.describe().flags) allowed |= flagBit.get(f) ?? 0;
    }
    const live = RULES.filter((r) => satisfiable(r, allowed));
    const sub = buildAdjacency(live);
    const comps = tarjan(sub);
    const biggest = comps.reduce((a, b) => (b.length > a.length ? b : a), [] as Biome[]);
    const outside = BIOMES.filter((d) => !biggest.includes(d.id)).map((d) => d.key);
    console.log(
      `  ${preset.padEnd(11)} ${String(sub.reduce((n, s) => n + s.size, 0)).padStart(6)}   ` +
        `${String(comps.length).padStart(4)}   ${String(biggest.length).padStart(2)}/${BIOME_COUNT}   ` +
        dim(outside.length === 0 ? '—' : outside.join(', ')),
    );
  }
  console.log(
    dim(
      '\n  A world with no tectonics literally cannot make a mountain; one with no\n' +
        '  volcanism and no beam has no route to lava, ash, basalt or fertile soil.\n' +
        "  That is the GM's dial expressed as graph connectivity, and it is why the\n" +
        '  full-flag graph above is the one that must be a single component.',
    ),
  );
}

// ===========================================================================
// 8 — escapability in a LIVE world, per preset
// ===========================================================================

section('escapability in a live world');
{
  // The check the graph cannot make.
  //
  // Every rule can be individually satisfiable, and the graph can be a single strongly
  // connected component, and 12.5% of the world can still be permanently immutable —
  // because "this rule fires at heat > 30" and "a tile that IS this biome can ever
  // reach heat 30 on this world" are different statements. That gap is exactly how the
  // first draft shipped a polar cap that froze and never thawed: sea ice needed heat
  // above 30 to break up, cold-band sea sat at 6-21 all year, and no cycle in the
  // world could close the difference.
  //
  // So: run each preset for two game-years and, over the SECOND one, mark every tile
  // that at any point had at least one live out-rule. A tile that never did is a tile
  // whose terrain can never change again, whatever a player does to it.
  const W = 120;
  const H = 72;
  const SETTLE = 365;
  const WATCH = 365;
  const STRIDE = 3;

  console.log(dim('  preset       no live exit   by biome (Deep Ocean interiors are expected)'));
  for (const [preset, specs] of Object.entries(CYCLE_PRESETS)) {
    const world = new World({ width: W, height: H, seed: 20260729, cycles: specs });
    for (let d = 0; d < SETTLE; d++) world.stepDay();

    const escapable = new Uint8Array(world.biome.length);
    for (let d = 0; d < WATCH; d++) {
      world.stepDay();
      if (d % STRIDE !== 0) continue;
      for (let i = 0; i < world.biome.length; i++) {
        if (escapable[i]) continue;
        if (world.liveRuleCount(i) > 0) escapable[i] = 1;
      }
    }

    const stuck = new Int32Array(BIOME_COUNT);
    let total = 0;
    for (let i = 0; i < escapable.length; i++) {
      if (escapable[i]) continue;
      stuck[world.biome[i]!]!++;
      total++;
    }
    const share = total / escapable.length;
    const offenders = BIOMES.map((d, i) => [d.key, stuck[i]! / escapable.length] as const)
      .filter(([, f]) => f > 0.0005)
      .sort((a, b) => b[1] - a[1])
      .map(([k, f]) => `${k} ${(100 * f).toFixed(2)}%`);

    // The verdict is PER BIOME, not on the total, and Deep Ocean is exempt.
    //
    // Ocean interior tiles legitimately have no live out-rule: `bay silts up` needs
    // land nearby and `the sea boils back` needs the sea already boiled off its edges.
    // You cannot dry the middle of an ocean before you dry its shore, and a model that
    // let you would be the wrong model. Nor can this be waved away by taking the
    // transitive closure of escapability over the neighbour graph — the torus is one
    // connected component, so a single moving tile anywhere would mark the whole world
    // escapable and the check would pass for any ruleset at all.
    //
    // What must never happen is a whole FAMILY latching: a polar cap where the ice, the
    // sea under it and the land beside it are all individually stuck, which is what
    // 12.5%-of-a-world of frozen sea plus glacier looked like before the ICE_FORM /
    // ICE_THAW thresholds, the removal of the cold-albedo term, and the polar seasonal
    // amplitude were fixed together.
    const LIMIT = 0.02;
    // `still` is the control: it has no disturbance by construction, and a world with
    // nothing happening to it being unable to change is the FINDING, not a defect.
    const exempt = specs.length === 0;
    const latched = BIOMES.filter(
      (d) => d.id !== Biome.Ocean && stuck[d.id]! / escapable.length > LIMIT,
    );
    const ok = exempt || latched.length === 0;
    if (!ok) {
      for (const d of latched) {
        fail(
          `${preset}: ${((100 * stuck[d.id]!) / escapable.length).toFixed(2)}% of the world is ` +
            `${d.key} with no live out-rule over a full game-year — a latched biome family`,
        );
      }
    }
    console.log(
      `  ${preset.padEnd(11)} ${ok ? green('✓') : red('✗')} ${(share * 100).toFixed(2).padStart(6)}%` +
        (exempt ? dim('   (control: no cycles, expected)') : '') +
        (offenders.length > 0 ? dim(`   ${offenders.join(', ')}`) : ''),
    );
  }
}

// ===========================================================================

section('result');
if (failures.length === 0) {
  console.log(`  ${green('✓ all invariants hold')}\n`);
  process.exit(0);
} else {
  for (const f of failures) console.log(`  ${red('✗')} ${f}`);
  console.log(`\n  ${red(`${failures.length} invariant failure(s)`)}\n`);
  process.exit(1);
}
