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
 * Nine checks, all fatal:
 *   1  taxonomy hygiene — unique ids, keys, glyphs, colours, materials, RULE KEYS
 *   2  single strongly connected component over all 22 biomes (Tarjan)
 *   3  no trap nodes, no unreachable nodes, no biome with a single exit
 *   4  no DERIVED rule duplicating a hand-written edge (the fan-out rate hazard)
 *   5  every rule's precondition is satisfiable somewhere in climate x flag space
 *   6  every biome can leave with NO cycle flags raised, or is documented as
 *      cycle-gated — a biome that needs a disturbance to escape is a trap on a
 *      still world
 *   7  the required chemistry from the design brief is present as direct edges
 *   8  no biome family LATCHES on a live world — the check the graph cannot make
 *   9  the solar sweep covers every column exactly once a day, at ANY width
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
  ACKNOWLEDGED_EDGE_OVERLAPS, BIOME_COUNT, BIOMES, Biome, RULES, type Rule,
} from './biomes.ts';
import {
  CYCLE_PRESETS, WorldCycle, type CycleDescription, type CycleEffect,
} from './cycles.ts';
// The graph and satisfiability machinery lives in `reachability.ts` so that the viewer
// can run the same analysis on an arbitrary composed cycle set. It cannot import THIS
// file: everything here executes at module scope and exits the process.
import {
  buildAdjacency, flagMaskForKinds, reachableCore, satisfiable, tarjan,
} from './reachability.ts';
import { DEFAULT_BAND_WIDTH, World } from './world.ts';

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

  // -------------------------------------------------------------------------
  // Rule keys — the thing every transition roll is keyed on
  // -------------------------------------------------------------------------
  //
  // A rule's key selects its stream of dice (see `ruleKey` in biomes.ts). Two rules
  // sharing a key therefore share a roll stream, which is not a cosmetic clash: on any
  // tile where both preconditions hold, the first in bucket order draws the same number
  // the second would have drawn, so the second can only ever fire when the first already
  // did — and the first always wins. The later rule becomes dead code that the graph
  // checks below still count as a live edge, which is precisely the shape of silent
  // wrongness this whole file exists to catch.
  //
  // Both halves are checked because they fail differently and only one is loud:
  //   - a duplicate STRING key means two rules are genuinely indistinguishable, which is
  //     an authoring mistake (usually a copy-pasted label on a duplicated edge);
  //   - a duplicate HASH with distinct strings is a 32-bit FNV-1a collision. Vanishingly
  //     unlikely at ~160 rules and completely invisible if it ever happened, which is
  //     exactly why it is worth a Set rather than an appeal to the birthday bound.
  const ruleKeys = RULES.map((r) => r.key);
  const keysUnique = dupes('rule keys', ruleKeys);
  const hashes = new Map<number, string[]>();
  for (const r of RULES) (hashes.get(r.keyHash) ?? hashes.set(r.keyHash, []).get(r.keyHash)!).push(r.key);
  const collisions = [...hashes.values()].filter((keys) => new Set(keys).size > 1);
  for (const keys of collisions) {
    fail(
      `rule key HASH COLLISION between ${keys.map((k) => `"${k}"`).join(' and ')} — ` +
        'these rules would share a roll stream. Reword one label.',
    );
  }
  console.log(
    `  ${keysUnique && collisions.length === 0 ? green('✓') : red('✗')} ` +
      `${RULES.length} rules · ${new Set(ruleKeys).size} unique keys · ` +
      `${hashes.size} distinct roll streams`,
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
  // The analysis itself lives in `reachability.ts`, so the viewer's composer can run it
  // on an arbitrary cycle set and report exactly what this section reports. It is
  // keyed on cycle KINDS, not on parameters — see that file for what the claim covers.
  console.log(dim('  preset      live edges   SCCs   core   outside the core'));
  for (const [preset, specs] of Object.entries(CYCLE_PRESETS)) {
    const core = reachableCore(flagMaskForKinds(specs.map((s) => s.kind)));
    const outside = core.outside.map((o) => o.key);
    console.log(
      `  ${preset.padEnd(11)} ${String(core.liveEdges).padStart(6)}   ` +
        `${String(core.componentCount).padStart(4)}   ${String(core.core.length).padStart(2)}/${BIOME_COUNT}   ` +
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
// 9 — the sweep covers every column exactly once a day, at every width
// ===========================================================================

section('sweep coverage');
{
  // The check that would have caught the partial-band bug (decision `0006`).
  //
  // `stepsPerDay` is `ceil(width / bandWidth)`, and `step()` used to evaluate exactly
  // `bandWidth` columns every time. When the width was not a multiple of the band, the
  // day's final band ran past the end and wrapped onto columns already done — so those
  // columns aged twice that day, and the doubled stripe DRIFTED as `gaze` accumulated a
  // per-day offset. Nothing crashed and no output revealed it, which is the whole reason
  // it survived long enough to need a check: the world simply ran a few percent fast.
  //
  // It is measured, not reasoned about, and measured through the real `step()` — a
  // closed-form re-derivation of which columns a step visits would be a second
  // implementation of the sweep, free to agree with itself while disagreeing with the
  // simulator. `WorldOptions.cycles` accepts instances, so the instrument is a zero-effect
  // observer cycle and the production code needs no test hook at all.
  //
  // Both halves of the property are asserted from one recording:
  //   - every column is evaluated exactly once per `stepDay()`;
  //   - the SEQUENCE is 0,1,…,width-1 and then starts again at 0, which is what
  //     "`gaze` returned to its starting value" means observably from outside the class.
  // Checking the order and not just the totals matters: a fix that visited the right
  // number of columns while sliding the band's phase by a column a day would pass a
  // count-only check and still age the world in a moving stripe.
  class ColumnObserver extends WorldCycle<number> {
    /** Times `affect` was called for each column. */
    readonly hits: Int32Array;
    /** Column visit order, consecutive duplicates (the rows of one column) collapsed. */
    readonly order: number[] = [];

    constructor(width: number) {
      super('observer', 'observer');
      this.hits = new Int32Array(width);
    }

    /** Never dormant, so `World` keeps calling `affect`. Contributes nothing. */
    dayState(day: number): number {
      return day;
    }

    affect(_state: number, _out: CycleEffect, col: number, _row: number): void {
      this.hits[col]!++;
      if (this.order[this.order.length - 1] !== col) this.order.push(col);
    }

    describe(): CycleDescription {
      return {
        key: this.key, kind: this.kind, label: 'observer', summary: 'test instrument',
        periodDays: 1, flags: [], params: {},
      };
    }
  }

  // Widths that divide the band evenly, widths that do not, and a width BELOW the band
  // (one short step is the whole day). Band widths other than the default are covered
  // because `bandWidth` is a `WorldOptions` knob and the fix has to hold for any value —
  // including 1 (every column its own step) and a band wider than the world.
  const DAYS = 3;
  const H = 8;
  const cases: { width: number; bandWidth?: number }[] = [
    { width: 240 },
    { width: 244 },
    { width: 250 },
    { width: 100 },
    { width: 5 },
    { width: 250, bandWidth: 1 },
    { width: 250, bandWidth: 7 },
    { width: 250, bandWidth: 64 },
    { width: 250, bandWidth: 250 },
    { width: 100, bandWidth: 300 },
  ];

  console.log(dim(`  width × band   steps/day   evals/column/day over ${DAYS} days`));
  for (const { width, bandWidth } of cases) {
    const band = bandWidth ?? DEFAULT_BAND_WIDTH;
    const observer = new ColumnObserver(width);
    const world = new World({ width, height: H, seed: 20260729, bandWidth, cycles: [observer] });
    for (let d = 0; d < DAYS; d++) world.stepDay();

    const label = `${width} × ${band}`;
    const expected = DAYS * H;
    let doubled = 0;
    let missed = 0;
    for (let c = 0; c < width; c++) {
      if (observer.hits[c]! > expected) doubled++;
      else if (observer.hits[c]! < expected) missed++;
    }
    const perColumn = observer.order.length / width / DAYS;
    const stepsPerDay = Math.ceil(width / band);

    if (doubled > 0 || missed > 0) {
      fail(
        `sweep at width ${width} band ${band}: ${doubled} column(s) evaluated more than once ` +
          `per day and ${missed} fewer — ${perColumn.toFixed(3)} evaluations/column/day, ` +
          'must be exactly 1.000',
      );
    }

    // Order. A deviation localises the mistake to one visit, which a total cannot.
    const wanted = width * DAYS;
    let orderProblem: string | null = null;
    if (observer.order.length !== wanted) {
      orderProblem =
        `${observer.order.length} column visits over ${DAYS} days, expected ${wanted} ` +
        `(${width} columns × ${DAYS}) — the sweep ` +
        (observer.order.length > wanted ? 'revisits columns within a day' : 'stops short of the width');
    } else {
      for (let k = 0; k < wanted; k++) {
        if (observer.order[k] === k % width) continue;
        orderProblem =
          `visit ${k} was column ${observer.order[k]}, expected ${k % width} — the band's phase ` +
          'drifts, so the gaze does not return to its starting column after a full stepDay()';
        break;
      }
    }
    if (orderProblem !== null) fail(`sweep at width ${width} band ${band}: ${orderProblem}`);

    const ok = doubled === 0 && missed === 0 && orderProblem === null;
    console.log(
      `  ${label.padEnd(13)} ${String(stepsPerDay).padStart(7)}   ` +
        `${ok ? green('✓') : red('✗')} ${perColumn.toFixed(3)}` +
        (bandWidth === undefined ? dim('   (default band)') : ''),
    );
  }
  console.log(
    dim(
      '\n  A zero-effect observer cycle counts real `affect` calls per column, so this\n' +
        '  measures the sweep the simulator actually runs. Before the fix, 244/250/100\n' +
        '  read 1.016/1.024/1.040 here — see decision `0006`.',
    ),
  );
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
