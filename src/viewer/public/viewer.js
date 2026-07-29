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
 * Draw a set of tiles, bucketed by biome so `fillStyle` is set 22 times per frame
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

async function refresh() {
  await fetchFrame();
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
  // truth for seed and preset, not the boxes — a second tab, or a restart against a
  // session already running, would otherwise show controls that describe nothing.
  // Skipped while focused, so it cannot rewrite a value mid-edit.
  syncField($('seed'), String(status.seed));
  syncField($('preset'), status.preset);
  syncField($('speed'), String(status.speed));
  if (document.activeElement !== $('speed')) $('speed-value').textContent = String(status.speed);

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

async function control(body) {
  const res = await fetch('/api/control', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    console.error('control failed', err);
  }
  await refresh();
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

$('reset').addEventListener('click', () =>
  control({ action: 'reset', seed: Number($('seed').value), preset: $('preset').value }),
);

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
  } catch (err) {
    console.error('refresh failed', err);
  }
  const delay =
    status !== null && status.playing
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
  select.value = status.preset;
  $('seed').value = String(status.seed);
  $('speed').value = String(status.speed);
  $('speed-value').textContent = String(status.speed);

  render();
  paintPanel();
  loop();
}

boot().catch((err) => {
  console.error(err);
  document.body.innerHTML = `<pre style="padding:20px;color:#cf5f5f">viewer failed to start\n\n${err}</pre>`;
});
