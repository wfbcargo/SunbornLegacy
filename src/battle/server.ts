/**
 * Local battle viewer — engagements, mass battles, force editor.
 *
 *   npm run battle:view
 *
 * Binds 127.0.0.1 only. Not a product surface.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  Arena,
  ARENA_WIDTH,
  arenaCol,
  arenaRow,
  heightForForce,
} from './arena.ts';
import { hashString } from '../sim/rng.ts';
import { assessEngagement, DEFAULT_MAX_ROUNDS, runEngagement, type Assessment } from './engagement.ts';
import {
  buildFromPlacements,
  listTemplates,
  type Placement,
} from './roster.ts';
import { allScenarios, scenarioById } from './scenarios.ts';
import {
  featureName,
  generateTerrain,
  terrainSummary,
  type TerrainField,
} from './terrain.ts';
import type {
  BattleResult,
  EngagementResult,
  Fighter,
  Scenario,
} from './types.ts';
import { Side } from './types.ts';

const PORT = (() => {
  const i = process.argv.lastIndexOf('--port');
  const v = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(v) ? v : 4174;
})();

const ROOT = join(import.meta.dirname, 'public');

const ALLOWED = new Set([
  '/index.html',
  '/battle.css',
  '/battle.js',
  '/',
]);

/** Last engagement — round scrubbing without recompute. */
let cached: EngagementResult | null = null;

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(data);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function serializeAbility(a: Fighter['abilities'][number]) {
  return {
    id: a.id,
    name: a.name,
    kind: a.kind,
    range: a.range,
    cooldown: a.cooldown,
    damage: a.damage ?? null,
    accuracy: a.accuracy ?? null,
    aoe: a.aoe ?? null,
    shield: a.shield ?? null,
    weakenBy: a.weakenBy ?? null,
    weakenTurns: a.weakenTurns ?? null,
    rootTurns: a.rootTurns ?? null,
  };
}

function serializeCard(f: Fighter) {
  return {
    id: f.id,
    name: f.name,
    glyph: f.glyph,
    role: f.role,
    side: f.side,
    templateId: f.templateId,
    maxHealth: f.maxHealth,
    startArmor: f.startArmor,
    speed: f.speed,
    moveCooldown: f.moveCooldown,
    accuracy: f.accuracy,
    dodge: f.dodge,
    abilities: f.abilities.map(serializeAbility),
  };
}

function serializeDeployment(f: Fighter) {
  return {
    id: f.id,
    templateId: f.templateId,
    side: f.side,
    col: arenaCol(f.deployCell),
    row: arenaRow(f.deployCell),
    name: f.name,
    glyph: f.glyph,
    role: f.role,
  };
}

function serializeScenario(s: Scenario) {
  const height = s.arenaHeight ?? heightForForce(
    s.fighters.filter((f) => f.side === Side.A).length,
    s.fighters.filter((f) => f.side === Side.B).length,
  );
  return {
    id: s.id,
    title: s.title,
    blurb: s.blurb,
    probes: s.probes,
    count: s.fighters.length,
    arenaHeight: height,
    maxRounds: s.maxRounds ?? DEFAULT_MAX_ROUNDS,
    biomeKey: s.biomeKey ?? null,
    deployments: s.fighters.map(serializeDeployment),
    sides: {
      A: s.fighters.filter((f) => f.side === Side.A).map((f) => ({
        id: f.id, name: f.name, role: f.role, glyph: f.glyph, templateId: f.templateId,
      })),
      B: s.fighters.filter((f) => f.side === Side.B).map((f) => ({
        id: f.id, name: f.name, role: f.role, glyph: f.glyph, templateId: f.templateId,
      })),
    },
  };
}

function slimBattleResult(r: BattleResult, includeFrames: boolean) {
  return {
    battleId: r.battleId,
    title: r.title,
    turnsPlayed: r.turnsPlayed,
    outcome: r.outcome,
    summary: r.summary,
    stats: r.stats,
    arena: r.arena,
    frames: includeFrames ? r.frames : [],
    events: includeFrames ? r.events.filter((e) => e.kind !== 'wait') : [],
  };
}

function serializeEngagement(eng: EngagementResult, focusRound: number) {
  const round = eng.rounds.find((r) => r.round === focusRound) ?? eng.rounds[eng.rounds.length - 1];
  const fightersAtStart = eng.rounds[0]?.result.fighters.length
    ?? eng.fighters.length;
  // Full frame payloads only for smaller fights — mass wars send one round at a time.
  const includeAllFrames = fightersAtStart <= 48;

  return {
    engagementId: eng.engagementId,
    title: eng.title,
    roundsPlayed: eng.roundsPlayed,
    outcome: eng.outcome,
    summary: eng.summary,
    stats: eng.stats,
    arena: eng.arena,
    maxRounds: eng.maxRounds,
    cards: eng.rounds[0]
      ? // cards from first round's starting roster (via deployments on fighters)
        // Use final fighters for ids/templates; HP varies — cards are kits.
        eng.fighters.map(serializeCard)
      : [],
    deployments: eng.fighters.map(serializeDeployment),
    roundMeta: eng.rounds.map((r) => ({
      round: r.round,
      outcome: r.result.outcome,
      turnsPlayed: r.result.turnsPlayed,
      aliveA: r.aliveA,
      aliveB: r.aliveB,
    })),
    rounds: includeAllFrames
      ? eng.rounds.map((r) => ({
        round: r.round,
        aliveA: r.aliveA,
        aliveB: r.aliveB,
        result: slimBattleResult(r.result, true),
      }))
      : undefined,
    focusRound: round?.round ?? 1,
    result: round ? slimBattleResult(round.result, true) : null,
  };
}

function serializeTemplate() {
  return listTemplates().map((t) => ({
    id: t.id,
    name: t.name,
    glyph: t.glyph,
    role: t.role,
    maxHealth: t.maxHealth,
    armor: t.armor,
    speed: t.speed,
    moveCooldown: t.moveCooldown,
    accuracy: t.accuracy,
    dodge: t.dodge,
    abilities: t.abilities.map(serializeAbility),
  }));
}

interface RunBody {
  id?: string;
  title?: string;
  placements?: Placement[];
  arenaHeight?: number;
  maxRounds?: number;
  round?: number;
  biome?: string;
  tileIndex?: number;
}

function parsePlacements(raw: unknown): Placement[] {
  if (!Array.isArray(raw)) throw new Error('placements must be an array');
  return raw.map((p, i) => {
    if (p === null || typeof p !== 'object') throw new Error(`placement ${i} invalid`);
    const o = p as Record<string, unknown>;
    const templateId = String(o.templateId ?? '');
    const side = Number(o.side);
    const col = Number(o.col);
    const row = Number(o.row);
    const name = o.name !== undefined ? String(o.name) : undefined;
    if (!Number.isInteger(side) || !Number.isInteger(col) || !Number.isInteger(row)) {
      throw new Error(`placement ${i}: side/col/row must be integers`);
    }
    return { templateId, side: side as 0 | 1, col, row, name };
  });
}

function customBattleId(placements: readonly Placement[]): string {
  const key = placements
    .map((p) => `${p.side}:${p.templateId}@${p.col},${p.row}:${p.name ?? ''}`)
    .sort()
    .join('|');
  return `custom-${(hashString(key) >>> 0).toString(16)}`;
}

function terrainFor(
  engagementId: string,
  arena: Arena,
  biomeKey: string | undefined,
  tileIndex: number | undefined,
): TerrainField | null {
  if (!biomeKey) return null;
  return generateTerrain({
    biomeKey,
    battleId: engagementId,
    tileIndex: tileIndex ?? 0,
    width: arena.width,
    height: arena.height,
  });
}

function serializeTerrain(field: TerrainField | null) {
  if (!field) return null;
  return {
    biomeKey: field.biomeKey,
    tileIndex: field.tileIndex,
    summary: terrainSummary(field),
    features: [...field.features].map((f) => featureName(f as 0 | 1 | 2 | 3 | 4)),
  };
}

function serializeAssessment(a: Assessment, focusRound: number) {
  return {
    outcome: a.outcome,
    ticksToResolve: a.ticksToResolve,
    expectedLosses: a.expectedLosses,
    remaining: a.remaining,
    summary: a.summary,
    engagement: serializeEngagement(a.engagement, focusRound),
  };
}

function buildOpts(body: RunBody): {
  opts: Parameters<typeof runEngagement>[0];
  scenarioView: ReturnType<typeof serializeScenario>;
  terrain: TerrainField | null;
  custom: boolean;
} {
  if (body.placements) {
    const placements = parsePlacements(body.placements);
    const aCount = placements.filter((p) => p.side === Side.A).length;
    const bCount = placements.filter((p) => p.side === Side.B).length;
    const height = body.arenaHeight ?? heightForForce(aCount, bCount);
    const fighters = buildFromPlacements(placements, height);
    const title = body.title?.trim() || 'Custom battle';
    const engagementId = customBattleId(placements);
    const arena = new Arena(height);
    const terrain = terrainFor(engagementId, arena, body.biome, body.tileIndex);
    return {
      opts: {
        engagementId,
        title,
        fighters,
        arena,
        terrain,
        maxRounds: body.maxRounds ?? DEFAULT_MAX_ROUNDS,
      },
      terrain,
      custom: true,
      scenarioView: serializeScenario({
        id: engagementId,
        title,
        blurb: 'Player-authored deployment.',
        probes: 'Your composition — tune freely.',
        fighters,
        arenaHeight: height,
        maxRounds: body.maxRounds ?? DEFAULT_MAX_ROUNDS,
        biomeKey: body.biome,
      }),
    };
  }

  const id = body.id ?? 'glass-road';
  const fresh = scenarioById(id);
  if (!fresh) throw new Error(`unknown scenario ${id}`);
  const height = fresh.arenaHeight ?? heightForForce(
    fresh.fighters.filter((f) => f.side === Side.A).length,
    fresh.fighters.filter((f) => f.side === Side.B).length,
  );
  const arena = new Arena(height);
  const biomeKey = body.biome ?? fresh.biomeKey;
  const terrain = terrainFor(fresh.id, arena, biomeKey, body.tileIndex);
  return {
    opts: {
      engagementId: fresh.id,
      title: fresh.title,
      fighters: fresh.fighters,
      arena,
      terrain,
      maxRounds: fresh.maxRounds ?? DEFAULT_MAX_ROUNDS,
    },
    terrain,
    custom: false,
    scenarioView: serializeScenario(fresh),
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  const path = url.pathname;

  try {
    if (path === '/api/scenarios' && req.method === 'GET') {
      json(res, 200, {
        scenarios: allScenarios().map(serializeScenario),
        templates: serializeTemplate(),
      });
      return;
    }

    if (path === '/api/round' && req.method === 'GET') {
      const round = Number(url.searchParams.get('n') ?? '1');
      if (!cached) {
        json(res, 404, { error: 'no engagement cached — Resolve first' });
        return;
      }
      const found = cached.rounds.find((r) => r.round === round);
      if (!found) {
        json(res, 404, { error: `round ${round} not in engagement` });
        return;
      }
      json(res, 200, {
        focusRound: round,
        result: slimBattleResult(found.result, true),
        roundMeta: cached.rounds.map((r) => ({
          round: r.round,
          outcome: r.result.outcome,
          turnsPlayed: r.result.turnsPlayed,
          aliveA: r.aliveA,
          aliveB: r.aliveB,
        })),
      });
      return;
    }

    if ((path === '/api/run' || path === '/api/assess') && req.method === 'POST') {
      const raw = await readBody(req);
      let body: RunBody = {};
      try {
        body = JSON.parse(raw) as RunBody;
      } catch {
        json(res, 400, { error: 'invalid JSON' });
        return;
      }

      try {
        const built = buildOpts(body);
        const focus = body.round ?? 1;
        if (path === '/api/assess') {
          const assessment = assessEngagement(built.opts);
          cached = assessment.engagement;
          json(res, 200, {
            scenario: built.scenarioView,
            assess: serializeAssessment(assessment, focus),
            terrain: serializeTerrain(built.terrain),
            custom: built.custom,
          });
          return;
        }

        const eng = runEngagement(built.opts);
        cached = eng;
        json(res, 200, {
          scenario: built.scenarioView,
          engagement: serializeEngagement(eng, focus),
          terrain: serializeTerrain(built.terrain),
          custom: built.custom,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        json(res, 400, { error: message });
      }
      return;
    }

    let filePath = path === '/' ? '/index.html' : path;
    if (!ALLOWED.has(filePath)) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const abs = join(ROOT, filePath.replace(/^\//, ''));
    const data = await readFile(abs);
    const type =
      filePath.endsWith('.css') ? 'text/css; charset=utf-8'
        : filePath.endsWith('.js') ? 'text/javascript; charset=utf-8'
          : 'text/html; charset=utf-8';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(data);
  } catch (err) {
    console.error(err);
    res.writeHead(500);
    res.end('error');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  battle viewer  http://127.0.0.1:${PORT}\n`);
  console.log(`  arena width fixed at ${ARENA_WIDTH}; height grows with force size\n`);
});
