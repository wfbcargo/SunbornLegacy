/**
 * The viewer client. Plain ES modules, no framework, no build step.
 *
 * It owns NO simulation. It asks the server for frames and draws them; every number
 * on the panel was computed by `src/sim/report.ts` on the server side.
 */

const $ = (id) => document.getElementById(id);

const canvas = $('map');
const ctx = canvas.getContext('2d', { alpha: false });

/** Server-side constants: biome palette, presets, liveness thresholds. */
let meta = null;
/** Latest decoded frame header. */
let status = null;
/** Latest biome plane, and the one before it — the diff drives partial redraws. */
let biome = null;
let prevBiome = null;
let moisture = null;

/** Geometry, rebuilt only when the hex size or the world size changes. */
let geom = null;
let geomDirty = true;
/** Set when the canvas holds nothing we can diff against. */
let needsFullDraw = true;

// ---------------------------------------------------------------------------
// Hex geometry — pointy-top, odd-r offset, matching HexTorus storage exactly.
// ---------------------------------------------------------------------------

/**
 * Hexes are filled at a slightly larger radius than they are spaced. Neighbouring
 * hexes tile the plane exactly, so at the true radius the antialiased edges of two
 * adjacent fills average to a visible hairline seam across the whole map. The overdraw
 * is also what makes partial redraws safe: a repainted tile fully covers its old
 * pixels rather than leaving a rim of the previous colour.
 */
const OVERDRAW = 0.4;

function buildGeometry(hexR) {
  const w = status.width;
  const h = status.height;
  const hexW = Math.sqrt(3) * hexR;
  const rowStep = 1.5 * hexR;

  const cx = new Float32Array(w * h);
  const cy = new Float32Array(w * h);
  for (let row = 0; row < h; row++) {
    const y = row * rowStep + hexR;
    const shift = (row & 1) * 0.5;
    for (let col = 0; col < w; col++) {
      const i = row * w + col;
      cx[i] = (col + shift) * hexW + hexW / 2;
      cy[i] = y;
    }
  }

  const r = hexR + OVERDRAW;
  const vx = new Float64Array(6);
  const vy = new Float64Array(6);
  for (let k = 0; k < 6; k++) {
    const a = (Math.PI / 3) * k - Math.PI / 2;
    vx[k] = r * Math.cos(a);
    vy[k] = r * Math.sin(a);
  }

  return { w, h, hexR, hexW, rowStep, cx, cy, vx, vy };
}

function resizeCanvas() {
  canvas.width = Math.ceil(geom.w * geom.hexW + geom.hexW / 2);
  canvas.height = Math.ceil((geom.h - 1) * geom.rowStep + 2 * geom.hexR);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Subpaths per `fill()`. MEASURED, and the single most important number in this file.
 *
 * The obvious implementation — bucket tiles by biome, build ONE path per colour, fill
 * it once — is catastrophic, and catastrophic in a way that only shows up at full size.
 * A path holding every tile of a colour carries up to ~207,000 edges, and the
 * rasteriser's active-edge work per scanline grows with the whole path rather than with
 * the part of it that touches the scanline. Measured on this canvas at 240×144, filling
 * all 34,560 hexes as one path per colour:
 *
 *     one fill()              6867 ms
 *     flush every 4096        806 ms
 *     flush every 512         130 ms
 *     flush every 64          16 ms
 *     flush every 16          7 ms      <-- here
 *     flush every 1           19 ms     (per-tile fillStyle churn dominates again)
 *
 * So it is a U, not a slope: too few fills and the rasteriser drowns, too many and the
 * per-call overhead does. 16 sits at the bottom. Bucketing by biome is still worth
 * doing — it is what lets a flush contain 16 tiles of ONE colour — but the batching is
 * what makes the viewer usable, not the bucketing.
 */
const FILL_CHUNK = 16;

/**
 * Draw a set of tiles, bucketed by biome so `fillStyle` is set once per biome present (23 at most) per frame
 * instead of once per tile, and flushed every FILL_CHUNK hexes so the rasteriser never
 * sees a path large enough to choke on.
 */
function drawTiles(indices, count) {
  const { cx, cy, vx, vy } = geom;
  const n = meta.biomes.length;

  const bucketSize = new Uint32Array(n);
  for (let k = 0; k < count; k++) bucketSize[biome[indices[k]]]++;

  const start = new Uint32Array(n + 1);
  for (let b = 0; b < n; b++) start[b + 1] = start[b] + bucketSize[b];

  const cursor = start.slice(0, n);
  const order = new Uint32Array(count);
  for (let k = 0; k < count; k++) {
    const i = indices[k];
    order[cursor[biome[i]]++] = i;
  }

  for (let b = 0; b < n; b++) {
    const from = start[b];
    const to = start[b + 1];
    if (from === to) continue;
    ctx.fillStyle = meta.biomes[b].hex;
    ctx.beginPath();
    let pending = 0;
    for (let k = from; k < to; k++) {
      const i = order[k];
      const x = cx[i];
      const y = cy[i];
      ctx.moveTo(x + vx[0], y + vy[0]);
      ctx.lineTo(x + vx[1], y + vy[1]);
      ctx.lineTo(x + vx[2], y + vy[2]);
      ctx.lineTo(x + vx[3], y + vy[3]);
      ctx.lineTo(x + vx[4], y + vy[4]);
      ctx.lineTo(x + vx[5], y + vy[5]);
      ctx.closePath();
      if (++pending === FILL_CHUNK) {
        ctx.fill();
        ctx.beginPath();
        pending = 0;
      }
    }
    if (pending > 0) ctx.fill();
  }
}

let allIndices = null;

function drawFull() {
  const size = geom.w * geom.h;
  if (allIndices === null || allIndices.length !== size) {
    allIndices = new Uint32Array(size);
    for (let i = 0; i < size; i++) allIndices[i] = i;
  }
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  drawTiles(allIndices, size);
}

let changed = null;

/**
 * Partial redraw. A quiet day changes a few hundred tiles out of 34,560; a purge front
 * changes tens of thousands, and past roughly a fifth of the map the bookkeeping costs
 * more than simply repainting everything.
 */
function drawDiff() {
  const size = geom.w * geom.h;
  if (changed === null || changed.length !== size) changed = new Uint32Array(size);

  let count = 0;
  for (let i = 0; i < size; i++) {
    if (biome[i] !== prevBiome[i]) changed[count++] = i;
  }
  if (count > size * 0.2) {
    drawFull();
    return count;
  }
  if (count > 0) drawTiles(changed, count);
  return count;
}

let lastDrawMs = 0;
let lastChanged = 0;

function render() {
  if (geomDirty) {
    geom = buildGeometry(Number($('zoom').value));
    resizeCanvas();
    geomDirty = false;
    needsFullDraw = true;
  }

  const t0 = performance.now();
  if (needsFullDraw || prevBiome === null || prevBiome.length !== biome.length) {
    drawFull();
    lastChanged = geom.w * geom.h;
    needsFullDraw = false;
  } else {
    lastChanged = drawDiff();
  }
  lastDrawMs = performance.now() - t0;

  prevBiome = biome.slice();
}

// ---------------------------------------------------------------------------
// Frame transport
// ---------------------------------------------------------------------------

async function fetchFrame() {
  const res = await fetch('/api/frame', { cache: 'no-store' });
  if (!res.ok) throw new Error(`frame ${res.status}`);
  const buf = await res.arrayBuffer();

  const headerLength = new DataView(buf).getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, headerLength)));
  const size = header.width * header.height;

  const newGeneration = status === null || status.generation !== header.generation;
  status = header;
  biome = new Uint8Array(buf, 4 + headerLength, size);
  moisture = new Uint8Array(buf, 4 + headerLength + size, size);

  if (newGeneration) {
    prevBiome = null;
    needsFullDraw = true;
    geomDirty = true;
  }
  return header;
}

let lastDrawnDay = -1;
let lastDrawnGeneration = -1;
let lastSyncedGeneration = -1;

async function refresh() {
  await fetchFrame();
  // A new world — this tab's Regenerate, or another tab's — replaces what the composer
  // is mirroring, unless this tab has an edit in flight.
  if (status.generation !== lastSyncedGeneration) {
    lastSyncedGeneration = status.generation;
    if (meta !== null) syncComposerFromServer();
  }
  if (
    status.day !== lastDrawnDay ||
    status.generation !== lastDrawnGeneration ||
    geomDirty ||
    needsFullDraw
  ) {
    render();
    lastDrawnDay = status.day;
    lastDrawnGeneration = status.generation;
  }
  paintPanel();
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

const pct = (v, digits = 1) => `${(v * 100).toFixed(digits)}%`;

function syncField(el, value) {
  if (document.activeElement !== el && el.value !== value) el.value = value;
}

function setMetric(id, value, note, state) {
  $(id).textContent = value;
  $(`${id}-note`).textContent = note;
  const box = $(`m-${id}`);
  box.classList.remove('pass', 'fail', 'warm');
  if (state) box.classList.add(state);
}

/**
 * `alive` is the AND of four gates, but "heat death" is the name of exactly ONE of them:
 * assessStability emits that phrase only when the churn gate fails (report.ts), because
 * being alive is a property of MOTION (R-005). Labelling every failure "heat death" states
 * a diagnosis the measurements may actively rule out — a young world whose churn is healthy
 * but whose entropy has not developed yet was being announced as stopped, and a mature world
 * failing on dominance alone would be too. Name the gate that actually failed (R-003).
 */
function verdictLabel(v, t) {
  if (v.alive) return 'alive';
  if (v.lateChurn < t.churn) return 'heat death';
  if (v.dominance > t.dominance) return `dominated by ${v.dominantBiome || 'one biome'}`;
  if (v.endEntropy < t.entropy) return 'low variety';
  if (v.liveBiomes < t.biomes) return 'too few biomes';
  return 'not alive';
}

function paintPanel() {
  const v = status.verdict;
  const t = meta.thresholds;

  $('day').textContent = status.day.toLocaleString();
  $('play').textContent = status.playing ? 'Pause' : 'Play';

  // R-005: churn is the load-bearing liveness metric. It reads as "share of the map
  // that changed hands per day", which is why it is shown as a percentage per day.
  const warming = status.samples < meta.churnWarmup;
  setMetric(
    'churn',
    warming ? '—' : pct(v.lateChurn, 3),
    warming
      ? `needs ${meta.churnWarmup} days of history (${status.samples})`
      : `${v.lateChurn >= t.churn ? 'composition still moving' : 'composition has stopped moving'}` +
        ` · alive above ${pct(t.churn, 3)}`,
    warming ? 'warm' : v.lateChurn >= t.churn ? 'pass' : 'fail',
  );

  setMetric(
    'entropy',
    v.endEntropy.toFixed(3),
    `variety, not motion · alive above ${t.entropy}`,
    v.endEntropy >= t.entropy ? 'pass' : 'fail',
  );

  setMetric(
    'dominance',
    pct(v.dominance),
    `${v.dominantBiome || '—'} · alive below ${pct(t.dominance, 0)}`,
    v.dominance <= t.dominance ? 'pass' : 'fail',
  );

  setMetric(
    'live',
    String(v.liveBiomes),
    `of ${meta.biomes.length} · alive at ${t.biomes} or more`,
    v.liveBiomes >= t.biomes ? 'pass' : 'fail',
  );

  const verdict = $('verdict');
  verdict.classList.remove('alive', 'dead');
  if (warming) {
    verdict.textContent = 'gathering history';
  } else {
    verdict.classList.add(v.alive ? 'alive' : 'dead');
    verdict.textContent = verdictLabel(v, t);
  }

  $('notes').innerHTML = '';
  for (const note of v.notes) {
    const li = document.createElement('li');
    li.textContent = note;
    $('notes').append(li);
  }

  paintComposition();

  // Keep the form showing the world that actually exists. The server is the source of
  // truth for seed, size and cycles, not the boxes — a second tab, or a restart against
  // a session already running, would otherwise show controls that describe nothing.
  //
  // But NOT once the user has started composing. `formDirty` is the pending-edit flag:
  // a half-typed 480 being overwritten by the running world's 240 twice a second is the
  // classic version of this bug, and it makes the panel feel possessed.
  if (!formDirty) {
    syncField($('seed'), String(status.seed));
    syncField($('width'), String(status.width));
    syncField($('height'), String(status.height));
  }
  syncField($('speed'), String(status.speed));
  if (document.activeElement !== $('speed')) $('speed-value').textContent = String(status.speed);

  paintCost();

  $('footnote').textContent =
    `${status.width}×${status.height} torus · ${(status.width * status.height).toLocaleString()} tiles · ` +
    `seed ${status.seed} · ${status.preset} · ` +
    `last draw ${lastDrawMs.toFixed(1)}ms (${lastChanged.toLocaleString()} tiles) · ` +
    `tail over the last ${Math.min(status.samples, meta.historyDays)} days`;
}

function paintComposition() {
  const bar = $('composition');
  const legend = $('legend');
  bar.innerHTML = '';
  legend.innerHTML = '';

  const ranked = meta.biomes
    .map((b, i) => ({ ...b, share: status.proportions[i] }))
    .sort((a, b) => b.share - a.share);

  for (const b of ranked) {
    if (b.share <= 0) continue;
    const span = document.createElement('span');
    span.style.flexGrow = String(b.share);
    span.style.background = b.hex;
    span.title = `${b.name} ${pct(b.share)}`;
    bar.append(span);
  }

  for (const b of ranked.slice(0, 12)) {
    if (b.share < 0.001) break;
    const row = document.createElement('div');
    const swatch = document.createElement('i');
    swatch.style.background = b.hex;
    const name = document.createElement('span');
    name.textContent = b.name;
    const share = document.createElement('u');
    share.textContent = pct(b.share);
    row.append(swatch, name, share);
    legend.append(row);
  }
}

// ---------------------------------------------------------------------------
// The composer
// ---------------------------------------------------------------------------

/**
 * The composed cycle set, as `[{ kind, key, values }]`.
 *
 * This is the editable mirror of the world's `cycles`, not a second source of truth:
 * the server owns the world, this owns the pending edit, and `Regenerate` is the only
 * thing that closes the gap. Values are held one per catalogue parameter rather than as
 * a sparse spec so that every field has something to show; `specFromInstance` narrows
 * them back down to the differences when the set is sent.
 */
let composed = [];
/** Set by any edit to the composer or the size fields; cleared when a world is built. */
let formDirty = false;
/** Which cards are expanded, by key, so a re-render does not collapse them all. */
const openCards = new Set();

const kindEntry = (kind) => meta.cycleCatalogue.find((e) => e.kind === kind);

function instanceFromSpec(spec) {
  const entry = kindEntry(spec.kind);
  const values = {};
  for (const p of entry.params) values[p.name] = p.default;
  for (const [name, value] of Object.entries(spec)) {
    if (name === 'kind' || name === 'key') continue;
    if (name in values) values[name] = value;
  }
  return { kind: spec.kind, key: spec.key ?? entry.defaultKey, values };
}

/**
 * Narrow an instance back to a spec: kind, key only when it is not the kind's default,
 * and only the parameters that differ from their defaults.
 *
 * The key rule is load-bearing rather than tidiness. A cycle's key seeds its RNG stream,
 * so sending `key: "solarbeam"` where the preset omitted the key — and `makeCycle`
 * would have used `"beam"` — produces a DIFFERENT world from the same preset: different
 * fault lines, different vents, different phase. Omitting defaults is what makes
 * "load crucible, press Regenerate" reproduce the crucible the CLI runs.
 */
function specFromInstance(inst) {
  const entry = kindEntry(inst.kind);
  const spec = { kind: inst.kind };
  if (inst.key !== entry.defaultKey) spec.key = inst.key;
  for (const p of entry.params) {
    if (inst.values[p.name] !== p.default) spec[p.name] = inst.values[p.name];
  }
  return spec;
}

const composedSpecs = () => composed.map(specFromInstance);

/** A key nothing else is using. Two cycles sharing one are one cycle run twice. */
function uniqueKey(kind) {
  const taken = new Set(composed.map((c) => c.key));
  const base = kindEntry(kind).defaultKey;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/**
 * Which preset the composed set currently IS, or 'custom'.
 *
 * Compared by value rather than remembered from the last Load, so undoing an edit by
 * hand gets the preset's name back and a one-digit change loses it. The label is
 * display only — the world is built from the specs, never from the name.
 */
function presetLabel() {
  const mine = JSON.stringify(composedSpecs());
  for (const [name, specs] of Object.entries(meta.presetCycles)) {
    if (JSON.stringify(specs) === mine) return name;
  }
  return 'custom';
}

function paramRow(inst, index, def) {
  const row = document.createElement('label');
  row.className = 'param';
  const value = inst.values[def.name];
  if (value !== def.default) row.classList.add('changed');

  const name = document.createElement('span');
  name.textContent = def.label;
  if (def.unit) {
    const u = document.createElement('u');
    u.textContent = ` ${def.unit}`;
    name.append(u);
  }

  let input;
  if (def.type === 'boolean') {
    input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = value === true;
  } else if (def.type === 'choice') {
    input = document.createElement('select');
    for (const choice of def.choices) {
      const option = document.createElement('option');
      option.value = String(choice);
      option.textContent = String(choice);
      input.append(option);
    }
    input.value = String(value);
  } else {
    input = document.createElement('input');
    input.type = 'number';
    input.value = String(value);
    if (def.min !== undefined) input.min = String(def.min);
    if (def.max !== undefined) input.max = String(def.max);
    input.step = def.type === 'integer' ? '1' : 'any';
  }

  input.addEventListener('input', () => {
    formDirty = true;
    if (def.type === 'boolean') {
      inst.values[def.name] = input.checked;
    } else if (def.type === 'choice') {
      // ★ NOT `Number(...)`. A choice may be a string — the beam's `shape` is `band` or
      // `blob` — and coercing one gives NaN, which the server rejects and which the
      // person cannot see in the select they just used. Matching back against the
      // catalogue's own list restores the ORIGINAL type, so numeric choices such as
      // direction stay numbers and string choices stay strings, with no per-parameter
      // special case here.
      const picked = def.choices.find((c) => String(c) === input.value);
      inst.values[def.name] = picked !== undefined ? picked : Number(input.value);
    } else {
      inst.values[def.name] = Number(input.value);
    }
    row.classList.toggle('changed', inst.values[def.name] !== def.default);
    paintCost();
  });

  const note = document.createElement('span');
  note.className = 'param-note';
  const range =
    def.min !== undefined && def.max !== undefined ? ` · ${def.min}–${def.max}` : '';
  note.textContent = `${def.note} · default ${def.default}${range}`;

  row.append(name, input, note);
  return row;
}

function cycleCard(inst, index) {
  const entry = kindEntry(inst.kind);
  const card = document.createElement('details');
  card.className = 'cycle';
  card.open = openCards.has(inst.key);
  card.addEventListener('toggle', () => {
    if (card.open) openCards.add(inst.key);
    else openCards.delete(inst.key);
  });

  const head = document.createElement('summary');
  const kind = document.createElement('b');
  kind.className = 'cycle-kind';
  kind.textContent = inst.kind;
  const key = document.createElement('span');
  key.className = 'cycle-key';
  key.textContent = inst.key;
  const label = document.createElement('span');
  label.className = 'cycle-label';
  label.textContent = entry.label;
  head.append(kind, key, label);

  const body = document.createElement('div');
  body.className = 'cycle-body';

  const summary = document.createElement('p');
  summary.className = 'cycle-summary';
  summary.textContent = entry.summary;

  const flags = document.createElement('p');
  flags.className = 'cycle-flags';
  flags.append(document.createTextNode('raises '));
  for (const f of entry.flags) {
    const i = document.createElement('i');
    i.textContent = f;
    flags.append(i, document.createTextNode(' '));
  }

  const params = document.createElement('div');
  params.className = 'params';

  // The key is editable because it is not decoration: it seeds this cycle's own random
  // stream, so two monsoons with different keys are genuinely different monsoons — out
  // of phase, and that is a world somebody may want.
  const keyRow = document.createElement('label');
  keyRow.className = 'param';
  const keyName = document.createElement('span');
  keyName.textContent = 'key';
  const keyInput = document.createElement('input');
  keyInput.type = 'text';
  keyInput.value = inst.key;
  keyInput.addEventListener('input', () => {
    formDirty = true;
    inst.key = keyInput.value;
  });
  const keyNote = document.createElement('span');
  keyNote.className = 'param-note';
  keyNote.textContent =
    'Seeds this cycle’s own random stream, so two cycles of one kind differ. Must be unique.';
  keyRow.append(keyName, keyInput, keyNote);
  params.append(keyRow);

  for (const def of entry.params) params.append(paramRow(inst, index, def));

  const actions = document.createElement('div');
  actions.className = 'cycle-actions';
  const dup = document.createElement('button');
  dup.textContent = 'Duplicate';
  dup.title = 'A second cycle of this kind, with its own key and therefore its own dice';
  dup.addEventListener('click', () => {
    formDirty = true;
    composed.splice(index + 1, 0, {
      kind: inst.kind,
      key: uniqueKey(inst.kind),
      values: { ...inst.values },
    });
    renderComposer();
  });
  const remove = document.createElement('button');
  remove.textContent = 'Remove';
  remove.addEventListener('click', () => {
    formDirty = true;
    openCards.delete(inst.key);
    composed.splice(index, 1);
    renderComposer();
  });
  actions.append(dup, remove);

  body.append(summary, flags, params, actions);
  card.append(head, body);
  return card;
}

function renderComposer() {
  const host = $('composer');
  host.innerHTML = '';

  if (composed.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    // R-005, and the reason this panel exists: fewer cycles is not a gentler world, it
    // is a deader one.
    empty.textContent =
      'No cycles. A world with no disturbance converges on a frozen equilibrium — ' +
      'measured churn 0.29%, against three to five times that on every disturbed world.';
    host.append(empty);
  }

  composed.forEach((inst, i) => host.append(cycleCard(inst, i)));

  const dupes = composed.length - new Set(composed.map((c) => c.key)).size;
  $('cycle-tag').textContent =
    `${composed.length} cycle${composed.length === 1 ? '' : 's'} · ${presetLabel()}` +
    (dupes > 0 ? ' · duplicate keys' : '');

  paintCost();
  paintReach();
}

function renderAddRow() {
  const host = $('add-row');
  host.innerHTML = '';
  for (const entry of meta.cycleCatalogue) {
    const button = document.createElement('button');
    button.textContent = `+ ${entry.kind}`;
    button.title = `${entry.label} — ${entry.summary}`;
    button.addEventListener('click', () => {
      formDirty = true;
      const key = uniqueKey(entry.kind);
      composed.push(instanceFromSpec({ kind: entry.kind, key }));
      openCards.add(key);
      renderComposer();
    });
    host.append(button);
  }
}

/** Adopt the world the server actually has. Never while an edit is in flight. */
function syncComposerFromServer() {
  if (formDirty) return;
  composed = status.cycles.map(instanceFromSpec);
  renderComposer();
}

// ---------------------------------------------------------------------------
// Cost — visible before it is paid
// ---------------------------------------------------------------------------

const KIB = (bytes) => `${(bytes / 1024).toFixed(0)} KiB`;

/**
 * What the current world costs, and what the pending one would.
 *
 * The projection scales the world's own MEASURED ms/day by tile count, which is sound
 * because the simulation is linear in tiles — ~125-175 ns/tile with no cycles and
 * ~216-306 ns/tile with all six cycle kinds, roughly flat from 34,560 tiles (240×144) up
 * to the 262,144-tile cap. Those are the re-measured figures behind `MAX_TILES`; the table
 * they come from, with the per-size ms/day it was fitted to, is in `src/viewer/limits.ts`.
 * The old pair quoted here (92 / 125 ns/tile, over a tile range that now runs past the
 * cap) predated the weather cycle, the stored thermal filter and the river ring.
 *
 * It does not attempt to price ADDING a cycle, because that depends on which cycle: a
 * dormant beam costs nothing at all, since a cycle whose `dayState` returns null is
 * dropped from the per-tile loop entirely.
 */
function paintCost() {
  if (status === null) return;
  const el = $('cost');
  const liveTiles = status.width * status.height;
  const measured = status.msPerDay;

  let text =
    `<b>${liveTiles.toLocaleString()}</b> tiles · ` +
    `<b>${measured > 0 ? `${measured.toFixed(1)} ms` : '—'}</b> per simulated day · ` +
    `${KIB(status.frameBytes)} per frame · ${status.cycles.length} live cycle` +
    `${status.cycles.length === 1 ? '' : 's'}`;

  const w = Number($('width').value);
  const h = Number($('height').value);
  const pendingTiles = w * h;
  if (Number.isFinite(pendingTiles) && pendingTiles > 0 && pendingTiles !== liveTiles) {
    const projected = measured > 0 ? (measured * pendingTiles) / liveTiles : 0;
    const perTick = projected * 3;
    text +=
      `<br>pending <b>${w}×${h}</b> → <b>${pendingTiles.toLocaleString()}</b> tiles · ` +
      (projected > 0 ? `~<b>${projected.toFixed(1)} ms</b> per day projected · ` : '') +
      `${KIB(pendingTiles * 2)} per frame` +
      (perTick > 120
        ? ` · <span class="warn">at 60 days/s that is ~${perTick.toFixed(0)} ms of blocked` +
          ' event loop per tick</span>'
        : '');
  }

  const cycleCount = composed.length;
  if (cycleCount !== status.cycles.length) {
    text += `<br>pending <b>${cycleCount}</b> cycle${cycleCount === 1 ? '' : 's'}` +
      ' · a dormant cycle costs nothing per tile; an active one costs one pass over the map';
  }

  el.innerHTML = text;
}

function showMessage(text, ok = false) {
  const el = $('message');
  el.hidden = text === null;
  el.className = ok ? 'message ok' : 'message';
  el.textContent = text ?? '';
}

// ---------------------------------------------------------------------------
// Missing chemistry — which biomes this cycle set can never make
// ---------------------------------------------------------------------------

/** Result keyed by the sorted kind list it was computed for. */
let reachResult = null;
let reachKey = null;
let reachPending = false;
let reachProgress = null;

const kindKey = () => [...new Set(composed.map((c) => c.kind))].sort().join('+') || '(none)';

function paintReach() {
  const el = $('reach');
  const key = kindKey();

  if (reachPending) {
    const p = reachProgress;
    el.innerHTML =
      `sweeping the ruleset${p && p.total ? ` · ${p.done}/${p.total} rules` : ''}` +
      '<p class="caveat">A restricted world is the slow case: a rule that CANNOT fire has ' +
      'to be ruled out across every probe. Measured over the 185-rule set — about 1 s for ' +
      'all six cycle kinds, 6 s for none, 35 s for seasons + monsoon + tectonics. It is ' +
      'the ruleset being swept, not your map, so the wait does not grow with world size; ' +
      'the seconds are from one machine and yours may differ. Cached once done.</p>';
    return;
  }

  if (reachResult === null || reachKey !== key) {
    el.innerHTML =
      reachKey === null
        ? '<p class="caveat">Not measured for this set yet.</p>'
        : `<p class="caveat">Cycle kinds changed since the last analysis (${reachKey}). ` +
          'Run it again.</p>';
    return;
  }

  const outside = reachResult.outside;
  if (outside.length === 0) {
    el.innerHTML =
      `<span class="none">All ${reachResult.totalBiomes} biomes are reachable and can cycle.</span>` +
      caveat(reachResult);
    return;
  }

  const list = document.createElement('ul');
  for (const o of outside) {
    const biome = meta.biomes.find((b) => b.key === o.key);
    const li = document.createElement('li');
    const swatch = document.createElement('i');
    swatch.style.background = biome ? biome.hex : '#000';
    const name = document.createElement('b');
    name.textContent = biome ? biome.name : o.key;
    const why = document.createElement('span');
    // Three different statements, and conflating them would be the easy mistake:
    // "nothing can make it" is not "nothing can unmake it", and a biome can be outside
    // the main cycle while both entering and leaving — soil on a still world is reachable
    // only from lava and ash, which that world cannot make either.
    why.textContent =
      o.inEdges === 0
        ? 'nothing here creates it'
        : o.outEdges === 0
          ? 'permanent once formed'
          : 'off the main cycle';
    li.append(swatch, name, why);
    list.append(li);
  }

  el.innerHTML = `<b>${outside.length}</b> of ${reachResult.totalBiomes} biomes cannot take part:`;
  el.append(list);
  el.insertAdjacentHTML('beforeend', caveat(reachResult));
}

function caveat(result) {
  return (
    '<p class="caveat">Measured from the transition ruleset restricted to the flags these ' +
    `cycle KINDS can raise (${result.core.length}/${result.totalBiomes} in the core, ` +
    `${result.liveEdges} live edges${
      result.allowedFlagNames.length ? `, flags: ${result.allowedFlagNames.join(' ')}` : ', no flags'
    }). Parameter values are not modelled, so “cannot” is a hard fact and “can” is a ` +
    'possibility. Worldgen may still seed a biome at day 0; if nothing here creates it, ' +
    'it does not come back.</p>'
  );
}

async function analyse() {
  const key = kindKey();
  // Capture the set ONCE. Re-reading composedSpecs() on each poll would start computing
  // whatever is on screen now while the completion is still labelled with the key taken
  // at the start — edit the kinds mid-sweep and revert before it finishes, and the panel
  // shows one set's result under another set's name.
  const specs = composedSpecs();
  reachPending = true;
  reachProgress = null;
  paintReach();
  try {
    for (;;) {
      const res = await fetch('/api/reachability', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cycles: specs }),
      });
      const body = await res.json();
      if (!res.ok || body.ok !== true) {
        reachPending = false;
        showMessage(body.error ?? `reachability ${res.status}`);
        paintReach();
        return;
      }
      if (body.ready === true) {
        reachPending = false;
        reachResult = { ...body.core, totalBiomes: body.totalBiomes };
        reachKey = key;
        paintReach();
        return;
      }
      reachProgress = body.progress;
      paintReach();
      await new Promise((r) => setTimeout(r, 400));
    }
  } catch (err) {
    reachPending = false;
    paintReach();
    noteFailure(err);
  }
}

// ---------------------------------------------------------------------------
// Hover readout
// ---------------------------------------------------------------------------

/**
 * Nearest hex centre wins. The Voronoi cell of a hex-grid centre IS the hex, so
 * checking the 3×3 block of candidates around the arithmetic guess is exact, not an
 * approximation — and it avoids the axial-rounding dance entirely.
 */
function tileAt(px, py) {
  const { w, h, hexW, rowStep, hexR, cx, cy } = geom;
  const guessRow = Math.round((py - hexR) / rowStep);
  let best = -1;
  let bestD = Infinity;

  for (let dr = -1; dr <= 1; dr++) {
    const row = guessRow + dr;
    if (row < 0 || row >= h) continue;
    const guessCol = Math.round((px - hexW / 2) / hexW - (row & 1) * 0.5);
    for (let dc = -1; dc <= 1; dc++) {
      const col = guessCol + dc;
      if (col < 0 || col >= w) continue;
      const i = row * w + col;
      const d = (cx[i] - px) ** 2 + (cy[i] - py) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
  }
  return best;
}

let hovered = -1;

function paintReadout() {
  const el = $('readout');
  if (hovered < 0 || biome === null) {
    el.className = 'readout empty';
    el.textContent = 'hover the map';
    return;
  }
  const b = meta.biomes[biome[hovered]];
  const col = hovered % geom.w;
  const row = Math.floor(hovered / geom.w);
  el.className = 'readout';
  el.innerHTML =
    `<span class="swatch" style="background:${b.hex}"></span>` +
    `<b>${b.name}</b>` +
    `<span class="sep">·</span>col <b>${col}</b> row <b>${row}</b>` +
    `<span class="sep">·</span>moisture <b>${moisture[hovered]}</b>` +
    `<span class="sep">·</span>glyph <b>${b.glyph}</b>` +
    `<span class="sep">·</span>${b.key}`;
}

canvas.addEventListener('mousemove', (e) => {
  if (geom === null) return;
  const r = canvas.getBoundingClientRect();
  hovered = tileAt(e.clientX - r.left, e.clientY - r.top);
  paintReadout();
});

canvas.addEventListener('mouseleave', () => {
  hovered = -1;
  paintReadout();
});

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

/**
 * Send a control action.
 *
 * Returns whether it succeeded, and surfaces the server's message in the panel rather
 * than only in the console. That is not politeness: the size and cycle validation lives
 * on the server and its whole purpose is to say WHY a world was refused, which is
 * useless if the only place it lands is devtools.
 */
async function control(body) {
  try {
    const res = await fetch('/api/control', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showMessage(err.error ?? `the server refused that (${res.status})`);
      return false;
    }
    setOffline(false);
    await refresh();
    return true;
  } catch (err) {
    // With the server gone, Play and Step used to do nothing at all, silently.
    noteFailure(err);
    return false;
  }
}

$('play').addEventListener('click', () =>
  control({ action: status !== null && status.playing ? 'pause' : 'play' }),
);
$('step').addEventListener('click', () => control({ action: 'step', days: 1 }));
$('step10').addEventListener('click', () => control({ action: 'step', days: 10 }));

$('speed').addEventListener('input', (e) => {
  $('speed-value').textContent = e.target.value;
});
$('speed').addEventListener('change', (e) => control({ action: 'speed', speed: Number(e.target.value) }));

/**
 * Regenerate: apply the composed cycle set AND the size in one build.
 *
 * Both at once on purpose — they are the same decision. A resize changes what every
 * cycle's geometry means (a monsoon's travel is the whole torus, a fault's slope is
 * width/height), so applying one without the other would show a world nobody described.
 */
$('reset').addEventListener('click', async () => {
  showMessage(null);
  const ok = await control({
    action: 'reset',
    seed: Number($('seed').value),
    width: Number($('width').value),
    height: Number($('height').value),
    cycles: composedSpecs(),
    preset: presetLabel(),
  });
  if (!ok) return;
  // The world now IS what the form says, so the pending-edit flag has served its purpose
  // and the panel goes back to mirroring the server.
  formDirty = false;
  syncComposerFromServer();
  showMessage(
    `built ${status.width}×${status.height} · ${status.cycles.length} cycles · seed ${status.seed}`,
    true,
  );
});

$('load-preset').addEventListener('click', () => {
  const name = $('preset').value;
  const specs = meta.presetCycles[name];
  if (specs === undefined) return;
  formDirty = true;
  openCards.clear();
  // Deep-copied: the composer edits its own objects, never meta's.
  composed = specs.map((s) => instanceFromSpec(JSON.parse(JSON.stringify(s))));
  renderComposer();
  showMessage(
    `loaded "${name}" into the composer — nothing is built until you press Regenerate.`,
    true,
  );
});

$('analyse').addEventListener('click', () => analyse());

for (const id of ['width', 'height', 'seed']) {
  $(id).addEventListener('input', () => {
    formDirty = true;
    paintCost();
  });
}

$('zoom').addEventListener('input', (e) => {
  $('zoom-value').textContent = e.target.value;
  geomDirty = true;
  render();
  paintPanel();
});

document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (e.code === 'Space') {
    e.preventDefault();
    control({ action: status !== null && status.playing ? 'pause' : 'play' });
  } else if (e.code === 'ArrowRight') {
    e.preventDefault();
    control({ action: 'step', days: e.shiftKey ? 10 : 1 });
  }
});

// ---------------------------------------------------------------------------
// Connection state
// ---------------------------------------------------------------------------

/**
 * The client had exactly one failure state — `boot()` replacing the page — and lost it
 * the moment startup succeeded. After that, a dead server produced a console.error every
 * 500 ms behind a panel that still showed numbers, and Play, Step and Regenerate did
 * nothing without saying so.
 *
 * Three consecutive failures rather than one, because a single miss is what a
 * Regenerate at 262,144 tiles looks like from here: the server is busy building, not
 * gone. Polling slows to 2 s while offline so a dead server is not hammered, and the
 * first success clears the banner.
 */
const OFFLINE_AFTER = 3;
let failures = 0;
let offline = false;

function setOffline(value) {
  if (value === false) failures = 0;
  if (value === offline) return;
  offline = value;
  $('offline').hidden = !value;
}

function noteFailure(err) {
  failures++;
  if (failures >= OFFLINE_AFTER) setOffline(true);
  // Kept, but no longer the only evidence anything is wrong.
  console.error('viewer request failed', err);
}

// ---------------------------------------------------------------------------
// Poll loop
// ---------------------------------------------------------------------------

/**
 * Chained rather than intervalled, so a slow frame delays the next request instead of
 * queueing behind it. The cadence tracks playback speed: there is no point asking for
 * frames faster than the server produces days.
 */
async function loop() {
  try {
    await refresh();
    setOffline(false);
  } catch (err) {
    noteFailure(err);
  }
  const delay = offline
    ? 2000
    : status !== null && status.playing
      ? Math.max(60, Math.min(500, 1000 / status.speed))
      : 500;
  setTimeout(loop, delay);
}

async function boot() {
  meta = await (await fetch('/api/meta')).json();

  const select = $('preset');
  for (const key of meta.presets) {
    const option = document.createElement('option');
    option.value = key;
    option.textContent = key;
    select.append(option);
  }

  await fetchFrame();
  select.value = meta.presets.includes(status.preset) ? status.preset : meta.presets[0];
  $('seed').value = String(status.seed);
  $('width').value = String(status.width);
  $('height').value = String(status.height);
  $('speed').value = String(status.speed);
  $('speed-value').textContent = String(status.speed);
  $('width').max = String(meta.limits.maxSide);
  $('height').max = String(meta.limits.maxSide);
  $('width').min = String(meta.limits.minWidth);
  $('height').min = String(meta.limits.minHeight);
  // Width has no step: any width from minWidth up is legal since the sweep evaluates
  // whatever is left in the revolution. Height keeps step="2" — the torus needs it even.

  renderAddRow();
  syncComposerFromServer();

  render();
  paintPanel();
  loop();
}

boot().catch((err) => {
  console.error(err);
  document.body.innerHTML = `<pre style="padding:20px;color:#cf5f5f">viewer failed to start\n\n${err}</pre>`;
});
