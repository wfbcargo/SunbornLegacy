/* Battle lab client — plain JS, no build step. */

const ARENA_W = 10;

const el = {
  scenario: document.getElementById('scenario'),
  blurb: document.getElementById('blurb'),
  rosterA: document.getElementById('roster-a'),
  rosterB: document.getElementById('roster-b'),
  countA: document.getElementById('count-a'),
  countB: document.getElementById('count-b'),
  templateRack: document.getElementById('template-rack'),
  clearForce: document.getElementById('clear-force'),
  reloadScenario: document.getElementById('reload-scenario'),
  placeStatus: document.getElementById('place-status'),
  run: document.getElementById('run'),
  play: document.getElementById('play'),
  step: document.getElementById('step'),
  reset: document.getElementById('reset'),
  round: document.getElementById('round'),
  roundLabel: document.getElementById('round-label'),
  roundMax: document.getElementById('round-max'),
  scrub: document.getElementById('scrub'),
  turnLabel: document.getElementById('turn-label'),
  speed: document.getElementById('speed'),
  speedLabel: document.getElementById('speed-label'),
  board: document.getElementById('board'),
  boardWrap: document.getElementById('board-wrap'),
  log: document.getElementById('event-log'),
  dragGhost: document.getElementById('drag-ghost'),
  inspect: document.getElementById('inspect'),
  inspectBody: document.getElementById('inspect-body'),
  summary: document.getElementById('summary'),
  summaryTitle: document.getElementById('summary-title'),
  summaryOutcome: document.getElementById('summary-outcome'),
  summaryLines: document.getElementById('summary-lines'),
  summaryStats: document.querySelector('#summary-stats tbody'),
  summaryClose: document.getElementById('summary-close'),
  summaryReplay: document.getElementById('summary-replay'),
  troopChart: document.getElementById('troop-chart'),
};

const ctx = el.board.getContext('2d');

/** @type {{ scenarios: any[], templates: any[] }} */
let catalogue = { scenarios: [], templates: [] };
/** @type {any | null} */
let payload = null;
/** Draft force — source of truth for editing. */
let draft = /** @type {any[]} */ ([]);
let draftDirty = false;
let frameIndex = 0;
let playing = false;
let lastTick = 0;
let shownSummary = false;
/** @type {number | null} */
let selectedKey = null;
let statusTimer = 0;

let layout = {
  hexSize: 34,
  originX: 0,
  originY: 0,
  /** @type {{ key: number, cx: number, cy: number, r: number, col: number, row: number }[]} */
  tokens: [],
  /** @type {{ col: number, row: number, cx: number, cy: number }[]} */
  cells: [],
};

let nextDraftKey = 1;
let focusRound = 1;

/** Prefers reduced motion → static peaks only. */
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Per-turn FX timeline. Clips are timed in [0,1] of the turn window.
 * @type {{
 *   frameIndex: number,
 *   start: number,
 *   duration: number,
 *   scrubPeak: boolean,
 *   clips: any[],
 * }}
 */
let fx = { frameIndex: -1, start: 0, duration: 0, scrubPeak: false, clips: [] };

/** @type {null | {
 *   kind: 'template' | 'token',
 *   templateId?: string,
 *   key?: number,
 *   glyph: string,
 *   pointerId: number,
 *   startX: number,
 *   startY: number,
 *   moved: boolean,
 *   hoverCol: number | null,
 *   hoverRow: number | null,
 *   hoverSide: number | null,
 * }} */
let drag = null;

function eng() {
  return payload?.engagement ?? null;
}

function currentResult() {
  return eng()?.result ?? null;
}

function arenaHeight() {
  if (eng()?.arena?.height) return eng().arena.height;
  if (payload?.scenario?.arenaHeight) return payload.scenario.arenaHeight;
  const a = draft.filter((d) => d.side === 0).length;
  const b = draft.filter((d) => d.side === 1).length;
  return Math.max(6, Math.ceil(Math.max(a, b, 1) / 4));
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function templateById(id) {
  return catalogue.templates.find((t) => t.id === id) ?? null;
}

function hexCorner(cx, cy, size, i) {
  const angle = (Math.PI / 180) * (60 * i - 30);
  return [cx + size * Math.cos(angle), cy + size * Math.sin(angle)];
}

function drawHex(cx, cy, size, fill, stroke, lineWidth = 1.25) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const [x, y] = hexCorner(cx, cy, size, i);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = lineWidth;
  ctx.stroke();
}

function cellCenter(col, row, originX, originY, hexSize) {
  const w = Math.sqrt(3) * hexSize;
  const h = 2 * hexSize;
  const x = originX + col * w + (row & 1 ? w / 2 : 0);
  const y = originY + row * (h * 0.75);
  return [x, y];
}

function occupiedSet(exceptKey = null) {
  return new Set(
    draft
      .filter((d) => d.key !== exceptKey)
      .map((d) => `${d.col},${d.row}`),
  );
}

function legalDeploy(side, col, row) {
  const h = arenaHeight();
  if (row < 0 || row >= h) return false;
  if (side === 0) return col >= 0 && col <= 3;
  return col >= 6 && col <= 9;
}

function sideForCol(col) {
  if (col >= 0 && col <= 3) return 0;
  if (col >= 6 && col <= 9) return 1;
  return null;
}

function setPlaceStatus(text) {
  el.placeStatus.textContent = text || '';
  el.placeStatus.classList.toggle('show', Boolean(text));
  clearTimeout(statusTimer);
  if (text) {
    statusTimer = window.setTimeout(() => {
      el.placeStatus.classList.remove('show');
    }, 3200);
  }
}

function draftFromScenario(scenario) {
  draft = (scenario.deployments || []).map((d) => ({
    key: nextDraftKey++,
    templateId: d.templateId,
    side: d.side,
    col: d.col,
    row: d.row,
    name: d.name,
    glyph: d.glyph,
    role: d.role,
  }));
  draftDirty = false;
  selectedKey = null;
}

function fillRosterFromDraft() {
  const a = draft.filter((d) => d.side === 0);
  const b = draft.filter((d) => d.side === 1);
  el.countA.textContent = String(a.length);
  el.countB.textContent = String(b.length);

  const list = (fighters) => fighters.length
    ? fighters.map((f) => `
        <li data-key="${f.key}" class="${f.key === selectedKey ? 'selected' : ''}">
          <span class="glyph">${escapeHtml(f.glyph)}</span>
          <span class="name">${escapeHtml(f.name)}</span>
        </li>`).join('')
    : '<li class="empty">empty — drag from rack</li>';

  el.rosterA.innerHTML = list(a);
  el.rosterB.innerHTML = list(b);
}

function fillTemplateRack() {
  el.templateRack.innerHTML = catalogue.templates.map((t) => `
    <button type="button" class="chip" data-template="${escapeHtml(t.id)}" draggable="false"
      title="${escapeHtml(t.name)} — drag onto deploy zone">
      <span class="stamp">${escapeHtml(t.glyph)}</span>
      <span class="cname">${escapeHtml(t.name)}</span>
      <span class="crole">${escapeHtml(t.role)}</span>
      <span class="cstats">HP ${t.maxHealth} · AR ${t.armor}</span>
    </button>
  `).join('');
}

function liveById(id) {
  const frame = currentResult()?.frames?.[frameIndex];
  return frame?.fighters?.find((f) => f.id === id) ?? null;
}

function selectedDraft() {
  return draft.find((d) => d.key === selectedKey) ?? null;
}

function abilityDetail(a) {
  const bits = [];
  bits.push(`rng ${a.range}`);
  if (a.damage != null) bits.push(`dmg ${a.damage}`);
  if (a.accuracy != null) bits.push(`acc ${Math.round(a.accuracy * 100)}%`);
  if (a.aoe != null) bits.push(`aoe ${a.aoe}`);
  if (a.shield != null) bits.push(`ward +${a.shield}`);
  if (a.weakenBy != null) bits.push(`−${a.weakenBy}×${a.weakenTurns ?? '?'}t`);
  if (a.rootTurns != null) bits.push(`root ${a.rootTurns}t`);
  bits.push(`cd ${a.cooldown}`);
  return bits.join(' · ');
}

function kindLabel(kind) {
  const map = {
    strike: 'strike',
    volley: 'volley',
    ward: 'ward',
    weaken: 'hex',
    root: 'root',
  };
  return map[kind] || kind;
}

/** Ability ids this unit used in the current frame. */
function usedAbilityIds(fighterId) {
  const frame = currentResult()?.frames?.[frameIndex];
  const ids = new Set();
  if (!frame || fighterId == null) return ids;
  for (const e of frame.events || []) {
    if (e.actorId === fighterId && e.abilityId) ids.add(e.abilityId);
  }
  return ids;
}

function abilityListHtml(abilities, live, fighterId) {
  const list = abilities || [];
  if (!list.length) return '<p class="ability-empty">No abilities</p>';

  const readyIn = live?.abilityReadyIn || [];
  const used = usedAbilityIds(fighterId);

  // Ready abilities keep kit priority order; cooling ones follow, still tagged with kit rank.
  const indexed = list.map((a, i) => ({ a, i, ready: (readyIn[i] ?? 0) <= 0 }));
  const ordered = [
    ...indexed.filter((x) => x.ready),
    ...indexed.filter((x) => !x.ready),
  ];

  return `
    <ul class="ability-list">
      ${ordered.map(({ a, i, ready }) => {
        const cdLeft = readyIn[i] ?? 0;
        const cdMax = Math.max(1, a.cooldown || 1);
        const cdPct = ready ? 0 : Math.min(100, (cdLeft / cdMax) * 100);
        const fired = used.has(a.id);
        const classes = [
          'ability',
          `kind-${a.kind}`,
          ready ? 'ready' : 'cooling',
          fired ? 'used' : '',
        ].filter(Boolean).join(' ');
        return `
          <li class="${classes}" data-ability="${escapeHtml(a.id)}">
            <div class="ability-top">
              <span class="aprio" title="priority ${i + 1}">${i + 1}</span>
              <div class="ability-copy">
                <span class="aname">${escapeHtml(a.name)}</span>
                <span class="akind">${escapeHtml(kindLabel(a.kind))}</span>
              </div>
              <span class="astate">${fired ? 'used' : ready ? 'ready' : `${cdLeft}t`}</span>
            </div>
            <span class="adetail">${escapeHtml(abilityDetail(a))}</span>
            <div class="acd" title="${ready ? 'ready' : `${cdLeft} / ${cdMax} turns`}">
              <div class="acd-track">
                <div class="acd-fill" style="width:${ready ? 100 : 100 - cdPct}%"></div>
              </div>
            </div>
          </li>`;
      }).join('')}
    </ul>`;
}

function unitInspectHtml(d) {
  const t = templateById(d.templateId);
  const liveCard = !draftDirty && eng()
    ? eng().cards.find((c) =>
      c.templateId === d.templateId &&
      c.side === d.side &&
      c.name === d.name)
    : null;
  const live = liveCard ? liveById(liveCard.id) : null;
  const kit = t || liveCard;
  if (!kit) return '<p>Unknown unit.</p>';

  const side = d.side === 0 ? 'A' : 'B';
  const hp = live ? `${live.health}/${live.maxHealth}` : `${kit.maxHealth}/${kit.maxHealth}`;
  const armor = live ? String(live.armor) : String(kit.armor ?? kit.startArmor);
  const statusBits = [];
  if (live && !live.alive) statusBits.push('fallen');
  if (live?.rootedIn > 0) statusBits.push(`rooted ${live.rootedIn}t`);
  if (live?.weakenTurns > 0) statusBits.push(`weakened −${live.weakenBy} (${live.weakenTurns}t)`);
  if (live?.moveReadyIn > 0) statusBits.push(`move ${live.moveReadyIn}t`);
  const fightStat = liveCard && eng()
    ? eng().stats.find((s) => s.id === liveCard.id)
    : null;
  const moveCd = kit.moveCooldown;
  const moveLeft = live?.moveReadyIn ?? 0;
  const moveReady = moveLeft <= 0;

  return `
    <div class="inspect-head">
      <span class="inspect-stamp ${d.side === 0 ? 'a' : 'b'}">${escapeHtml(d.glyph)}</span>
      <div>
        <strong>${escapeHtml(d.name)}</strong>
        <p class="inspect-meta">${escapeHtml(d.role)} · ${side} · ${d.col},${d.row}</p>
      </div>
    </div>
    ${statusBits.length ? `<p class="inspect-status">${statusBits.map(escapeHtml).join(' · ')}</p>` : ''}
    <dl class="stat-grid">
      <div><dt>health</dt><dd>${hp}</dd></div>
      <div><dt>armor</dt><dd>${armor}</dd></div>
      <div><dt>speed</dt><dd>${kit.speed}</dd></div>
      <div class="${moveReady ? '' : 'stat-cooling'}">
        <dt>move</dt>
        <dd>${moveReady ? 'ready' : `${moveLeft}/${moveCd}`}</dd>
      </div>
      <div><dt>accuracy</dt><dd>${Math.round(kit.accuracy * 100)}%</dd></div>
      <div><dt>dodge</dt><dd>${Math.round(kit.dodge * 100)}%</dd></div>
      ${fightStat ? `
        <div><dt>dmg dealt</dt><dd>${fightStat.damageDealt}</dd></div>
        <div><dt>healing</dt><dd>${fightStat.healingDone}</dd></div>
        <div><dt>hits / miss</dt><dd>${fightStat.hitsLanded} / ${fightStat.misses}</dd></div>
        <div><dt>dodges</dt><dd>${fightStat.dodges}</dd></div>
      ` : ''}
    </dl>
    <h4>abilities <span class="h4-hint">ready first · # = priority</span></h4>
    ${abilityListHtml(kit.abilities, live, liveCard?.id)}
    <div class="inspect-actions">
      <button type="button" id="inspect-remove" class="danger">Remove</button>
    </div>
  `;
}

function selectUnit(key) {
  selectedKey = key;
  renderInspect();
  fillRosterFromDraft();
  drawBoardCurrent();
}

function clearSelection() {
  selectedKey = null;
  renderInspect();
  fillRosterFromDraft();
  drawBoardCurrent();
}

function renderInspect() {
  const d = selectedDraft();
  if (!d) {
    el.inspect.classList.add('empty');
    el.inspectBody.hidden = true;
    el.inspectBody.innerHTML = '';
    return;
  }
  el.inspect.classList.remove('empty');
  el.inspectBody.hidden = false;
  el.inspectBody.innerHTML = unitInspectHtml(d);
  const removeBtn = document.getElementById('inspect-remove');
  if (removeBtn) {
    removeBtn.addEventListener('click', removeSelected);
  }
}

function removeSelected() {
  if (selectedKey == null) return;
  const before = draft.length;
  draft = draft.filter((d) => d.key !== selectedKey);
  if (draft.length === before) return;
  draftDirty = true;
  selectedKey = null;
  setPlaceStatus('Removed');
  refreshView();
}

/** Current board cell for the selected draft unit (live frame when available). */
function selectedCellPos(frame) {
  const d = selectedDraft();
  if (!d) return null;
  if (frame && !draftDirty) {
    const liveCard = eng()?.cards?.find((c) =>
      c.templateId === d.templateId &&
      c.side === d.side &&
      c.name === d.name);
    const live = liveCard
      ? frame.fighters.find((f) => f.id === liveCard.id && f.alive)
      : null;
    if (live) {
      return { col: live.cell % ARENA_W, row: (live.cell / ARENA_W) | 0 };
    }
  }
  return { col: d.col, row: d.row };
}

function flashFromEvents(events) {
  const ids = new Set();
  for (const e of events || []) {
    if (e.actorId != null) ids.add(e.actorId);
    if (e.targetId != null) ids.add(e.targetId);
  }
  return ids;
}

function cellOfFighter(frame, id) {
  const f = frame?.fighters?.find((x) => x.id === id);
  if (!f) return null;
  return { col: f.cell % ARENA_W, row: (f.cell / ARENA_W) | 0, cell: f.cell, side: f.side };
}

function centerOfCell(col, row) {
  return cellCenter(col, row, layout.originX, layout.originY, layout.hexSize);
}

function easeOutCubic(t) {
  return 1 - (1 - t) ** 3;
}

function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
}

function clamp01(t) {
  return Math.max(0, Math.min(1, t));
}

function localT(globalT, a, b) {
  if (b <= a) return globalT >= a ? 1 : 0;
  return clamp01((globalT - a) / (b - a));
}

/** How long the current frame stays on screen (ms). Play = exact turns/sec. */
function frameHoldMs(actionCount = 1) {
  if (reduceMotion) return 0;
  const sps = Math.max(1, Number(el.speed.value) || 4);
  const turnMs = 1000 / sps;
  if (!playing) {
    // Step/manual: give each action room to read, still respects speed.
    const perAction = Math.max(160, Math.min(420, turnMs * 0.85));
    return Math.max(450, Math.min(1400, perAction * Math.max(1, actionCount)));
  }
  // Play: locked to the speed clock. FX time-warp into this window.
  void actionCount;
  return turnMs;
}

/** Count of sequenced FX units (volley packs count as one). */
function countActionUnits(events) {
  const list = (events || []).filter((e) => e.kind !== 'wait');
  let n = 0;
  for (let i = 0; i < list.length; ) {
    const e = list[i];
    if (e.kind === 'volley') {
      let j = i + 1;
      while (
        j < list.length &&
        list[j].kind === 'volley' &&
        list[j].actorId === e.actorId &&
        list[j].abilityId === e.abilityId
      ) j++;
      n++;
      i = j;
    } else {
      n++;
      i++;
    }
  }
  return n;
}

/**
 * Build ordered FX clips for one combat turn.
 * Volleys that share actor+ability collapse into one AoE bloom + per-hit sparks.
 */
function buildFxClips(events) {
  const clips = [];
  const list = (events || []).filter((e) => e.kind !== 'wait');
  if (!list.length) return clips;

  // Group consecutive volley hits from the same cast.
  /** @type {any[]} */
  const units = [];
  for (let i = 0; i < list.length; ) {
    const e = list[i];
    if (e.kind === 'volley') {
      const pack = [e];
      let j = i + 1;
      while (
        j < list.length &&
        list[j].kind === 'volley' &&
        list[j].actorId === e.actorId &&
        list[j].abilityId === e.abilityId
      ) {
        pack.push(list[j]);
        j++;
      }
      units.push({ type: 'volleyPack', events: pack });
      i = j;
      continue;
    }
    units.push({ type: 'event', event: e });
    i++;
  }

  const n = units.length;
  const slot = 1 / n;
  const pad = Math.min(0.08, slot * 0.15);

  units.forEach((u, i) => {
    const t0 = i * slot + pad;
    const t1 = (i + 1) * slot - pad * 0.25;
    if (u.type === 'volleyPack') {
      const primary = u.events[0];
      const splash = u.events.slice(1);
      clips.push({
        kind: 'aoe',
        t0, t1,
        actorId: primary.actorId,
        targetId: primary.targetId,
        splashIds: splash.map((s) => s.targetId),
        amounts: u.events.map((s) => s.amount ?? 0),
        abilityName: primary.abilityName,
      });
      for (const hit of u.events) {
        clips.push({
          kind: 'float',
          t0: t0 + (t1 - t0) * 0.35,
          t1: Math.min(1, t1 + 0.12),
          targetId: hit.targetId,
          text: `−${hit.amount ?? 0}`,
          color: '#ffb089',
        });
        if (hit.amount > 0) {
          clips.push({
            kind: 'shake',
            t0: t0 + (t1 - t0) * 0.3,
            t1: t0 + (t1 - t0) * 0.75,
            targetId: hit.targetId,
          });
        }
      }
      return;
    }

    const e = u.event;
    switch (e.kind) {
      case 'move':
        clips.push({
          kind: 'move',
          t0, t1,
          actorId: e.actorId,
          fromCell: e.fromCell,
          toCell: e.toCell,
        });
        break;
      case 'strike':
        clips.push({
          kind: 'beam',
          t0, t1,
          actorId: e.actorId,
          targetId: e.targetId,
          style: 'slash',
          color: e.actorId != null ? null : '#f0a14a',
        });
        clips.push({
          kind: 'float',
          t0: t0 + (t1 - t0) * 0.4,
          t1: Math.min(1, t1 + 0.1),
          targetId: e.targetId,
          text: `−${e.amount ?? 0}`,
          color: '#ffc06e',
        });
        clips.push({
          kind: 'shake',
          t0: t0 + (t1 - t0) * 0.35,
          t1: t0 + (t1 - t0) * 0.8,
          targetId: e.targetId,
        });
        clips.push({
          kind: 'impact',
          t0: t0 + (t1 - t0) * 0.35,
          t1: t0 + (t1 - t0) * 0.7,
          targetId: e.targetId,
          color: '#ffd08a',
        });
        break;
      case 'ward':
        clips.push({
          kind: 'beam',
          t0, t1,
          actorId: e.actorId,
          targetId: e.targetId,
          style: 'gift',
          color: '#7fd4a8',
        });
        clips.push({
          kind: 'aura',
          t0: t0 + (t1 - t0) * 0.25,
          t1,
          targetId: e.targetId,
          style: 'ward',
        });
        clips.push({
          kind: 'float',
          t0: t0 + (t1 - t0) * 0.4,
          t1: Math.min(1, t1 + 0.1),
          targetId: e.targetId,
          text: `+${e.amount ?? 0}`,
          color: '#9ddeb8',
        });
        break;
      case 'weaken':
        clips.push({
          kind: 'beam',
          t0, t1,
          actorId: e.actorId,
          targetId: e.targetId,
          style: 'hex',
          color: '#b07ad4',
        });
        clips.push({
          kind: 'aura',
          t0: t0 + (t1 - t0) * 0.3,
          t1,
          targetId: e.targetId,
          style: 'weaken',
        });
        clips.push({
          kind: 'float',
          t0: t0 + (t1 - t0) * 0.4,
          t1: Math.min(1, t1 + 0.1),
          targetId: e.targetId,
          text: 'weak',
          color: '#d4a0f0',
        });
        break;
      case 'root':
        clips.push({
          kind: 'beam',
          t0, t1,
          actorId: e.actorId,
          targetId: e.targetId,
          style: 'bind',
          color: '#8b6bb8',
        });
        clips.push({
          kind: 'aura',
          t0: t0 + (t1 - t0) * 0.25,
          t1,
          targetId: e.targetId,
          style: 'root',
        });
        clips.push({
          kind: 'float',
          t0: t0 + (t1 - t0) * 0.4,
          t1: Math.min(1, t1 + 0.1),
          targetId: e.targetId,
          text: 'rooted',
          color: '#c4a8ef',
        });
        break;
      case 'miss':
        clips.push({
          kind: 'beam',
          t0, t1,
          actorId: e.actorId,
          targetId: e.targetId,
          style: 'whiff',
          color: '#8793a1',
        });
        clips.push({
          kind: 'float',
          t0: t0 + (t1 - t0) * 0.35,
          t1,
          targetId: e.targetId,
          text: 'miss',
          color: '#9aa3ad',
        });
        break;
      case 'dodge':
        clips.push({
          kind: 'beam',
          t0, t1,
          actorId: e.actorId,
          targetId: e.targetId,
          style: 'whiff',
          color: '#8793a1',
        });
        clips.push({
          kind: 'dodge',
          t0: t0 + (t1 - t0) * 0.25,
          t1,
          targetId: e.targetId,
        });
        clips.push({
          kind: 'float',
          t0: t0 + (t1 - t0) * 0.35,
          t1,
          targetId: e.targetId,
          text: 'dodge',
          color: '#b8c0c8',
        });
        break;
      case 'death':
        clips.push({
          kind: 'death',
          t0, t1,
          targetId: e.targetId ?? e.actorId,
        });
        clips.push({
          kind: 'float',
          t0: t0 + 0.1,
          t1,
          targetId: e.targetId ?? e.actorId,
          text: 'fallen',
          color: '#ff8d7a',
        });
        break;
      default:
        break;
    }
  });

  return clips;
}

function startFrameFx(index, { scrub = false } = {}) {
  const result = currentResult();
  const frame = result?.frames?.[index];
  if (!frame || draftDirty) {
    fx = { frameIndex: -1, start: 0, duration: 0, scrubPeak: false, clips: [] };
    return;
  }
  const clips = buildFxClips(frame.events);
  const actions = countActionUnits(frame.events);
  // Scrub: freeze at a readable peak. Play/step: hold the full turn clock so FX and advance share one timer.
  const duration = scrub || reduceMotion ? 0 : frameHoldMs(actions);
  fx = {
    frameIndex: index,
    start: performance.now(),
    duration,
    scrubPeak: scrub || reduceMotion,
    clips,
  };
}

function fxProgress(now = performance.now()) {
  if (fx.frameIndex < 0) return 0;
  if (fx.scrubPeak || fx.duration <= 0) return 0.55;
  if (!fx.clips.length) return 1;
  return clamp01((now - fx.start) / fx.duration);
}

/** True while the frame's hold window is still open (even if there are no clips). */
function frameHoldOpen(now = performance.now()) {
  if (fx.frameIndex < 0) return false;
  if (fx.scrubPeak || fx.duration <= 0) return false;
  return now - fx.start < fx.duration;
}

/** True while canvas FX should keep redrawing. */
function fxNeedsRedraw(now = performance.now()) {
  if (fx.frameIndex < 0 || !fx.clips.length) return false;
  if (fx.scrubPeak) return true;
  if (fx.duration <= 0) return false;
  return now - fx.start < fx.duration;
}

/** Per-token transient motion derived from active clips. */
function tokenFxAt(id, t) {
  let shakeX = 0;
  let shakeY = 0;
  let dodgeX = 0;
  let flash = 0;
  let ghost = 1;
  let moveOverride = null;

  for (const c of fx.clips) {
    if (c.kind === 'move' && c.actorId === id && c.fromCell != null && c.toCell != null) {
      const fromCol = c.fromCell % ARENA_W;
      const fromRow = (c.fromCell / ARENA_W) | 0;
      const toCol = c.toCell % ARENA_W;
      const toRow = (c.toCell / ARENA_W) | 0;
      let p;
      if (t < c.t0) p = 0;
      else if (t >= c.t1) p = 1;
      else p = easeInOut(localT(t, c.t0, c.t1));
      moveOverride = { col: toCol, row: toRow, xBlend: p, fromCol, fromRow };
      continue;
    }

    const u = localT(t, c.t0, c.t1);
    if (u <= 0 || u > 1) continue;
    if (c.kind === 'shake' && c.targetId === id) {
      const amp = (1 - u) * 3.2;
      shakeX += Math.sin(u * Math.PI * 7) * amp;
      shakeY += Math.cos(u * Math.PI * 5) * amp * 0.55;
    }
    if (c.kind === 'dodge' && c.targetId === id) {
      dodgeX += Math.sin(u * Math.PI) * 7;
    }
    if (c.kind === 'impact' && c.targetId === id) {
      flash = Math.max(flash, Math.sin(u * Math.PI));
    }
    if (c.kind === 'death' && c.targetId === id) {
      ghost = Math.min(ghost, 1 - easeOutCubic(u) * 0.85);
    }
    if ((c.kind === 'beam' || c.kind === 'aoe') && (c.actorId === id || c.targetId === id)) {
      flash = Math.max(flash, Math.sin(Math.min(1, u * 1.4) * Math.PI) * 0.55);
    }
  }
  return { shakeX, shakeY, dodgeX, flash, ghost, moveOverride };
}

function sideColor(side, bright = false) {
  if (side === 0) return bright ? '#5cbc8f' : '#2f9b82';
  return bright ? '#f0a14a' : '#d46048';
}

function drawBeam(x0, y0, x1, y1, u, style, color) {
  const p = easeOutCubic(u);
  const mx = x0 + (x1 - x0) * p;
  const my = y0 + (y1 - y0) * p;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.globalAlpha = 0.25 + 0.75 * Math.sin(Math.min(1, u * 1.2) * Math.PI);

  if (style === 'whiff') {
    ctx.setLineDash([4, 5]);
    ctx.strokeStyle = color || '#8793a1';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(mx, my);
    ctx.stroke();
    ctx.restore();
    return;
  }

  if (style === 'slash') {
    const ang = Math.atan2(y1 - y0, x1 - x0);
    const len = Math.hypot(x1 - x0, y1 - y0);
    const mid = 0.55 + 0.1 * Math.sin(u * Math.PI);
    const cx = x0 + (x1 - x0) * mid;
    const cy = y0 + (y1 - y0) * mid;
    const sweep = (0.35 + 0.45 * Math.sin(u * Math.PI)) * Math.min(28, len * 0.28);
    ctx.strokeStyle = color || '#ffd08a';
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.arc(cx, cy, sweep, ang - 0.9, ang + 0.9);
    ctx.stroke();
    ctx.globalAlpha *= 0.55;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(mx, my);
    ctx.stroke();
    ctx.restore();
    return;
  }

  // gift / hex / bind — dotted courier line with a traveling mote
  ctx.setLineDash(style === 'bind' ? [2, 4] : [5, 4]);
  ctx.strokeStyle = color || '#f0a14a';
  ctx.lineWidth = style === 'gift' ? 2 : 1.6;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = color || '#f0a14a';
  ctx.beginPath();
  ctx.arc(mx, my, style === 'gift' ? 4 : 3.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawAoeBloom(cx, cy, u, splashCenters, actorSide) {
  const pulse = easeOutCubic(clamp01(u));
  const hexSize = layout.hexSize;
  const r0 = hexSize * (0.35 + pulse * 1.55);
  const alpha = (1 - pulse) * 0.85;

  ctx.save();
  // Expanding hex ring
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = actorSide === 0 ? '#ffb070' : '#ff8a6a';
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const [x, y] = hexCorner(cx, cy, r0, i);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.stroke();

  // Ember fill wash
  ctx.globalAlpha = alpha * 0.22;
  ctx.fillStyle = '#f0a14a';
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const [x, y] = hexCorner(cx, cy, r0 * 0.92, i);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();

  // Radial sparks
  const sparkN = 6;
  ctx.globalAlpha = alpha * 0.9;
  ctx.strokeStyle = '#ffd08a';
  ctx.lineWidth = 1.2;
  for (let i = 0; i < sparkN; i++) {
    const ang = (Math.PI * 2 * i) / sparkN + pulse * 0.4;
    const inner = hexSize * 0.2;
    const outer = r0 * (0.55 + 0.35 * ((i % 3) / 3));
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(ang) * inner, cy + Math.sin(ang) * inner);
    ctx.lineTo(cx + Math.cos(ang) * outer, cy + Math.sin(ang) * outer);
    ctx.stroke();
  }

  // Secondary splash ticks
  for (const s of splashCenters) {
    const sp = easeOutCubic(clamp01((u - 0.2) / 0.8));
    if (sp <= 0) continue;
    ctx.globalAlpha = (1 - sp) * 0.7;
    ctx.strokeStyle = '#ffb089';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(s[0], s[1], hexSize * (0.25 + sp * 0.55), 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function drawAura(cx, cy, u, style, tokenR) {
  const a = Math.sin(clamp01(u) * Math.PI);
  ctx.save();
  ctx.globalAlpha = 0.35 + 0.55 * a;
  if (style === 'ward') {
    ctx.strokeStyle = '#7fd4a8';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, tokenR + 3 + a * 4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha *= 0.5;
    ctx.beginPath();
    ctx.arc(cx, cy, tokenR + 7 + a * 3, Math.PI * 0.15, Math.PI * 1.1);
    ctx.stroke();
  } else if (style === 'weaken') {
    ctx.strokeStyle = '#b07ad4';
    ctx.lineWidth = 1.5;
    for (let i = 0; i < 3; i++) {
      const y = cy - tokenR + 4 + i * 5;
      ctx.beginPath();
      ctx.moveTo(cx - tokenR * 0.55, y);
      ctx.lineTo(cx + tokenR * 0.55, y + 2);
      ctx.stroke();
    }
  } else if (style === 'root') {
    ctx.strokeStyle = '#8b6bb8';
    ctx.lineWidth = 1.6;
    ctx.setLineDash([3, 2]);
    ctx.beginPath();
    ctx.arc(cx, cy, tokenR + 5 + a * 2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    // Vine ticks
    for (let i = 0; i < 4; i++) {
      const ang = (Math.PI / 2) * i + u * 0.6;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(ang) * (tokenR - 1), cy + Math.sin(ang) * (tokenR - 1));
      ctx.lineTo(cx + Math.cos(ang) * (tokenR + 7), cy + Math.sin(ang) * (tokenR + 7));
      ctx.stroke();
    }
  }
  ctx.restore();
}

function drawFloatText(cx, cy, u, text, color) {
  const p = easeOutCubic(clamp01(u));
  ctx.save();
  ctx.globalAlpha = 1 - p * 0.85;
  ctx.fillStyle = color || '#ffd08a';
  ctx.font = `700 ${Math.max(9, Math.min(13, layout.hexSize * 0.38))}px "IBM Plex Mono", monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, cx, cy - 10 - p * 16);
  ctx.restore();
}

function drawImpact(cx, cy, u, color) {
  const p = easeOutCubic(clamp01(u));
  ctx.save();
  ctx.globalAlpha = (1 - p) * 0.9;
  ctx.strokeStyle = color || '#ffd08a';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, 4 + p * 14, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawDeathMark(cx, cy, u) {
  const p = easeOutCubic(clamp01(u));
  ctx.save();
  ctx.globalAlpha = (1 - p) * 0.85;
  ctx.strokeStyle = '#ff8d7a';
  ctx.lineWidth = 2;
  const s = 6 + p * 10;
  ctx.beginPath();
  ctx.moveTo(cx - s, cy - s);
  ctx.lineTo(cx + s, cy + s);
  ctx.moveTo(cx + s, cy - s);
  ctx.lineTo(cx - s, cy + s);
  ctx.stroke();
  ctx.restore();
}

function drawFxLayer(frame, t) {
  if (!frame || !fx.clips.length || layout.hexSize <= 0) return;
  const tokenR = layout.hexSize > 22 ? 15 : layout.hexSize > 14 ? 10 : 7;

  const posOf = (id) => {
    const cell = cellOfFighter(frame, id);
    if (!cell) return null;
    // If this unit is mid-move, interpolate.
    const tf = tokenFxAt(id, t);
    if (tf.moveOverride) {
      const [x0, y0] = centerOfCell(tf.moveOverride.fromCol, tf.moveOverride.fromRow);
      const [x1, y1] = centerOfCell(tf.moveOverride.col, tf.moveOverride.row);
      const p = tf.moveOverride.xBlend;
      return {
        x: x0 + (x1 - x0) * p,
        y: y0 + (y1 - y0) * p - 2,
        side: cell.side,
      };
    }
    const [x, y] = centerOfCell(cell.col, cell.row);
    return { x, y: y - 2, side: cell.side };
  };

  for (const c of fx.clips) {
    const u = localT(t, c.t0, c.t1);
    if (u <= 0) continue;

    if (c.kind === 'beam') {
      const a = posOf(c.actorId);
      const b = posOf(c.targetId);
      if (!a || !b) continue;
      const color = c.color || sideColor(a.side, true);
      drawBeam(a.x, a.y, b.x, b.y, u, c.style, color);
    } else if (c.kind === 'aoe') {
      const primary = posOf(c.targetId);
      const actor = posOf(c.actorId);
      if (!primary) continue;
      // Courier bolt into the blast center first.
      if (actor && u < 0.45) {
        drawBeam(actor.x, actor.y, primary.x, primary.y, u / 0.45, 'gift', sideColor(actor.side, true));
      }
      const bloomU = clamp01((u - 0.2) / 0.8);
      if (bloomU > 0) {
        const splash = (c.splashIds || [])
          .map((id) => posOf(id))
          .filter(Boolean)
          .map((p) => [p.x, p.y]);
        drawAoeBloom(primary.x, primary.y, bloomU, splash, actor?.side ?? 0);
      }
    } else if (c.kind === 'aura') {
      const p = posOf(c.targetId);
      if (!p) continue;
      drawAura(p.x, p.y, u, c.style, tokenR);
    } else if (c.kind === 'float') {
      const p = posOf(c.targetId);
      if (!p) continue;
      drawFloatText(p.x, p.y, u, c.text, c.color);
    } else if (c.kind === 'impact') {
      const p = posOf(c.targetId);
      if (!p) continue;
      drawImpact(p.x, p.y, u, c.color);
    } else if (c.kind === 'death') {
      const cell = cellOfFighter(frame, c.targetId);
      // Death events may reference a fallen fighter still in the snapshot as !alive.
      const fallen = frame.fighters.find((f) => f.id === c.targetId);
      if (!fallen) continue;
      const col = fallen.cell % ARENA_W;
      const row = (fallen.cell / ARENA_W) | 0;
      const [x, y] = centerOfCell(col, row);
      drawDeathMark(x, y - 2, u);
      void cell;
    }
  }
}

function fitBoard() {
  const wrap = el.boardWrap;
  const pad = 8;
  const availW = Math.max(200, wrap.clientWidth - pad * 2);
  const availH = Math.max(160, wrap.clientHeight - pad * 2 - 18);
  const Hrows = arenaHeight();

  // Solve hex size so grid fits both axes.
  const sizeByW = availW / (Math.sqrt(3) * (ARENA_W + 0.5) + 2);
  const sizeByH = availH / (1.5 * Hrows + 1.5);
  const hexSize = Math.max(10, Math.min(52, Math.floor(Math.min(sizeByW, sizeByH))));

  const gridW = Math.sqrt(3) * hexSize * (ARENA_W + 0.5);
  const gridH = hexSize * 1.5 * Hrows + hexSize * 0.5;
  el.board.width = Math.ceil(gridW + hexSize * 2);
  el.board.height = Math.ceil(gridH + hexSize * 2);
  return hexSize;
}

function drawBoard(opts = {}) {
  const frame = opts.frame ?? null;
  const flashIds = opts.flashIds ?? new Set();
  const animT = opts.animT ?? 0;
  const Hrows = arenaHeight();
  const hexSize = fitBoard();
  const tokenR = hexSize > 22 ? 15 : hexSize > 14 ? 10 : 7;
  const W = el.board.width;
  const H = el.board.height;
  ctx.clearRect(0, 0, W, H);

  const gridW = Math.sqrt(3) * hexSize * (ARENA_W + 0.5);
  const gridH = hexSize * 1.5 * Hrows + hexSize * 0.5;
  const originX = (W - gridW) / 2 + hexSize;
  const originY = (H - gridH) / 2 + hexSize;
  layout = { hexSize, originX, originY, tokens: [], cells: [] };

  const exceptKey = drag?.kind === 'token' ? drag.key : null;
  const occ = occupiedSet(exceptKey);
  const dragging = Boolean(drag);
  const selCell = selectedCellPos(frame);

  for (let row = 0; row < Hrows; row++) {
    for (let col = 0; col < ARENA_W; col++) {
      const [cx, cy] = cellCenter(col, row, originX, originY, hexSize);
      layout.cells.push({ col, row, cx, cy });

      let fill = '#1c2430';
      if (col <= 3) fill = '#1a332c';
      else if (col >= 6) fill = '#33241f';

      let stroke = '#3a4656';
      let lw = 1.1;

      if (dragging) {
        const side = sideForCol(col);
        const free = !occ.has(`${col},${row}`);
        if (side != null && free && legalDeploy(side, col, row)) {
          fill = side === 0 ? '#245648' : '#5a3228';
          stroke = '#f0a14a';
          lw = 1.8;
        } else if (side == null || !free) {
          fill = '#151b24';
          stroke = '#2a3340';
        }
      }

      if (
        drag &&
        drag.hoverCol === col &&
        drag.hoverRow === row &&
        drag.hoverSide != null &&
        legalDeploy(drag.hoverSide, col, row) &&
        !occ.has(`${col},${row}`)
      ) {
        fill = drag.hoverSide === 0 ? '#2f9b82' : '#d46048';
        stroke = '#ffd08a';
        lw = 2.4;
      }

      const isSelectedHex = selCell && selCell.col === col && selCell.row === row;
      if (isSelectedHex && !dragging) {
        fill = col <= 3 ? '#244a3e' : col >= 6 ? '#4a3028' : '#2a3544';
        stroke = '#f0a14a';
        lw = 2;
      }

      drawHex(cx, cy, hexSize - 1.4, fill, stroke, lw);
    }
  }

  ctx.fillStyle = '#8793a1';
  ctx.font = `${Math.max(8, Math.min(11, hexSize * 0.35))}px "IBM Plex Mono", monospace`;
  ctx.textAlign = 'center';
  for (let col = 0; col < ARENA_W; col++) {
    const [cx] = cellCenter(col, 0, originX, originY, hexSize);
    ctx.fillText(String(col), cx, originY - hexSize + 8);
  }

  const hideKey = drag?.kind === 'token' && drag.moved ? drag.key : null;

  if (frame && !draftDirty && !dragging) {
    // Draw living tokens; movers may be mid-slide via FX.
    for (const f of frame.fighters) {
      if (!f.alive) continue;
      const col = f.cell % ARENA_W;
      const row = (f.cell / ARENA_W) | 0;
      let [cx, cy] = cellCenter(col, row, originX, originY, hexSize);
      const tf = fx.frameIndex === frameIndex ? tokenFxAt(f.id, animT) : {
        shakeX: 0, shakeY: 0, dodgeX: 0, flash: 0, ghost: 1, moveOverride: null,
      };
      if (tf.moveOverride) {
        const [x0, y0] = cellCenter(tf.moveOverride.fromCol, tf.moveOverride.fromRow, originX, originY, hexSize);
        const [x1, y1] = cellCenter(tf.moveOverride.col, tf.moveOverride.row, originX, originY, hexSize);
        const p = tf.moveOverride.xBlend;
        cx = x0 + (x1 - x0) * p;
        cy = y0 + (y1 - y0) * p;
      }
      cx += tf.shakeX + tf.dodgeX;
      cy += tf.shakeY;
      const dMatch = draft.find((d) =>
        d.side === f.side && d.name === f.name && d.glyph === f.glyph);
      const key = dMatch?.key ?? f.id;
      paintToken({
        key, cx, cy, glyph: f.glyph, side: f.side, col, row,
        selected: key === selectedKey,
        flash: flashIds.has(f.id) || tf.flash > 0.15,
        hp: f.health / f.maxHealth,
        armor: f.armor,
        rooted: f.rootedIn > 0,
        weakened: f.weakenTurns > 0,
        ghost: tf.ghost,
        tokenR,
      });
    }
    drawFxLayer(frame, animT);
    return;
  }

  for (const d of draft) {
    if (d.key === hideKey) continue;
    const [cx, cy] = cellCenter(d.col, d.row, originX, originY, hexSize);
    paintToken({
      key: d.key, cx, cy, glyph: d.glyph, side: d.side, col: d.col, row: d.row,
      selected: d.key === selectedKey,
      flash: false,
      hp: 1,
      armor: templateById(d.templateId)?.armor ?? 0,
      rooted: false,
      weakened: false,
      ghost: 1,
      tokenR,
    });
  }
}

function paintToken({ key, cx, cy, glyph, side, col, row, selected, flash, hp, armor, rooted, weakened = false, ghost = 1, tokenR = 16 }) {
  const body = side === 0 ? '#2f9b82' : '#d46048';
  const rim = flash ? '#ffc06e' : '#0b0f14';

  ctx.save();
  ctx.globalAlpha = Math.max(0.15, ghost);

  ctx.beginPath();
  ctx.arc(cx, cy - 2, tokenR, 0, Math.PI * 2);
  ctx.fillStyle = body;
  ctx.fill();
  ctx.lineWidth = flash ? 2.2 : 1.35;
  ctx.strokeStyle = rim;
  ctx.stroke();

  if (tokenR >= 9) {
    ctx.fillStyle = '#fff8ef';
    ctx.font = `600 ${Math.max(8, tokenR - 4)}px "IBM Plex Mono", monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(glyph, cx, cy - 2);
  }

  const barW = Math.max(12, tokenR * 1.55);
  ctx.fillStyle = '#0b0f14';
  ctx.fillRect(cx - barW / 2, cy + tokenR - 2, barW, 3.5);
  ctx.fillStyle = side === 0 ? '#5cbc8f' : '#f0a14a';
  ctx.fillRect(cx - barW / 2, cy + tokenR - 2, barW * Math.max(0, Math.min(1, hp)), 3.5);
  if (armor > 0 && tokenR >= 9) {
    ctx.fillStyle = '#6a8fa0';
    ctx.fillRect(cx - barW / 2, cy + tokenR + 2.5, Math.min(barW, armor * 0.7), 2);
  }
  if (rooted) {
    ctx.setLineDash([3, 2]);
    ctx.strokeStyle = 'rgba(139, 107, 184, 0.85)';
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.arc(cx, cy - 2, tokenR + 4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (weakened) {
    ctx.strokeStyle = 'rgba(176, 122, 212, 0.9)';
    ctx.lineWidth = 1.35;
    ctx.beginPath();
    ctx.moveTo(cx - tokenR * 0.55, cy - tokenR * 0.15);
    ctx.lineTo(cx + tokenR * 0.55, cy + tokenR * 0.2);
    ctx.moveTo(cx - tokenR * 0.55, cy + tokenR * 0.15);
    ctx.lineTo(cx + tokenR * 0.55, cy + tokenR * 0.5);
    ctx.stroke();
  }
  if (selected) {
    ctx.strokeStyle = 'rgba(240, 161, 74, 0.75)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy - 2, tokenR + 6, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
  layout.tokens.push({ key, cx, cy: cy - 2, r: tokenR + 3, col, row });
}

function drawBoardCurrent() {
  const result = (!draftDirty && currentResult()) ? currentResult() : null;
  const frame = result ? result.frames[frameIndex] : null;
  const animT = fx.frameIndex === frameIndex ? fxProgress() : 0;
  drawBoard({
    frame,
    flashIds: frame && !drag ? flashFromEvents(frame.events) : new Set(),
    animT,
  });
}

function renderLog(frame) {
  if (drag) {
    el.log.innerHTML = '<div class="turn-mark">deploy</div><div>Drop on a lit hex in zone A or B.</div>';
    return;
  }
  if (draftDirty || !frame) {
    el.log.innerHTML = `<div class="turn-mark">deployment</div><div>${draft.length} staged · Resolve to fight</div>`;
    return;
  }
  if (frame.turn === 0) {
    el.log.innerHTML = '<div class="turn-mark">ready</div><div>Play or Step. Click a unit for stats.</div>';
    return;
  }
  const lines = [`<div class="turn-mark">turn ${frame.turn}</div>`];
  for (const e of frame.events) {
    if (e.kind === 'wait') continue;
    lines.push(`<div class="${e.kind}">${escapeHtml(e.text)}</div>`);
  }
  if (lines.length === 1) lines.push('<div class="miss">no notable actions</div>');
  el.log.innerHTML = lines.join('');
  el.log.scrollTop = 0;
}

function refreshView() {
  fillRosterFromDraft();
  const result = (!draftDirty && currentResult()) ? currentResult() : null;
  const frame = result ? result.frames[frameIndex] : null;
  const animT = fx.frameIndex === frameIndex ? fxProgress() : 0;
  drawBoard({
    frame,
    flashIds: frame && !drag ? flashFromEvents(frame.events) : new Set(),
    animT,
  });
  renderLog(frame);
  renderInspect();
}

function showFrame(i, { scrub = false } = {}) {
  if (!currentResult() || draftDirty) {
    refreshView();
    return;
  }
  const frames = currentResult().frames;
  frameIndex = Math.max(0, Math.min(i, frames.length - 1));
  el.scrub.value = String(frameIndex);
  el.turnLabel.textContent = String(frames[frameIndex].turn);
  startFrameFx(frameIndex, { scrub });
  // Keep the play clock aligned with this frame's hold window.
  lastTick = fx.start || performance.now();
  refreshView();
  // Summary waits until the last frame's hold finishes (see tick) so FX aren't cut off.
}

function openSummary() {
  const e = eng();
  if (!e) return;
  el.summary.hidden = false;
  el.summaryTitle.textContent = e.title;
  el.summaryOutcome.textContent =
    e.outcome === 'draw'
      ? `Draw after ${e.roundsPlayed} battle(s)`
      : `Side ${e.outcome} wins in ${e.roundsPlayed} battle(s)`;
  const lines = [
    ...e.summary,
    ...e.roundMeta.map((r) =>
      `round ${r.round}: ${r.outcome} in ${r.turnsPlayed}t — alive A ${r.aliveA} / B ${r.aliveB}`),
  ];
  el.summaryLines.innerHTML = lines.map((s) => `<li>${escapeHtml(s)}</li>`).join('');
  const series = troopSeriesFromEngagement(e);
  // Wait a frame so the canvas has a real layout width inside the opened overlay.
  requestAnimationFrame(() => drawTroopChart(series));
  const stats = [...e.stats].sort((a, b) => b.damageDealt - a.damageDealt);
  const shown = stats.length > 24 ? stats.slice(0, 24) : stats;
  el.summaryStats.innerHTML = shown.map((s) => `
    <tr data-id="${s.id}" style="cursor:pointer">
      <td>${escapeHtml(s.name)}</td>
      <td>${s.side === 0 ? 'A' : 'B'}</td>
      <td>${s.damageDealt}</td>
      <td>${s.healingDone}</td>
      <td>${s.hitsLanded}</td>
      <td>${s.misses}</td>
      <td>${s.dodges}</td>
      <td>${s.survived ? '' : 'fallen'}</td>
    </tr>
  `).join('') + (stats.length > shown.length
    ? `<tr><td colspan="8">…and ${stats.length - shown.length} more</td></tr>`
    : '');
}

/** Alive counts per combat turn for the reviewed battle (focus round). */
function troopSeriesFromEngagement(e) {
  const frames = e.result?.frames ?? [];
  return frames.map((f) => {
    let a = 0;
    let b = 0;
    for (const fighter of f.fighters || []) {
      if (!fighter.alive) continue;
      if (fighter.side === 0) a++;
      else b++;
    }
    return { turn: f.turn, a, b };
  });
}

function drawTroopChart(series) {
  const canvas = el.troopChart;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 640;
  const cssH = 200;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const W = cssW;
  const H = cssH;
  ctx.clearRect(0, 0, W, H);

  const pad = { top: 16, right: 14, bottom: 28, left: 36 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;

  ctx.fillStyle = '#121820';
  ctx.fillRect(0, 0, W, H);

  if (!series.length) {
    ctx.fillStyle = '#8793a1';
    ctx.font = '12px Sora, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No frame data', W / 2, H / 2);
    return;
  }

  const maxY = Math.max(1, ...series.map((p) => Math.max(p.a, p.b)));
  const maxTurn = series[series.length - 1].turn;
  const minTurn = series[0].turn;
  const turnSpan = Math.max(1, maxTurn - minTurn);

  const xAt = (turn) => pad.left + ((turn - minTurn) / turnSpan) * plotW;
  const yAt = (n) => pad.top + plotH - (n / maxY) * plotH;

  // Grid
  ctx.strokeStyle = '#2a3644';
  ctx.lineWidth = 1;
  const yTicks = Math.min(5, maxY);
  for (let i = 0; i <= yTicks; i++) {
    const v = Math.round((maxY * i) / yTicks);
    const y = yAt(v);
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + plotW, y);
    ctx.stroke();
    ctx.fillStyle = '#8793a1';
    ctx.font = '10px "IBM Plex Mono", monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(v), pad.left - 6, y);
  }

  // X labels
  ctx.fillStyle = '#8793a1';
  ctx.font = '10px "IBM Plex Mono", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const xLabelCount = Math.min(6, series.length);
  for (let i = 0; i < xLabelCount; i++) {
    const idx = xLabelCount === 1 ? 0 : Math.round((i * (series.length - 1)) / (xLabelCount - 1));
    const p = series[idx];
    ctx.fillText(String(p.turn), xAt(p.turn), pad.top + plotH + 8);
  }
  ctx.fillStyle = '#8793a1';
  ctx.font = '9px Sora, sans-serif';
  ctx.fillText('turn', pad.left + plotW / 2, H - 10);

  function strokeLine(key, color) {
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.25;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    series.forEach((p, i) => {
      const x = xAt(p.turn);
      const y = yAt(p[key]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // End cap
    const last = series[series.length - 1];
    ctx.beginPath();
    ctx.fillStyle = color;
    ctx.arc(xAt(last.turn), yAt(last[key]), 3.2, 0, Math.PI * 2);
    ctx.fill();
  }

  strokeLine('a', '#2f9b82');
  strokeLine('b', '#d46048');
}

function fillScenarioMeta(s) {
  el.blurb.textContent = s.blurb || '';
  el.blurb.title = [s.blurb, s.probes].filter(Boolean).join(' — ');
}

async function loadCatalogue() {
  const res = await fetch('/api/scenarios');
  catalogue = await res.json();
  el.scenario.innerHTML =
    `<option value="__blank">Blank custom</option>` +
    catalogue.scenarios.map((s) =>
      `<option value="${s.id}">${escapeHtml(s.title)} (${s.count})</option>`
    ).join('');
  fillTemplateRack();
  const first = catalogue.scenarios[0];
  el.scenario.value = first.id;
  fillScenarioMeta(first);
  draftFromScenario(first);
  refreshView();
}

async function resolveBattle() {
  playing = false;
  el.play.textContent = 'Play';
  shownSummary = false;
  el.summary.hidden = true;

  const placements = draft.map((d) => ({
    templateId: d.templateId,
    side: d.side,
    col: d.col,
    row: d.row,
    name: d.name,
  }));

  const scenarioId = el.scenario.value;
  const usePlacements = draftDirty || scenarioId === '__blank';
  const body = usePlacements
    ? {
      title: scenarioId === '__blank' || draftDirty
        ? 'Custom battle'
        : catalogue.scenarios.find((s) => s.id === scenarioId)?.title,
      placements,
      arenaHeight: arenaHeight(),
      round: 1,
    }
    : { id: scenarioId, round: 1 };

  setPlaceStatus(usePlacements || (catalogue.scenarios.find((s) => s.id === scenarioId)?.count > 40)
    ? 'Resolving…'
    : 'Resolving…');

  const res = await fetch('/api/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  payload = await res.json();
  if (payload.error) {
    el.log.textContent = payload.error;
    setPlaceStatus(payload.error);
    return;
  }

  applyEngagement(payload);
}

function applyEngagement(data) {
  payload = data;
  draftDirty = false;
  const e = eng();
  draft = (e.deployments || []).map((d) => ({
    key: nextDraftKey++,
    templateId: d.templateId,
    side: d.side,
    col: d.col,
    row: d.row,
    name: d.name,
    glyph: d.glyph,
    role: d.role,
    fighterId: d.id,
  }));
  fillScenarioMeta(payload.scenario);
  focusRound = e.focusRound || 1;
  el.round.max = String(Math.max(1, e.roundsPlayed || 1));
  el.round.value = String(focusRound);
  el.roundLabel.textContent = String(focusRound);
  el.roundMax.textContent = String(e.roundsPlayed || 1);
  const frames = e.result?.frames || [];
  el.scrub.max = String(Math.max(0, frames.length - 1));
  el.scrub.value = '0';
  frameIndex = 0;
  setPlaceStatus(
    `${e.title}: ${e.outcome} in ${e.roundsPlayed} battle(s)`,
  );
  showFrame(0);
}

async function loadRound(n) {
  if (!eng()) return;
  if (eng().rounds) {
    const found = eng().rounds.find((r) => r.round === n);
    if (found) {
      payload.engagement.focusRound = n;
      payload.engagement.result = found.result;
      focusRound = n;
      el.roundLabel.textContent = String(n);
      frameIndex = 0;
      el.scrub.max = String(Math.max(0, found.result.frames.length - 1));
      el.scrub.value = '0';
      shownSummary = true;
      showFrame(0);
      return;
    }
  }
  const res = await fetch(`/api/round?n=${n}`);
  const data = await res.json();
  if (data.error) {
    setPlaceStatus(data.error);
    return;
  }
  payload.engagement.focusRound = data.focusRound;
  payload.engagement.result = data.result;
  focusRound = data.focusRound;
  el.roundLabel.textContent = String(focusRound);
  frameIndex = 0;
  el.scrub.max = String(Math.max(0, data.result.frames.length - 1));
  el.scrub.value = '0';
  shownSummary = true;
  showFrame(0);
}

function canvasPoint(clientX, clientY) {
  const rect = el.board.getBoundingClientRect();
  const scaleX = el.board.width / rect.width;
  const scaleY = el.board.height / rect.height;
  return {
    x: (clientX - rect.left) * scaleX,
    y: (clientY - rect.top) * scaleY,
    overBoard:
      clientX >= rect.left && clientX <= rect.right &&
      clientY >= rect.top && clientY <= rect.bottom,
  };
}

function nearestCell(x, y) {
  let best = null;
  let bestD = Infinity;
  for (const c of layout.cells) {
    const d = Math.hypot(x - c.cx, y - c.cy);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  if (bestD > layout.hexSize) return null;
  return best;
}

function hitToken(x, y) {
  let hit = null;
  let best = Infinity;
  for (const t of layout.tokens) {
    const d = Math.hypot(x - t.cx, y - t.cy);
    if (d <= t.r && d < best) {
      best = d;
      hit = t;
    }
  }
  return hit;
}

function showGhost(clientX, clientY, glyph, sideClass) {
  el.dragGhost.hidden = false;
  el.dragGhost.textContent = glyph;
  el.dragGhost.className = sideClass;
  el.dragGhost.style.left = `${clientX}px`;
  el.dragGhost.style.top = `${clientY}px`;
}

function hideGhost() {
  el.dragGhost.hidden = true;
}

function updateDragHover(clientX, clientY) {
  if (!drag) return;
  const pt = canvasPoint(clientX, clientY);
  if (!pt.overBoard) {
    drag.hoverCol = null;
    drag.hoverRow = null;
    drag.hoverSide = null;
    return;
  }
  const cell = nearestCell(pt.x, pt.y);
  if (!cell) {
    drag.hoverCol = null;
    drag.hoverRow = null;
    drag.hoverSide = null;
    return;
  }
  drag.hoverCol = cell.col;
  drag.hoverRow = cell.row;
  drag.hoverSide = sideForCol(cell.col);
}

function beginTemplateDrag(templateId, pointerId, clientX, clientY, chipEl) {
  const t = templateById(templateId);
  if (!t) return;
  playing = false;
  el.play.textContent = 'Play';
  drag = {
    kind: 'template',
    templateId,
    glyph: t.glyph,
    pointerId,
    startX: clientX,
    startY: clientY,
    moved: false,
    hoverCol: null,
    hoverRow: null,
    hoverSide: null,
  };
  chipEl.classList.add('dragging');
  try { chipEl.setPointerCapture?.(pointerId); } catch { /* synthetic / missing pointer */ }
  el.board.classList.add('dragging');
  showGhost(clientX, clientY, t.glyph, 'neutral');
  refreshView();
}

function beginTokenDrag(key, pointerId, clientX, clientY) {
  const d = draft.find((x) => x.key === key);
  if (!d) return;
  playing = false;
  el.play.textContent = 'Play';
  drag = {
    kind: 'token',
    key,
    glyph: d.glyph,
    pointerId,
    startX: clientX,
    startY: clientY,
    moved: false,
    hoverCol: d.col,
    hoverRow: d.row,
    hoverSide: d.side,
  };
  el.board.classList.add('dragging');
  try { el.board.setPointerCapture?.(pointerId); } catch { /* synthetic / missing pointer */ }
  showGhost(clientX, clientY, d.glyph, d.side === 0 ? 'side-a' : 'side-b');
  refreshView();
}

function endDrag(clientX, clientY) {
  if (!drag) return;
  const finished = drag;
  drag = null;
  el.board.classList.remove('dragging');
  hideGhost();
  document.querySelectorAll('.chip.dragging').forEach((c) => c.classList.remove('dragging'));

  const movedFar = Math.hypot(clientX - finished.startX, clientY - finished.startY) > 6;

  if (finished.kind === 'token' && !movedFar) {
    selectUnit(finished.key);
    return;
  }

  const pt = canvasPoint(clientX, clientY);
  if (!pt.overBoard) {
    setPlaceStatus(finished.kind === 'template' ? 'Drop on a deploy hex' : 'Cancelled');
    refreshView();
    return;
  }

  const cell = nearestCell(pt.x, pt.y);
  if (!cell) {
    if (finished.kind === 'token' && !movedFar) selectUnit(finished.key);
    else {
      setPlaceStatus('Missed the hexes');
      refreshView();
    }
    return;
  }

  const side = sideForCol(cell.col);
  if (side == null || !legalDeploy(side, cell.col, cell.row)) {
    setPlaceStatus('Only deploy zones A (0–3) or B (6–9)');
    refreshView();
    return;
  }

  const except = finished.kind === 'token' ? finished.key : null;
  if (occupiedSet(except).has(`${cell.col},${cell.row}`)) {
    setPlaceStatus('Hex occupied');
    refreshView();
    return;
  }

  if (finished.kind === 'template') {
    const t = templateById(finished.templateId);
    if (!t) { refreshView(); return; }
    draft.push({
      key: nextDraftKey++,
      templateId: t.id,
      side,
      col: cell.col,
      row: cell.row,
      name: t.name,
      glyph: t.glyph,
      role: t.role,
    });
    draftDirty = true;
    selectedKey = draft[draft.length - 1].key;
    setPlaceStatus(`Placed ${t.name} · side ${side === 0 ? 'A' : 'B'} @ ${cell.col},${cell.row}`);
    refreshView();
    return;
  }

  const unit = draft.find((d) => d.key === finished.key);
  if (!unit) { refreshView(); return; }
  unit.col = cell.col;
  unit.row = cell.row;
  unit.side = side;
  draftDirty = true;
  selectedKey = unit.key;
  setPlaceStatus(`Moved ${unit.name} → ${cell.col},${cell.row}`);
  refreshView();
}

/* ── Events ──────────────────────────────────────────── */

el.templateRack.addEventListener('pointerdown', (evt) => {
  const chip = evt.target.closest('.chip[data-template]');
  if (!chip || evt.button !== 0) return;
  evt.preventDefault();
  beginTemplateDrag(chip.dataset.template, evt.pointerId, evt.clientX, evt.clientY, chip);
});

el.board.addEventListener('pointerdown', (evt) => {
  if (evt.button !== 0 || drag) return;
  const { x, y } = canvasPoint(evt.clientX, evt.clientY);
  const tok = hitToken(x, y);
  if (!tok) {
    // Empty hex click clears selection.
    if (selectedKey != null) clearSelection();
    return;
  }
  evt.preventDefault();
  beginTokenDrag(tok.key, evt.pointerId, evt.clientX, evt.clientY);
});

window.addEventListener('pointermove', (evt) => {
  if (!drag || evt.pointerId !== drag.pointerId) return;
  const dist = Math.hypot(evt.clientX - drag.startX, evt.clientY - drag.startY);
  if (dist > 4) drag.moved = true;

  let sideClass = 'neutral';
  if (drag.kind === 'token') {
    const unit = draft.find((d) => d.key === drag.key);
    sideClass = unit?.side === 0 ? 'side-a' : 'side-b';
  }
  updateDragHover(evt.clientX, evt.clientY);
  if (drag.hoverSide === 0) sideClass = 'side-a';
  else if (drag.hoverSide === 1) sideClass = 'side-b';
  showGhost(evt.clientX, evt.clientY, drag.glyph, sideClass);
  drawBoardCurrent();
});

window.addEventListener('pointerup', (evt) => {
  if (!drag || evt.pointerId !== drag.pointerId) return;
  endDrag(evt.clientX, evt.clientY);
});

window.addEventListener('pointercancel', (evt) => {
  if (!drag || evt.pointerId !== drag.pointerId) return;
  drag = null;
  el.board.classList.remove('dragging');
  hideGhost();
  document.querySelectorAll('.chip.dragging').forEach((c) => c.classList.remove('dragging'));
  refreshView();
});

el.rosterA.addEventListener('click', onRosterClick);
el.rosterB.addEventListener('click', onRosterClick);
function onRosterClick(evt) {
  const li = evt.target.closest('li[data-key]');
  if (!li) return;
  selectUnit(Number(li.dataset.key));
}

el.clearForce.addEventListener('click', () => {
  draft = [];
  draftDirty = true;
  selectedKey = null;
  setPlaceStatus('Board cleared');
  refreshView();
});

el.reloadScenario.addEventListener('click', () => {
  const id = el.scenario.value;
  if (id === '__blank') {
    draft = [];
    draftDirty = true;
    fillScenarioMeta({
      blurb: 'Empty board — drag units from the rack.',
      probes: 'Build any composition you want to test.',
    });
  } else {
    const s = catalogue.scenarios.find((x) => x.id === id);
    if (!s) return;
    fillScenarioMeta(s);
    draftFromScenario(s);
  }
  payload = null;
  setPlaceStatus('Reloaded');
  refreshView();
});

el.scenario.addEventListener('change', () => {
  el.reloadScenario.click();
});

el.run.addEventListener('click', () => { resolveBattle(); });
el.step.addEventListener('click', () => {
  if (!currentResult() || draftDirty) return;
  shownSummary = false;
  showFrame(frameIndex + 1);
});
el.reset.addEventListener('click', () => {
  if (!currentResult() || draftDirty) return;
  shownSummary = false;
  el.summary.hidden = true;
  showFrame(0);
});
el.play.addEventListener('click', () => {
  if (!currentResult() || draftDirty) return;
  if (playing) {
    playing = false;
    el.play.textContent = 'Play';
    return;
  }

  el.summary.hidden = true;
  const frames = currentResult().frames;
  const atEnd = frameIndex >= frames.length - 1;

  // Set playing before showFrame/startFrameFx so hold length uses play timing.
  playing = true;
  el.play.textContent = 'Pause';
  shownSummary = false;

  if (atEnd) {
    showFrame(0);
  } else {
    // Re-arm this frame's hold so we don't instant-advance a finished turn.
    startFrameFx(frameIndex);
    lastTick = fx.start;
    refreshView();
  }
});
el.round.addEventListener('input', () => {
  loadRound(Number(el.round.value));
});
el.scrub.addEventListener('input', () => {
  if (!currentResult() || draftDirty) return;
  shownSummary = true;
  el.summary.hidden = true;
  showFrame(Number(el.scrub.value), { scrub: true });
});
el.speed.addEventListener('input', () => {
  el.speedLabel.textContent = el.speed.value;
  // Retarget the in-flight hold so the speed slider feels immediate.
  if (frameHoldOpen() && !fx.scrubPeak) {
    const t = fxProgress();
    const frame = currentResult()?.frames?.[frameIndex];
    fx.duration = frameHoldMs(countActionUnits(frame?.events));
    fx.start = performance.now() - t * fx.duration;
    lastTick = fx.start;
  }
});
el.summaryClose.addEventListener('click', () => { el.summary.hidden = true; });
el.summaryReplay.addEventListener('click', () => {
  el.summary.hidden = true;
  shownSummary = false;
  playing = true;
  el.play.textContent = 'Pause';
  showFrame(0);
});
el.summaryStats.addEventListener('click', (evt) => {
  const tr = evt.target.closest('tr[data-id]');
  if (!tr || !eng()) return;
  el.summary.hidden = true;
  const id = Number(tr.dataset.id);
  const dep = eng().deployments.find((d) => d.id === id);
  const match = draft.find((d) =>
    d.fighterId === id ||
    (dep && d.templateId === dep.templateId && d.side === dep.side && d.name === dep.name));
  if (match) selectUnit(match.key);
});

window.addEventListener('keydown', (evt) => {
  if ((evt.key === 'Delete' || evt.key === 'Backspace') && selectedKey != null) {
    const tag = evt.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    evt.preventDefault();
    removeSelected();
  }
  if (evt.key === 'Escape') {
    if (drag) {
      drag = null;
      el.board.classList.remove('dragging');
      hideGhost();
      document.querySelectorAll('.chip.dragging').forEach((c) => c.classList.remove('dragging'));
      refreshView();
    } else if (selectedKey != null) {
      clearSelection();
    }
  }
});

function finishPlayback() {
  playing = false;
  el.play.textContent = 'Play';
  if (!shownSummary) {
    shownSummary = true;
    openSummary();
  }
}

function tick(now) {
  const result = currentResult();
  const holding = frameHoldOpen(now);
  const redraw = fxNeedsRedraw(now);

  if (playing && result && !draftDirty) {
    // One clock: advance only when this frame's hold (and its FX) have elapsed.
    if (!holding) {
      if (frameIndex >= result.frames.length - 1) {
        finishPlayback();
      } else {
        showFrame(frameIndex + 1);
      }
    }
  } else if (
    !playing &&
    result &&
    !draftDirty &&
    !shownSummary &&
    frameIndex >= result.frames.length - 1 &&
    !holding &&
    fx.frameIndex === frameIndex
  ) {
    // Last frame was stepped into, or play just released — open summary after FX.
    shownSummary = true;
    openSummary();
  }

  if ((redraw || (fx.scrubPeak && fx.clips.length)) && result && !draftDirty && !drag) {
    drawBoardCurrent();
    if (fx.scrubPeak) fx.scrubPeak = false;
  }

  requestAnimationFrame(tick);
}

const resizeObs = new ResizeObserver(() => {
  if (!drag) refreshView();
  else drawBoardCurrent();
});
resizeObs.observe(el.boardWrap);

loadCatalogue().then(() => resolveBattle());
requestAnimationFrame(tick);
