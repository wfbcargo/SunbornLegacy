/* Caravan manager client — plain JS, no build step. */

/** @type {any} */
let state = null;
/** @type {string | null} */
let selectedInstanceId = null;
/** @type {string | null} */
let selectedCatalogId = null;
/** Draft waypoints including current tile as [0] when plotting. */
/** @type {{col:number,row:number}[]} */
let draftPath = [];

/** @type {{ holdId: string, materialId: string } | null} */
let invSource = null;
/** @type {string | null} hold id or 'loose' */
let invDest = null;

/** @type {string | null} */
let deploySelectedCharId = null;

const MODES = ['map', 'outfit', 'stations', 'inventory', 'deploy', 'investigate'];
/** @type {string} */
let activeMode = 'map';

const el = {
  catalog: document.getElementById('catalog'),
  bench: document.getElementById('bench'),
  slots: document.getElementById('slot-groups'),
  stats: document.getElementById('stats'),
  chassis: document.getElementById('chassis-name'),
  vehicleId: document.getElementById('vehicle-id'),
  selection: document.getElementById('selection'),
  error: document.getElementById('error'),
  shellError: document.getElementById('shell-error'),
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
  modeNav: document.getElementById('mode-nav'),
  stationList: document.getElementById('station-list'),
  characterRoster: document.getElementById('character-roster'),
  stationAssignStatus: document.getElementById('station-assign-status'),
  stationUnassign: document.getElementById('station-unassign'),
  feedSelected: document.getElementById('feed-selected'),
  inventoryPanes: document.getElementById('inventory-panes'),
  transferGo: document.getElementById('transfer-go'),
  transferQty: document.getElementById('transfer-qty'),
  transferStatus: document.getElementById('transfer-status'),
  deployRoster: document.getElementById('deploy-roster'),
  deployGrid: document.getElementById('deploy-grid'),
  deployStatus: document.getElementById('deploy-status'),
  deployClear: document.getElementById('deploy-clear'),
  deploySkirmish: document.getElementById('deploy-skirmish'),
  skirmishResult: document.getElementById('skirmish-result'),
  investigateTile: document.getElementById('investigate-tile'),
  surveyStart: document.getElementById('survey-start'),
  surveyCancel: document.getElementById('survey-cancel'),
  surveyReason: document.getElementById('survey-reason'),
  surveyProgress: document.getElementById('survey-progress'),
  surveyProgressLabel: document.getElementById('survey-progress-label'),
};

const mapCtx = el.map.getContext('2d');

function showError(msg) {
  const outfitMode = activeMode === 'outfit';
  if (!msg) {
    el.error.hidden = true;
    el.error.textContent = '';
    el.shellError.hidden = true;
    el.shellError.textContent = '';
    return;
  }
  if (outfitMode) {
    el.error.hidden = false;
    el.error.textContent = msg;
    el.shellError.hidden = true;
    el.shellError.textContent = '';
  } else {
    el.shellError.hidden = false;
    el.shellError.textContent = msg;
    el.error.hidden = true;
    el.error.textContent = '';
  }
}

function setMode(mode) {
  if (!MODES.includes(mode)) mode = 'map';
  activeMode = mode;
  for (const m of MODES) {
    const panel = document.getElementById(`mode-${m}`);
    if (panel) panel.hidden = m !== mode;
  }
  for (const btn of el.modeNav.querySelectorAll('.mode-tab')) {
    btn.classList.toggle('active', btn.getAttribute('data-mode') === mode);
  }
  const hash = `#${mode}`;
  if (location.hash !== hash) {
    history.replaceState(null, '', hash);
  }
  if (state) render();
}

function modeFromHash() {
  const raw = (location.hash || '').replace(/^#/, '');
  return MODES.includes(raw) ? raw : 'map';
}

el.modeNav.addEventListener('click', (ev) => {
  const btn = ev.target.closest('.mode-tab');
  if (!btn) return;
  const mode = btn.getAttribute('data-mode');
  if (mode) setMode(mode);
});

window.addEventListener('hashchange', () => {
  setMode(modeFromHash());
});

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

function listFittedByKind(kind) {
  /** @type {any[]} */
  const out = [];
  for (const v of state.caravan.vehicles) {
    for (const s of v.slots) {
      if (s.occupant && s.occupant.kind === kind) {
        out.push({ slot: s, occupant: s.occupant, vehicleId: v.id });
      }
    }
  }
  return out;
}

function tileKey(t) {
  return `${t.col},${t.row}`;
}

function renderStats() {
  const s = state.caravan.stats;
  const p = state.caravan.position;
  const speed = s.ticksPerTile == null ? 'immobile' : `${s.ticksPerTile} ticks/tile`;
  const loose = (state.caravan.loose || [])
    .map((x) => `${x.qty} ${x.materialId}`)
    .join(', ') || 'none';
  let soonest = null;
  for (const v of state.caravan.vehicles) {
    for (const slot of v.slots) {
      const o = slot.occupant;
      if (o && o.kind === 'character' && o.satedUntilStep != null) {
        if (soonest == null || o.satedUntilStep < soonest) soonest = o.satedUntilStep;
      }
    }
  }
  const hunger =
    soonest == null
      ? 'n/a'
      : soonest <= state.step
        ? 'STARVING'
        : `${soonest - state.step} steps`;
  const tileInfo = state.tile || tileAt(p.tile.col, p.tile.row) || {};
  el.stats.textContent =
    `form  ${s.form} · mobile ${s.mobile}\n` +
    `speed  ${speed}\n` +
    `pos  ${tileKey(p.tile)} · travelling ${p.travelling}\n` +
    `biome  ${tileInfo.biome || '?'} · fertility ${tileInfo.fertility ?? '?'}\n` +
    `step  ${state.step}\n` +
    `chars ${s.characterCount} · stations ${s.stationCount}` +
    ` (${s.staffedStationCount ?? 0} staffed)\n` +
    `food  ${hunger}\n` +
    `loose  ${loose}`;
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

function biomeFill(tile) {
  if (!tile || !tile.passable) return '#6a8499';
  const f = tile.fertility ?? 0;
  if (f >= 3) return '#7a9b5a';
  if (f === 2) return '#9bb56e';
  if (f === 1) return '#c4b48a';
  return '#b8a078';
}

function tileAt(col, row) {
  const tiles = state.map?.tiles;
  if (!tiles) return null;
  return tiles.find((t) => t.col === col && t.row === row) || null;
}

function renderMap() {
  const width = state.map.width;
  const height = state.map.height;
  const size = mapHexSize();
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
      const info = tileAt(col, row);
      let fill = biomeFill(info);
      if (committed.has(key)) fill = '#c5d4a8';
      if (neighbourSet.has(key) && draftPath.length === 0) fill = '#d7e6c4';
      if (draftSet.has(key)) fill = '#f0d58a';
      if (pos.col === col && pos.row === row) fill = '#3d6b4f';
      drawHex(ctx, x, y, size * 0.92, fill, '#8f9d7c');
      ctx.fillStyle = pos.col === col && pos.row === row ? '#f4f7ef' : '#3a4538';
      ctx.font = `${Math.max(7, size * 0.45)}px IBM Plex Mono, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(info?.glyph || `${col},${row}`, x, y);
    }
  }
}

function mapHexSize() {
  const width = state.map.width;
  return Math.max(8, Math.min(18, Math.floor(620 / (width * 1.15))));
}

function hitTile(mx, my) {
  const width = state.map.width;
  const height = state.map.height;
  const size = mapHexSize();
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

function wrapCoord(v, span) {
  return ((v % span) + span) % span;
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
  const w = state.map.width;
  const h = state.map.height;
  for (const [dc, dr] of deltas) {
    out.push({
      col: wrapCoord(t.col + dc, w),
      row: wrapCoord(t.row + dr, h),
    });
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
  const info = tileAt(hit.col, hit.row);
  if (info && !info.passable) {
    showError(`Impassable (${info.biome}).`);
    return;
  }

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
    if (item.equipSlot) continue;
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

function assignmentMap() {
  /** @type {Map<string, string>} character -> station */
  const byChar = new Map();
  /** @type {Map<string, string>} station -> character */
  const byStation = new Map();
  for (const a of state.caravan.assignments || []) {
    byChar.set(a.characterInstanceId, a.stationInstanceId);
    byStation.set(a.stationInstanceId, a.characterInstanceId);
  }
  return { byChar, byStation };
}

function findName(instanceId) {
  const o = findFitted(instanceId);
  return o ? o.name : instanceId;
}

function updateStationAssignStatus() {
  const { byChar, byStation } = assignmentMap();
  const char = stationSelectedCharId
    ? listFittedByKind('character').find((x) => x.occupant.instanceId === stationSelectedCharId)
    : null;
  const st = stationSelectedStationId
    ? listFittedByKind('station').find((x) => x.occupant.instanceId === stationSelectedStationId)
    : null;

  const linked =
    stationSelectedCharId &&
    stationSelectedStationId &&
    byChar.get(stationSelectedCharId) === stationSelectedStationId;

  el.stationUnassign.hidden = !linked;
  el.feedSelected.hidden = !stationSelectedCharId;

  if (char && st) {
    if (linked) {
      el.stationAssignStatus.textContent =
        `${char.occupant.name} staffs ${st.occupant.name} — Unassign, or pick others.`;
      return;
    }
    el.stationAssignStatus.textContent =
      `Ready to assign ${char.occupant.name} → ${st.occupant.name}.`;
    return;
  }
  if (char) {
    const stationId = byChar.get(char.occupant.instanceId);
    el.stationAssignStatus.textContent = stationId
      ? `${char.occupant.name} staffs ${findName(stationId)} — pick a station to reassign after unassign.`
      : `Selected ${char.occupant.name} — click a station to assign.`;
    return;
  }
  if (st) {
    const charId = byStation.get(st.occupant.instanceId);
    el.stationAssignStatus.textContent = charId
      ? `${st.occupant.name} staffed by ${findName(charId)}.`
      : `Selected ${st.occupant.name} — click a character, then this station.`;
    return;
  }
  el.stationAssignStatus.textContent = 'Select a character, then a station.';
}

async function tryAssignSelected() {
  if (!stationSelectedCharId || !stationSelectedStationId) return;
  const { byChar } = assignmentMap();
  if (byChar.get(stationSelectedCharId) === stationSelectedStationId) {
    updateStationAssignStatus();
    return;
  }
  showError('');
  try {
    const data = await api('/api/assign', {
      characterInstanceId: stationSelectedCharId,
      stationInstanceId: stationSelectedStationId,
    });
    await applyState(data);
  } catch (err) {
    showError(err.message);
  }
}

function renderStations() {
  const stations = listFittedByKind('station');
  const chars = listFittedByKind('character');
  const { byChar, byStation } = assignmentMap();
  el.stationList.innerHTML = '';
  el.characterRoster.innerHTML = '';

  if (!stations.length) {
    const p = document.createElement('p');
    p.className = 'selection';
    p.textContent = 'No stations fitted.';
    el.stationList.appendChild(p);
  } else {
    for (const { occupant, slot } of stations) {
      const staffId = byStation.get(occupant.instanceId);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className =
        'card' + (stationSelectedStationId === occupant.instanceId ? ' selected' : '');
      const staffLabel = staffId
        ? `staffed by ${findName(staffId)}`
        : 'unstaffed';
      btn.innerHTML =
        `<div class="name">${escapeHtml(occupant.name)}</div>` +
        `<div class="meta">${escapeHtml(slot.label)} · ${escapeHtml(staffLabel)}</div>`;
      btn.addEventListener('click', async () => {
        stationSelectedStationId = occupant.instanceId;
        if (stationSelectedCharId) {
          await tryAssignSelected();
        } else {
          updateStationAssignStatus();
          renderStations();
        }
      });
      el.stationList.appendChild(btn);
    }
  }

  if (!chars.length) {
    const p = document.createElement('p');
    p.className = 'selection';
    p.textContent = 'No characters fitted.';
    el.characterRoster.appendChild(p);
  } else {
    for (const { occupant, slot } of chars) {
      const stationId = byChar.get(occupant.instanceId);
      const sated = occupant.satedUntilStep;
      const foodMeta =
        sated == null
          ? ''
          : sated <= state.step
            ? ' · HUNGRY'
            : ` · food ${sated - state.step} steps`;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className =
        'card' + (stationSelectedCharId === occupant.instanceId ? ' selected' : '');
      btn.innerHTML =
        `<div class="name">${escapeHtml(occupant.name)}</div>` +
        `<div class="meta">${escapeHtml(slot.label)}` +
        (stationId ? ` · → ${escapeHtml(findName(stationId))}` : ' · free') +
        `${escapeHtml(foodMeta)}</div>`;
      btn.addEventListener('click', () => {
        stationSelectedCharId = occupant.instanceId;
        updateStationAssignStatus();
        renderStations();
      });
      el.characterRoster.appendChild(btn);
    }
  }

  updateStationAssignStatus();
}

el.stationUnassign.addEventListener('click', async () => {
  if (!stationSelectedCharId && !stationSelectedStationId) return;
  showError('');
  try {
    const data = await api('/api/unassign', {
      characterInstanceId: stationSelectedCharId || undefined,
      stationInstanceId: stationSelectedStationId || undefined,
    });
    await applyState(data);
  } catch (err) {
    showError(err.message);
  }
});

el.feedSelected.addEventListener('click', async () => {
  if (!stationSelectedCharId) return;
  showError('');
  try {
    const data = await api('/api/feed', {
      characterInstanceId: stationSelectedCharId,
      qty: 1,
      step: state.step,
    });
    await applyState(data);
  } catch (err) {
    showError(err.message);
  }
});

function updateTransferChrome() {
  const qty = Number(el.transferQty.value);
  const ready =
    invSource &&
    invDest &&
    invSource.holdId !== invDest &&
    Number.isFinite(qty) &&
    qty >= 1;
  el.transferGo.disabled = !ready;
  if (!invSource) {
    el.transferStatus.textContent = 'Select a source stack.';
    return;
  }
  if (!invDest) {
    el.transferStatus.textContent =
      `Source ${invSource.materialId} @ ${invSource.holdId} — pick a destination.`;
    return;
  }
  if (invSource.holdId === invDest) {
    el.transferStatus.textContent = 'Source and destination must differ.';
    return;
  }
  el.transferStatus.textContent =
    `Transfer ${qty} ${invSource.materialId}: ${invSource.holdId} → ${invDest}`;
}

function renderInventory() {
  const holds = state.caravan.holds || [];
  const loose = state.caravan.loose || [];
  el.inventoryPanes.innerHTML = '';

  function addPane(holdId, title, meta, stacks, isChest) {
    const pane = document.createElement('div');
    pane.className =
      'cargo-pane' +
      (isChest ? ' chest' : '') +
      (invDest === holdId ? ' selected-dest' : '');
    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'pane-dest';
    head.innerHTML =
      `<div class="pane-title">${escapeHtml(title)}</div>` +
      `<div class="pane-meta">${escapeHtml(meta)}</div>`;
    head.addEventListener('click', () => {
      invDest = holdId;
      updateTransferChrome();
      renderInventory();
    });
    pane.appendChild(head);

    if (!stacks.length) {
      const empty = document.createElement('p');
      empty.className = 'empty-stacks';
      empty.textContent = 'Empty';
      pane.appendChild(empty);
    } else {
      const list = document.createElement('div');
      list.className = 'item-list';
      for (const s of stacks) {
        const btn = document.createElement('button');
        btn.type = 'button';
        const selected =
          invSource &&
          invSource.holdId === holdId &&
          invSource.materialId === s.materialId;
        btn.className = 'card' + (selected ? ' selected' : '');
        btn.innerHTML =
          `<div class="name">${escapeHtml(s.materialId)}</div>` +
          `<div class="meta">${s.qty}</div>`;
        btn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          invSource = { holdId, materialId: s.materialId };
          el.transferQty.value = String(Math.min(s.qty, Number(el.transferQty.value) || 1));
          el.transferQty.max = String(s.qty);
          updateTransferChrome();
          renderInventory();
        });
        list.appendChild(btn);
      }
      pane.appendChild(list);
    }
    el.inventoryPanes.appendChild(pane);
  }

  for (const h of holds) {
    const occ = findFitted(h.stationInstanceId);
    const title = occ ? occ.name : h.stationInstanceId;
    const isChest = occ?.catalogId === 'cargo_chest';
    addPane(h.stationInstanceId, title, h.stationInstanceId, h.stacks, isChest);
  }

  addPane('loose', 'Loose', 'not in a hold', loose, false);

  if (!holds.length && !loose.length) {
    const p = document.createElement('p');
    p.className = 'selection';
    p.textContent = 'No cargo yet — fit a cargo chest and deposit goods.';
    el.inventoryPanes.appendChild(p);
  }

  updateTransferChrome();
}

el.transferGo.addEventListener('click', async () => {
  if (!invSource || !invDest) return;
  const qty = Math.floor(Number(el.transferQty.value));
  showError('');
  try {
    const data = await api('/api/transfer', {
      from: invSource.holdId,
      to: invDest,
      materialId: invSource.materialId,
      qty,
    });
    invSource = null;
    await applyState(data);
  } catch (err) {
    showError(err.message);
  }
});

el.transferQty.addEventListener('input', updateTransferChrome);

function cellKey(col, row) {
  return `${col},${row}`;
}

function deployPlacementMap() {
  /** @type {Record<string, string>} */
  const map = {};
  const list = state?.caravan?.deploy?.placements || [];
  for (const p of list) {
    map[p.characterInstanceId] = cellKey(p.col, p.row);
  }
  return map;
}

function occupantAtCell(col, row) {
  const key = cellKey(col, row);
  const list = state?.caravan?.deploy?.placements || [];
  for (const p of list) {
    if (cellKey(p.col, p.row) === key) return p.characterInstanceId;
  }
  return null;
}

function pruneDeploySelection() {
  const living = new Set(listFittedByKind('character').map((x) => x.occupant.instanceId));
  if (deploySelectedCharId && !living.has(deploySelectedCharId)) {
    deploySelectedCharId = null;
  }
}

function updateDeployStatus() {
  const placements = deployPlacementMap();
  if (deploySelectedCharId) {
    const o = findFitted(deploySelectedCharId);
    const where = placements[deploySelectedCharId];
    el.deployStatus.textContent = o
      ? where
        ? `${o.name} at ${where} — click another cell to move, or Clear.`
        : `${o.name} selected — click a deploy cell.`
      : 'Selected character missing.';
    return;
  }
  const n = state?.caravan?.deploy?.placements?.length ?? 0;
  el.deployStatus.textContent =
    n > 0
      ? `${n} placed — select a character or Run skirmish.`
      : 'Select a character, then a deploy cell.';
}

function renderDeploy() {
  if (!state) return;
  pruneDeploySelection();
  const placements = deployPlacementMap();
  const chars = listFittedByKind('character');
  el.deployRoster.innerHTML = '';
  if (!chars.length) {
    const p = document.createElement('p');
    p.className = 'selection';
    p.textContent = 'No characters fitted.';
    el.deployRoster.appendChild(p);
  } else {
    for (const { occupant } of chars) {
      const placed = placements[occupant.instanceId];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className =
        'card' +
        (deploySelectedCharId === occupant.instanceId ? ' selected' : '') +
        (placed ? ' placed' : '');
      btn.innerHTML =
        `<div class="name">${escapeHtml(occupant.name)}</div>` +
        `<div class="meta">${escapeHtml(occupant.instanceId)}${placed ? ` · ${escapeHtml(placed)}` : ''}</div>`;
      btn.addEventListener('click', () => {
        deploySelectedCharId = occupant.instanceId;
        updateDeployStatus();
        renderDeploy();
      });
      el.deployRoster.appendChild(btn);
    }
  }

  el.deployGrid.innerHTML = '';
  for (let row = 0; row < 6; row++) {
    for (let col = 0; col < 4; col++) {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'deploy-cell';
      const occId = occupantAtCell(col, row);
      const occ = occId ? findFitted(occId) : null;
      if (occ) {
        cell.classList.add('occupied');
        cell.textContent = occ.name.slice(0, 8);
        cell.title = `${occ.name} @ ${col},${row}`;
      } else {
        cell.textContent = `${col},${row}`;
      }
      cell.addEventListener('click', async () => {
        if (!deploySelectedCharId) {
          if (occId) {
            deploySelectedCharId = occId;
            updateDeployStatus();
            renderDeploy();
          }
          return;
        }
        try {
          const data = await api('/api/deploy', {
            characterInstanceId: deploySelectedCharId,
            col,
            row,
          });
          await applyState(data);
        } catch (err) {
          showError(err.message || String(err));
        }
      });
      el.deployGrid.appendChild(cell);
    }
  }
  updateDeployStatus();
  if (el.deploySkirmish) {
    el.deploySkirmish.disabled = !(state.caravan.deploy?.placements?.length > 0);
  }
}

el.deployClear.addEventListener('click', async () => {
  try {
    const data = await api('/api/deploy/clear', {});
    deploySelectedCharId = null;
    if (el.skirmishResult) el.skirmishResult.textContent = '';
    await applyState(data);
  } catch (err) {
    showError(err.message || String(err));
  }
});

el.deploySkirmish?.addEventListener('click', async () => {
  try {
    showError('');
    const data = await api('/api/skirmish', {});
    await applyState(data);
    const s = data.skirmish;
    if (s && el.skirmishResult) {
      el.skirmishResult.textContent =
        `outcome ${s.outcome} · rounds ${s.roundsPlayed} · ` +
        `alive A ${s.aliveA} / B ${s.aliveB}` +
        (s.summary?.[0] ? `\n${s.summary[0]}` : '');
    }
  } catch (err) {
    showError(err.message || String(err));
  }
});

function renderInvestigate() {
  if (!state) return;
  const p = state.caravan.position;
  const s = state.caravan.stats;
  const act = state.caravan.activity;
  const idle = !p.travelling;
  const mobile = s.mobile;
  const active = !!act;

  el.investigateTile.textContent =
    `tile  ${tileKey(p.tile)}\n` +
    `form  ${s.form}\n` +
    `travelling  ${p.travelling}\n` +
    `mobile  ${mobile}\n` +
    `step  ${state.step}` +
    (active
      ? `\nactivity  ${act.kind} @${tileKey(act.tile)} from step ${act.startStep}`
      : '');

  el.surveyStart.disabled = active || !idle || !mobile || s.characterCount < 1;
  el.surveyCancel.disabled = !active;

  if (active) {
    const elapsed = act.elapsed;
    const dur = act.durationTicks;
    const pct = Math.round(act.fraction * 100);
    el.surveyProgress.style.width = `${pct}%`;
    if (el.surveyProgressLabel) {
      el.surveyProgressLabel.textContent = `${elapsed} / ${dur} ticks`;
    }
    el.surveyReason.textContent = act.done
      ? 'Survey complete — advance step if notes have not deposited yet.'
      : `Surveying… ${elapsed}/${dur}. Travel, settle, or Cancel forfeits progress.`;
  } else {
    el.surveyProgress.style.width = '0%';
    if (el.surveyProgressLabel) {
      el.surveyProgressLabel.textContent = '0 / 100 ticks';
    }
    if (!mobile) {
      el.surveyReason.textContent = 'Settled outposts cannot survey; mobilise first.';
    } else if (!idle) {
      el.surveyReason.textContent = 'Arrive or stall before surveying.';
    } else if (s.characterCount < 1) {
      el.surveyReason.textContent = 'Need at least one fitted character to survey.';
    } else {
      el.surveyReason.textContent = 'Ready — start a 100-tick survey on this tile.';
    }
  }
}

el.surveyStart.addEventListener('click', async () => {
  try {
    const data = await api('/api/survey', { step: state.step });
    applyState(data);
  } catch (err) {
    showError(err.message || String(err));
  }
});

el.surveyCancel.addEventListener('click', async () => {
  try {
    const data = await api('/api/survey/cancel', {});
    applyState(data);
  } catch (err) {
    showError(err.message || String(err));
  }
});

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function render() {
  renderStats();
  if (activeMode === 'outfit' || activeMode === 'map') {
    // Keep outfit DOM fresh when switching back; map always needs redraw.
  }
  renderCatalog();
  renderBench();
  renderSlots();
  renderMap();
  updateSelectionLabel();
  renderStations();
  renderInventory();
  renderDeploy();
  renderInvestigate();
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
  if (data.collapsed) {
    showError('Outpost collapsed — last manager left. Station scrap refunded into cargo/loose.');
  }
  if (data.surveyCompleted) {
    showError('');
    el.surveyReason.textContent =
      `Survey complete on ${tileKey(data.surveyTile)} — survey_notes deposited.`;
  }
  render();
}

el.resetStart.addEventListener('click', async () => {
  showError('');
  selectedInstanceId = null;
  selectedCatalogId = null;
  draftPath = [];
  stationSelectedCharId = null;
  stationSelectedStationId = null;
  invSource = null;
  invDest = null;
  deploySelectedCharId = null;
  if (el.skirmishResult) el.skirmishResult.textContent = '';
  state = await api('/api/reset', { seed: 'lab' });
  render();
});

el.resetEmpty.addEventListener('click', async () => {
  showError('');
  selectedInstanceId = null;
  selectedCatalogId = null;
  draftPath = [];
  stationSelectedCharId = null;
  stationSelectedStationId = null;
  invSource = null;
  invDest = null;
  deploySelectedCharId = null;
  if (el.skirmishResult) el.skirmishResult.textContent = '';
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
    if (data.starved && data.starved.length) {
      showError(`Starved: ${data.starved.length} character(s) removed at step ${step}.`);
    } else if (data.produced > 0) {
      showError('');
    }
  } catch (err) {
    showError(err.message);
  }
});

setMode(modeFromHash());
refresh().catch((err) => showError(err.message));
