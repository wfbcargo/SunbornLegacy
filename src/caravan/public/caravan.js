/* Caravan lab client — plain JS, no build step. */

/** @type {any} */
let state = null;
/** @type {string | null} */
let selectedInstanceId = null;
/** @type {string | null} */
let selectedCatalogId = null;
/** Draft waypoints including current tile as [0] when plotting. */
/** @type {{col:number,row:number}[]} */
let draftPath = [];

const el = {
  catalog: document.getElementById('catalog'),
  bench: document.getElementById('bench'),
  slots: document.getElementById('slot-groups'),
  stats: document.getElementById('stats'),
  chassis: document.getElementById('chassis-name'),
  vehicleId: document.getElementById('vehicle-id'),
  selection: document.getElementById('selection'),
  error: document.getElementById('error'),
  resetStart: document.getElementById('reset-start'),
  resetEmpty: document.getElementById('reset-empty'),
  settle: document.getElementById('settle'),
  mobilise: document.getElementById('mobilise'),
  commitPath: document.getElementById('commit-path'),
  clearPath: document.getElementById('clear-path'),
  stall: document.getElementById('stall'),
  step: document.getElementById('step'),
  stepLabel: document.getElementById('step-label'),
  pathStatus: document.getElementById('path-status'),
  map: document.getElementById('map'),
};

const mapCtx = el.map.getContext('2d');

function showError(msg) {
  if (!msg) {
    el.error.hidden = true;
    el.error.textContent = '';
    return;
  }
  el.error.hidden = false;
  el.error.textContent = msg;
}

async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function kindMeta(item) {
  const parts = [item.kind];
  if (item.size) parts.push(item.size);
  if (item.tier && item.containerClass) parts.push(`${item.tier}/${item.containerClass}`);
  if (item.ticksPerTile != null) parts.push(`${item.ticksPerTile} ticks/tile`);
  return parts.join(' · ');
}

function updateSelectionLabel() {
  if (selectedInstanceId) {
    const o =
      state.bench.find((b) => b.instanceId === selectedInstanceId) ||
      findFitted(selectedInstanceId);
    el.selection.textContent = o
      ? `Selected: ${o.name} (${o.instanceId}) — click an empty slot to fit.`
      : 'Selected instance missing.';
    return;
  }
  if (selectedCatalogId) {
    const c = state.catalog.find((x) => x.id === selectedCatalogId);
    el.selection.textContent = c
      ? `Catalog primed: ${c.name} — click an empty matching slot to spawn+fit.`
      : 'Catalog selection missing.';
    return;
  }
  el.selection.textContent = 'Nothing selected. Click catalog to prime, or bench to select.';
}

function findFitted(instanceId) {
  for (const v of state.caravan.vehicles) {
    for (const s of v.slots) {
      if (s.occupant && s.occupant.instanceId === instanceId) return s.occupant;
    }
  }
  return null;
}

function tileKey(t) {
  return `${t.col},${t.row}`;
}

function renderStats() {
  const s = state.caravan.stats;
  const p = state.caravan.position;
  const speed = s.ticksPerTile == null ? 'immobile' : `${s.ticksPerTile} ticks/tile`;
  const scrap = (state.scrap || [])
    .map((x) => `${x.qty} ${x.materialId}`)
    .join(', ') || 'none';
  el.stats.textContent =
    `form  ${s.form} · mobile ${s.mobile}\n` +
    `speed  ${speed}\n` +
    `pos  ${tileKey(p.tile)} · travelling ${p.travelling}\n` +
    `step  ${state.step}\n` +
    `chars ${s.characterCount} · stations ${s.stationCount}\n` +
    `scrap  ${scrap}`;
  el.step.value = String(state.step);
  el.stepLabel.textContent = String(state.step);
  el.pathStatus.textContent = draftPath.length
    ? `draft ${draftPath.map(tileKey).join('→')}`
    : 'click a neighbour to start a route';
}

function hexCenter(col, row, size) {
  const w = Math.sqrt(3) * size;
  const h = 2 * size;
  const x = size * Math.sqrt(3) * (col + 0.5 * (row & 1)) + w * 0.55;
  const y = size * 1.5 * row + h * 0.55;
  return { x, y };
}

function drawHex(ctx, x, y, size, fill, stroke) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i - 30);
    const px = x + size * Math.cos(angle);
    const py = y + size * Math.sin(angle);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.2;
  ctx.stroke();
}

function renderMap() {
  const width = state.map.width;
  const height = state.map.height;
  const size = 22;
  const ctx = mapCtx;
  ctx.clearRect(0, 0, el.map.width, el.map.height);

  const pos = state.caravan.position.tile;
  const neighbourSet = new Set((state.neighbours || []).map(tileKey));
  const draftSet = new Set(draftPath.map(tileKey));
  const committed = new Set();
  for (const leg of state.caravan.legs || []) {
    for (const t of leg.tiles) committed.add(tileKey(t));
  }

  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const key = `${col},${row}`;
      const { x, y } = hexCenter(col, row, size);
      let fill = '#e7ecd9';
      if (committed.has(key)) fill = '#c5d4a8';
      if (neighbourSet.has(key) && draftPath.length === 0) fill = '#d7e6c4';
      if (draftSet.has(key)) fill = '#f0d58a';
      if (pos.col === col && pos.row === row) fill = '#3d6b4f';
      drawHex(ctx, x, y, size * 0.92, fill, '#8f9d7c');
      ctx.fillStyle = pos.col === col && pos.row === row ? '#f4f7ef' : '#5c6b58';
      ctx.font = '10px IBM Plex Mono, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${col},${row}`, x, y);
    }
  }
}

function hitTile(mx, my) {
  const width = state.map.width;
  const height = state.map.height;
  const size = 22;
  let best = null;
  let bestDist = Infinity;
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const { x, y } = hexCenter(col, row, size);
      const d = (mx - x) ** 2 + (my - y) ** 2;
      if (d < bestDist) {
        bestDist = d;
        best = { col, row };
      }
    }
  }
  if (bestDist > (size * 0.95) ** 2) return null;
  return best;
}

function isNeighbour(a, b) {
  return (state.neighbours || []).some((n) => n.col === b.col && n.row === b.row) ||
    // when drafting, check against last draft tile via server neighbour list only for current;
    // local odd-r check:
    localNeighbours(a).some((n) => n.col === b.col && n.row === b.row);
}

function localNeighbours(t) {
  const even = [
    [1, 0], [0, -1], [-1, -1], [-1, 0], [-1, 1], [0, 1],
  ];
  const odd = [
    [1, 0], [1, -1], [0, -1], [-1, 0], [0, 1], [1, 1],
  ];
  const deltas = (t.row & 1) ? odd : even;
  const out = [];
  for (const [dc, dr] of deltas) {
    const n = { col: t.col + dc, row: t.row + dr };
    if (
      n.col >= 0 && n.col < state.map.width &&
      n.row >= 0 && n.row < state.map.height
    ) out.push(n);
  }
  return out;
}

el.map.addEventListener('click', (ev) => {
  if (!state) return;
  const rect = el.map.getBoundingClientRect();
  const scaleX = el.map.width / rect.width;
  const scaleY = el.map.height / rect.height;
  const mx = (ev.clientX - rect.left) * scaleX;
  const my = (ev.clientY - rect.top) * scaleY;
  const hit = hitTile(mx, my);
  if (!hit) return;
  showError('');

  if (state.caravan.position.travelling) {
    showError('Still travelling — scrub to arrival or stall before plotting.');
    return;
  }
  if (!state.caravan.stats.mobile) {
    showError('Settled outposts cannot travel.');
    return;
  }

  if (draftPath.length === 0) {
    const cur = state.caravan.position.tile;
    if (hit.col === cur.col && hit.row === cur.row) return;
    if (!localNeighbours(cur).some((n) => n.col === hit.col && n.row === hit.row)) {
      showError('First waypoint must neighbour the current tile.');
      return;
    }
    draftPath = [{ ...cur }, { ...hit }];
  } else {
    const last = draftPath[draftPath.length - 1];
    if (hit.col === last.col && hit.row === last.row) return;
    if (!localNeighbours(last).some((n) => n.col === hit.col && n.row === hit.row)) {
      showError('Waypoint must neighbour the previous tile.');
      return;
    }
    draftPath.push({ ...hit });
  }
  render();
});

function renderCatalog() {
  el.catalog.innerHTML = '';
  for (const item of state.catalog) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'card' + (selectedCatalogId === item.id ? ' selected' : '');
    btn.innerHTML =
      `<div class="name">${escapeHtml(item.name)}</div>` +
      `<div class="meta">${escapeHtml(kindMeta(item))}</div>` +
      `<p class="blurb">${escapeHtml(item.blurb)}</p>`;
    btn.addEventListener('click', async () => {
      showError('');
      selectedInstanceId = null;
      selectedCatalogId = item.id;
      try {
        const data = await api('/api/spawn', { catalogId: item.id });
        state.bench = data.bench;
        selectedInstanceId = data.occupant.instanceId;
        selectedCatalogId = null;
        render();
      } catch (err) {
        showError(err.message);
        render();
      }
    });
    el.catalog.appendChild(btn);
  }
}

function renderBench() {
  el.bench.innerHTML = '';
  if (!state.bench.length) {
    const p = document.createElement('p');
    p.className = 'selection';
    p.textContent = 'Bench is empty.';
    el.bench.appendChild(p);
    return;
  }
  for (const o of state.bench) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'card' + (selectedInstanceId === o.instanceId ? ' selected' : '');
    btn.innerHTML =
      `<div class="name">${escapeHtml(o.name)}</div>` +
      `<div class="meta">${escapeHtml(kindMeta(o))} · ${escapeHtml(o.instanceId)}</div>`;
    btn.addEventListener('click', () => {
      selectedCatalogId = null;
      selectedInstanceId = o.instanceId;
      showError('');
      render();
    });
    el.bench.appendChild(btn);
  }
}

const GROUP_ORDER = ['mount', 'wheel', 'character', 'station'];

function renderSlots() {
  const vehicle = state.caravan.vehicles[0];
  el.chassis.textContent = vehicle.chassisName;
  el.vehicleId.textContent = `${vehicle.id} · ${vehicle.chassisId}`;
  el.slots.innerHTML = '';

  const byKind = new Map();
  for (const slot of vehicle.slots) {
    if (!byKind.has(slot.kind)) byKind.set(slot.kind, []);
    byKind.get(slot.kind).push(slot);
  }

  for (const kind of GROUP_ORDER) {
    const list = byKind.get(kind);
    if (!list) continue;
    const group = document.createElement('div');
    group.className = 'group';
    const h = document.createElement('h3');
    h.textContent = kind;
    group.appendChild(h);
    const grid = document.createElement('div');
    grid.className = 'slots';
    for (const slot of list) {
      const div = document.createElement('div');
      div.className = 'slot' + (slot.occupant ? ' filled' : '');
      const typing =
        slot.kind === 'station'
          ? `${slot.tier}/${slot.containerClass}`
          : slot.size || '';
      let body;
      if (slot.occupant) {
        const o = slot.occupant;
        const speed = o.ticksPerTile != null ? ` · ${o.ticksPerTile} t/tile` : '';
        body =
          `<div class="occ-name">${escapeHtml(o.name)}</div>` +
          `<div class="occ-meta">${escapeHtml(o.catalogId)}${escapeHtml(speed)}</div>`;
      } else {
        body = `<div class="empty">empty</div>`;
      }
      div.innerHTML =
        `<div class="label">${escapeHtml(slot.label)} · ${escapeHtml(typing)}</div>` + body;
      div.addEventListener('click', () => onSlotClick(vehicle.id, slot));
      grid.appendChild(div);
    }
    group.appendChild(grid);
    el.slots.appendChild(group);
  }
}

async function onSlotClick(vehicleId, slot) {
  showError('');
  try {
    if (slot.occupant) {
      const data = await api('/api/unfit', { vehicleId, slotIndex: slot.index });
      selectedInstanceId = slot.occupant.instanceId;
      selectedCatalogId = null;
      await applyState(data);
      return;
    }

    if (selectedInstanceId) {
      const data = await api('/api/fit', {
        vehicleId,
        slotIndex: slot.index,
        instanceId: selectedInstanceId,
      });
      selectedInstanceId = null;
      await applyState(data);
      return;
    }

    if (selectedCatalogId) {
      const data = await api('/api/fit', {
        vehicleId,
        slotIndex: slot.index,
        catalogId: selectedCatalogId,
      });
      selectedCatalogId = null;
      await applyState(data);
      return;
    }

    showError('Select a bench piece or spawn from the catalog first.');
  } catch (err) {
    showError(err.message);
    await refresh();
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function render() {
  renderStats();
  renderCatalog();
  renderBench();
  renderSlots();
  renderMap();
  updateSelectionLabel();
}

async function refresh() {
  state = await api('/api/state');
  render();
}

async function applyState(data) {
  if (data.step != null) state.step = data.step;
  if (data.map) state.map = data.map;
  if (data.neighbours) state.neighbours = data.neighbours;
  if (data.caravan) state.caravan = data.caravan;
  if (data.bench) state.bench = data.bench;
  if (data.catalog) state.catalog = data.catalog;
  if (data.scrap) state.scrap = data.scrap;
  if (data.collapsed) {
    showError('Outpost collapsed — last manager left. Station scrap refunded.');
  }
  render();
}

el.resetStart.addEventListener('click', async () => {
  showError('');
  selectedInstanceId = null;
  selectedCatalogId = null;
  draftPath = [];
  state = await api('/api/reset', { seed: 'lab' });
  render();
});

el.resetEmpty.addEventListener('click', async () => {
  showError('');
  selectedInstanceId = null;
  selectedCatalogId = null;
  draftPath = [];
  state = await api('/api/reset', { empty: true });
  render();
});

el.settle.addEventListener('click', async () => {
  showError('');
  try {
    const data = await api('/api/settle', { step: state.step });
    draftPath = [];
    await applyState(data);
  } catch (err) {
    showError(err.message);
  }
});

el.mobilise.addEventListener('click', async () => {
  showError('');
  try {
    const data = await api('/api/mobilise', {});
    await applyState(data);
  } catch (err) {
    showError(err.message);
  }
});

el.commitPath.addEventListener('click', async () => {
  showError('');
  if (draftPath.length < 2) {
    showError('Plot at least one destination hex first.');
    return;
  }
  try {
    const data = await api('/api/commit-leg', {
      tiles: draftPath,
      startStep: state.step,
    });
    draftPath = [];
    await applyState(data);
  } catch (err) {
    showError(err.message);
  }
});

el.clearPath.addEventListener('click', () => {
  draftPath = [];
  showError('');
  render();
});

el.stall.addEventListener('click', async () => {
  showError('');
  try {
    const data = await api('/api/stall', { step: state.step });
    draftPath = [];
    await applyState(data);
  } catch (err) {
    showError(err.message);
  }
});

el.step.addEventListener('input', async () => {
  const step = Number(el.step.value);
  try {
    const data = await api('/api/step', { step });
    await applyState(data);
  } catch (err) {
    showError(err.message);
  }
});

refresh().catch((err) => showError(err.message));
