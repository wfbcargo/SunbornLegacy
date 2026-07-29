/**
 * The world viewer — a local development instrument.
 *
 *   npm run viewer
 *
 * R-009: this binds to 127.0.0.1 and nothing else, has no auth, and deliberately
 * serves WHOLE-WORLD state that the real `/v1/*` API must never expose. Do not mistake
 * these routes for a product contract; they exist so a person can watch the simulation
 * and see whether it looks alive. See `.wiki/decisions/0001`.
 *
 * ROUTES
 *   GET  /                 the page
 *   GET  /viewer.css|.js   its assets
 *   GET  /api/meta         world-invariant data: biome palette, presets, thresholds
 *   GET  /api/frame        one frame — binary, see encodeFrame
 *   POST /api/control      { action: play|pause|step|speed|reset, ... }
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BIOMES } from '../sim/biomes.ts';
import {
  ALIVE_ENTROPY, ALIVE_MAX_DOMINANCE, ALIVE_MIN_BIOMES, ALIVE_MIN_CHURN,
} from '../sim/report.ts';
import { CYCLE_PRESETS } from '../sim/cycles.ts';
import { ansi256ToHex } from './palette.ts';
import { CHURN_WARMUP, HISTORY_DAYS, MAX_SPEED, MIN_SPEED, ViewerSession } from './session.ts';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(v) ? v : fallback;
}

function argStr(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : fallback;
}

const PORT = arg('port', 4173);
const session = new ViewerSession({
  width: arg('width', 240),
  height: arg('height', 144),
  seed: arg('seed', 1),
  preset: argStr('cycles', 'crucible'),
});

// ---------------------------------------------------------------------------
// Frame encoding
// ---------------------------------------------------------------------------

/**
 * One frame, as a single binary body:
 *
 *   [0..4)          uint32 LE — length of the JSON header
 *   [4, 4+H)        JSON header (day, metrics, playback state, proportions)
 *   [4+H, +size)    biome, one byte per tile
 *   [+size, +size)  moisture, one byte per tile, rounded to whole points
 *
 * The grid is bytes, not JSON. At 240×144 that is 34,560 bytes per plane; the same
 * data as a JSON array of numbers is roughly 5-6× larger and costs a parse of 34,560
 * tokens on every frame, at up to 15 frames a second.
 *
 * Moisture is quantised to a byte because the only consumer is the hover readout,
 * which shows whole points. Sending it as Float32 would quadruple the plane to buy
 * precision that is never displayed.
 */
function encodeFrame(): Buffer {
  const { world } = session;
  const size = world.grid.size;

  const header = Buffer.from(JSON.stringify(session.status()), 'utf8');
  const out = Buffer.allocUnsafe(4 + header.length + size * 2);

  out.writeUInt32LE(header.length, 0);
  header.copy(out, 4);

  const biomeAt = 4 + header.length;
  const moistAt = biomeAt + size;
  for (let i = 0; i < size; i++) {
    out[biomeAt + i] = world.biome[i]!;
    const m = Math.round(world.moisture[i]!);
    out[moistAt + i] = m < 0 ? 0 : m > 255 ? 255 : m;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Static assets
// ---------------------------------------------------------------------------

const PUBLIC_DIR = join(import.meta.dirname, 'public');

/** An allowlist rather than a path join, so traversal is not a thing that can happen. */
const ASSETS: Readonly<Record<string, string>> = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/viewer.css': 'viewer.css',
  '/viewer.js': 'viewer.js',
};

const MIME: Readonly<Record<string, string>> = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
};

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, body: unknown, status = 200): void {
  const buf = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': buf.length });
  res.end(buf);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    return {};
  }
}

function meta(): unknown {
  return {
    biomes: BIOMES.map((d) => ({
      id: d.id, key: d.key, name: d.name, glyph: d.glyph, hex: ansi256ToHex(d.colour),
    })),
    presets: Object.keys(CYCLE_PRESETS),
    thresholds: {
      entropy: ALIVE_ENTROPY,
      dominance: ALIVE_MAX_DOMINANCE,
      churn: ALIVE_MIN_CHURN,
      biomes: ALIVE_MIN_BIOMES,
    },
    speed: { min: MIN_SPEED, max: MAX_SPEED },
    historyDays: HISTORY_DAYS,
    churnWarmup: CHURN_WARMUP,
  };
}

interface ControlBody {
  action?: string;
  speed?: number;
  days?: number;
  seed?: number;
  preset?: string;
}

function control(body: ControlBody): { ok: boolean; error?: string } {
  switch (body.action) {
    case 'play':
      session.play();
      return { ok: true };
    case 'pause':
      session.pause();
      return { ok: true };
    case 'step': {
      session.pause();
      const days = Math.max(1, Math.min(100, Math.floor(body.days ?? 1)));
      session.advance(days);
      return { ok: true };
    }
    case 'speed':
      session.setSpeed(Number(body.speed));
      return { ok: true };
    case 'reset': {
      const preset = body.preset;
      if (preset !== undefined && CYCLE_PRESETS[preset] === undefined) {
        return { ok: false, error: `Unknown cycle preset: ${preset}` };
      }
      session.reset({ seed: body.seed, preset });
      return { ok: true };
    }
    default:
      return { ok: false, error: `Unknown action: ${String(body.action)}` };
  }
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = (req.url ?? '/').split('?')[0]!;

  if (req.method === 'GET' && url === '/api/frame') {
    const buf = encodeFrame();
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': buf.length,
      'cache-control': 'no-store',
    });
    res.end(buf);
    return;
  }

  if (req.method === 'GET' && url === '/api/meta') {
    sendJson(res, meta());
    return;
  }

  if (req.method === 'POST' && url === '/api/control') {
    const result = control((await readBody(req)) as ControlBody);
    sendJson(res, result, result.ok ? 200 : 400);
    return;
  }

  const asset = ASSETS[url];
  if (req.method === 'GET' && asset !== undefined) {
    const body = await readFile(join(PUBLIC_DIR, asset));
    const ext = asset.slice(asset.lastIndexOf('.') + 1);
    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-store',
    });
    res.end(body);
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain' }).end('not found\n');
}

const server = createServer((req, res) => {
  handle(req, res).catch((err: unknown) => {
    console.error(err);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('viewer error\n');
  });
});

// R-009: localhost only. Not a host, not 0.0.0.0, not configurable.
server.listen(PORT, '127.0.0.1', () => {
  const { width, height, seed, preset } = session;
  console.log(`\n  Sunborn Legacy — world viewer`);
  console.log(`  ${width}×${height} torus · seed ${seed} · cycles ${preset}`);
  console.log(`\n  http://127.0.0.1:${PORT}\n`);
});
