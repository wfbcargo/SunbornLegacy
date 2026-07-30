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
 *   GET  /api/meta         world-invariant data: palette, cycle catalogue, presets, limits
 *   GET  /api/frame        one frame — binary, see encodeFrame
 *   POST /api/control      { action: play|pause|step|speed|reset, ... }
 *   POST /api/reachability { cycles } — which biomes a cycle set can never make
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BIOMES } from '../sim/biomes.ts';
import {
  ALIVE_ENTROPY, ALIVE_MAX_DOMINANCE, ALIVE_MIN_BIOMES, ALIVE_MIN_CHURN,
} from '../sim/report.ts';
import { CYCLE_CATALOGUE, CYCLE_PRESETS, makeCycle, type CycleSpec } from '../sim/cycles.ts';
import {
  cachedReachableCore, flagMaskForKinds, reachableCoreSteps, type ReachableCore,
} from '../sim/reachability.ts';
import { ansi256ToHex } from './palette.ts';
import { checkCycles, checkSize, SIZE_LIMITS } from './limits.ts';
import { CHURN_WARMUP, HISTORY_DAYS, MAX_SPEED, MIN_SPEED, ViewerSession } from './session.ts';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

// `lastIndexOf`, not `indexOf`: the LAST occurrence of a repeated flag wins. See the same
// note in `src/sim/run.ts` — `--port 4173 --port 4190` used to silently serve on 4173.
function arg(name: string, fallback: number): number {
  const i = process.argv.lastIndexOf(`--${name}`);
  const v = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(v) ? v : fallback;
}

function argStr(name: string, fallback: string): string {
  const i = process.argv.lastIndexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : fallback;
}

const PORT = arg('port', 4173);
const START_PRESET = argStr('cycles', 'crucible');
const START_CYCLES = CYCLE_PRESETS[START_PRESET];
if (START_CYCLES === undefined) {
  console.error(
    `\n  Unknown cycle preset "${START_PRESET}". Known: ${Object.keys(CYCLE_PRESETS).join(', ')}\n`,
  );
  process.exit(1);
}

const START_WIDTH = arg('width', 240);
const START_HEIGHT = arg('height', 144);
// The same check the UI applies, applied to the flags too. A viewer started at
// `--height 143` used to die inside HexTorus with a stack trace; the constraint is the
// same either way, so say it the same way.
const startSizeError = checkSize(START_WIDTH, START_HEIGHT);
if (startSizeError !== null) {
  console.error(`\n  ${START_WIDTH}×${START_HEIGHT} is not a legal world.\n  ${startSizeError}\n`);
  process.exit(1);
}

const session = new ViewerSession({
  width: START_WIDTH,
  height: START_HEIGHT,
  seed: arg('seed', 1),
  cycles: START_CYCLES.map((s) => ({ ...s })),
  preset: START_PRESET,
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
    // `presets` stays a list of names — it is read by name across this seam and
    // renaming or retyping it would break the client at runtime with no compile error.
    // The specs behind those names are ADDED alongside, because the composer has to
    // load a preset into editable fields rather than just select it.
    presets: Object.keys(CYCLE_PRESETS),
    presetCycles: CYCLE_PRESETS,
    /**
     * Everything that exists to be composed, before any world does.
     *
     * `defaultKey` is asked of `makeCycle` rather than written down, because it is the
     * only authority: a preset that omits `key` gets whatever the constructor's default
     * is, and a composer that guessed differently would send an explicit key, seed a
     * different RNG stream, and quietly build a different world from the same preset.
     */
    cycleCatalogue: CYCLE_CATALOGUE.map((e) => ({
      ...e,
      defaultKey: makeCycle({ kind: e.kind } as CycleSpec).key,
    })),
    limits: SIZE_LIMITS,
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
  width?: number;
  height?: number;
  cycles?: CycleSpec[];
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
      // Everything is validated BEFORE anything is applied, and every rejection carries
      // the constraint rather than a status code. A silent clamp here would hand back a
      // world nobody asked for, and the person cannot tell the difference by looking.
      const width = body.width ?? session.width;
      const height = body.height ?? session.height;
      const sizeError = checkSize(width, height);
      if (sizeError !== null) return { ok: false, error: sizeError };

      if (body.cycles !== undefined) {
        const cycleError = checkCycles(body.cycles);
        if (cycleError !== null) return { ok: false, error: cycleError };
      }
      if (body.seed !== undefined && !Number.isFinite(body.seed)) {
        return { ok: false, error: 'Seed must be a finite number.' };
      }

      session.reset({
        seed: body.seed,
        preset: body.preset,
        width,
        height,
        cycles: body.cycles,
      });
      return { ok: true };
    }
    default:
      return { ok: false, error: `Unknown action: ${String(body.action)}` };
  }
}

// ---------------------------------------------------------------------------
// Reachability — which biomes a cycle set can never make
// ---------------------------------------------------------------------------

/**
 * The analysis is expensive and the answer is worth waiting for, so this route never
 * blocks: it returns what it has and says whether it is finished.
 *
 * MEASURED cost of one uncached cycle set (160 rules): 0.16 s for all five kinds, 4.7 s
 * for none, 30.8 s for seasons + monsoon + tectonics — the restricted worlds are the
 * expensive ones, because a rule that CANNOT fire has to exhaust the whole probe space
 * before it can be ruled out. Thirty seconds of synchronous work would stop the frame
 * route dead, so the generator is driven a rule at a time with a yield to the event loop
 * between each, and the client polls. Results are cached by flag vocabulary, so the
 * second question about the same cycle kinds is free.
 */
interface Pending {
  steps: Generator<{ done: number; total: number }, ReachableCore, void>;
  progress: { done: number; total: number };
  startedAt: number;
}

const pending = new Map<number, Pending>();

function pump(mask: number, job: Pending): void {
  // One rule per macrotask. A single rule costs at most ~800 ms on this ruleset, which
  // is the worst hiccup the poll loop can see; the alternative — a batch per tick — buys
  // nothing, because the total is dominated by the sweep either way.
  setImmediate(() => {
    const next = job.steps.next();
    if (next.done === true) {
      pending.delete(mask);
      console.log(
        `  reachability: ${next.value.core.length}/${BIOMES.length} biomes in the core ` +
          `after ${((Date.now() - job.startedAt) / 1000).toFixed(1)}s`,
      );
      return;
    }
    job.progress = next.value;
    pump(mask, job);
  });
}

function reachability(body: { cycles?: CycleSpec[] }): {
  ok: boolean;
  error?: string;
  ready?: boolean;
  progress?: { done: number; total: number };
  core?: ReachableCore;
  totalBiomes?: number;
} {
  const cycles = body.cycles ?? [];
  const error = checkCycles(cycles);
  if (error !== null) return { ok: false, error };

  const mask = flagMaskForKinds(cycles.map((c) => c.kind));
  const cached = cachedReachableCore(mask);
  if (cached !== undefined) {
    return { ok: true, ready: true, core: cached, totalBiomes: BIOMES.length };
  }

  let job = pending.get(mask);
  if (job === undefined) {
    job = {
      steps: reachableCoreSteps(mask),
      progress: { done: 0, total: 0 },
      startedAt: Date.now(),
    };
    pending.set(mask, job);
    pump(mask, job);
  }
  return { ok: true, ready: false, progress: job.progress, totalBiomes: BIOMES.length };
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

  if (req.method === 'POST' && url === '/api/reachability') {
    const result = reachability((await readBody(req)) as { cycles?: CycleSpec[] });
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

/**
 * A startup failure should name the constraint, exactly like `checkSize` does for a bad
 * width — not dump a `node:events` stack trace. EADDRINUSE is by far the likeliest one:
 * a viewer from an earlier session is still bound, and the raw throw tells the reader
 * nothing about the `--port` flag that fixes it.
 */
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `\n  Port ${PORT} is already in use — another viewer is probably still running.\n\n` +
        `  Use a different port:  npm run viewer -- --port ${PORT + 1}\n` +
        `  Or stop whatever is bound to ${PORT} — closing its terminal is enough.\n`,
    );
  } else if (err.code === 'EACCES') {
    console.error(`\n  Not allowed to bind port ${PORT}. Try a port above 1024.\n`);
  } else {
    console.error(`\n  The viewer could not start: ${err.message}\n`);
  }
  process.exit(1);
});

// R-009: localhost only. Not a host, not 0.0.0.0, not configurable.
server.listen(PORT, '127.0.0.1', () => {
  const { width, height, seed, preset, cycles } = session;
  console.log(`\n  Sunborn Legacy — world viewer`);
  console.log(
    `  ${width}×${height} torus · ${(width * height).toLocaleString()} tiles · seed ${seed} · ` +
      `cycles ${preset} (${cycles.length})`,
  );
  console.log(`\n  http://127.0.0.1:${PORT}\n`);
});
