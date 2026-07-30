/**
 * One live world, plus the playback state the viewer wraps around it.
 *
 * The server owns the `World`; the browser owns none of the simulation. Everything
 * here is presentation state — is it playing, how fast, how much history to keep —
 * and the sim is unaware any of it exists.
 *
 * DETERMINISM (R-004). The wall clock appears exactly once, in `schedule()`, and it
 * only decides WHEN `stepDay()` is called. It never reaches a rule, a seed, or a
 * sample. Two sessions with the same seed and preset that are stepped the same number
 * of days are bit-identical whether they got there by pressing Step 300 times or by
 * playing at 30 days/second.
 */

import { World } from '../sim/world.ts';
import { assessStability, sample, type Sample, type StabilityVerdict } from '../sim/report.ts';
import type { CycleSpec } from '../sim/cycles.ts';

/**
 * Rolling sample window, in days.
 *
 * `assessStability` measures the TAIL of what it is given (`gotchas.md`), so a window
 * is not a lossy shortcut here — it is the right input. A viewer that accumulated
 * every sample since reset would report churn over the last third of the *whole run*,
 * which for a world left playing overnight is a fossil, not a live reading.
 */
export const HISTORY_DAYS = 600;

/** Below this many samples the tail is too short for churn to mean anything. */
export const CHURN_WARMUP = 30;

/** Playback speed bounds, in simulated days per real second. */
/** Matches the client's slider floor. A floor no client can request is dead config. */
export const MIN_SPEED = 1;
export const MAX_SPEED = 60;

export interface SessionOptions {
  width: number;
  height: number;
  seed: number;
  /**
   * The world's cycles, as plain specs. This — not a preset name — is what a world is
   * made of; a preset is only a starting point somebody loaded once.
   */
  cycles: CycleSpec[];
  /**
   * Where those cycles came from, for display: a preset name while they still match it,
   * `custom` once they do not. Never used to rebuild the world.
   */
  preset: string;
}

export interface SessionStatus {
  day: number;
  /** Bumped on every reset, so the client knows the frame it holds is from a new world. */
  generation: number;
  seed: number;
  preset: string;
  width: number;
  height: number;
  playing: boolean;
  speed: number;
  /** Samples in the rolling window. Churn is not meaningful below CHURN_WARMUP. */
  samples: number;
  entropy: number;
  proportions: number[];
  verdict: StabilityVerdict;
  /**
   * The composed set this world was built from, so the composer can sync to it.
   *
   * The SPECS, not `describe()`. This rides along on every frame — up to 15 a second —
   * and a full description carries each cycle's prose summary, which measured 5,037
   * bytes of header for four cycles against ~600 for the specs. The client already has
   * every summary from `/api/meta`, keyed by kind, so sending them again per frame buys
   * nothing.
   */
  cycles: CycleSpec[];
  /**
   * Measured cost of one simulated day, in milliseconds — the number that makes a
   * 480×288 world with `crucible`'s six cycles an informed choice rather than a surprise
   * (29.9 ms/day in the re-measured table in `viewer/limits.ts`). Wall
   * clock, and therefore presentation only: it is measured AROUND `stepDay`, never
   * inside it, and no seed, sample or rule can see it (R-004).
   */
  msPerDay: number;
  /** The frame's two byte planes, one byte per tile each. The JSON header adds ~500 more. */
  frameBytes: number;
}

export class ViewerSession {
  world: World;
  width: number;
  height: number;
  seed: number;
  preset: string;
  cycles: CycleSpec[];

  playing = false;
  speed = 6;
  generation = 0;

  /** Exponential mean of measured ms per simulated day. 0 until the first step. */
  private msPerDay = 0;

  private samples: Sample[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: SessionOptions) {
    this.width = opts.width;
    this.height = opts.height;
    this.seed = opts.seed;
    this.cycles = opts.cycles;
    this.preset = opts.preset;
    this.world = this.build();
    this.samples = [sample(this.world)];
  }

  private build(): World {
    // Specs are passed straight through. `makeCycle` destructures every spec into a
    // fresh params object and never writes back to it, so the preset table cannot be
    // mutated by having been used — a defensive copy here would only obscure that.
    return new World({
      width: this.width,
      height: this.height,
      seed: this.seed,
      cycles: this.cycles,
    });
  }

  /**
   * Rebuild the world from scratch. Same seed + same cycles ⇒ the same world, every time.
   *
   * The new world is built into a LOCAL first and only committed if it succeeds. A
   * half-applied reset is the failure mode to avoid here: assigning `this.height = 143`
   * and then letting `HexTorus` throw would leave the session reporting a height its
   * `world` does not have, and the client decodes the frame's byte planes using exactly
   * that number — so the map would silently shear instead of the request failing.
   */
  reset(opts: Partial<SessionOptions> = {}): void {
    const width = opts.width ?? this.width;
    const height = opts.height ?? this.height;
    const seed = opts.seed === undefined ? this.seed : Math.floor(opts.seed);
    const cycles = opts.cycles ?? this.cycles;

    const world = new World({ width, height, seed, cycles });

    this.pause();
    this.width = width;
    this.height = height;
    this.seed = seed;
    this.cycles = cycles;
    if (opts.preset !== undefined) this.preset = opts.preset;
    this.world = world;
    // The sample window belongs to the world that produced it. `assessStability`
    // compares proportions ACROSS samples, so splicing pre-resize samples onto
    // post-resize ones would report churn that never happened — and after a resize the
    // two are not even the same length. Cost measurements go with it: a different tile
    // count is a different cost.
    this.samples = [sample(this.world)];
    this.msPerDay = 0;
    this.generation++;
  }

  /** Advance N days, recording one sample per day. */
  advance(days: number): void {
    for (let d = 0; d < days; d++) {
      const t0 = performance.now();
      this.world.stepDay();
      const ms = performance.now() - t0;
      // Exponential mean: one day's timing is noisy enough to jitter the readout, and a
      // panel number that flickers is a number nobody reads. Sampling is excluded — it
      // is the viewer's cost, not the world's.
      this.msPerDay = this.msPerDay === 0 ? ms : this.msPerDay * 0.8 + ms * 0.2;
      this.samples.push(sample(this.world));
    }
    if (this.samples.length > HISTORY_DAYS) {
      this.samples = this.samples.slice(this.samples.length - HISTORY_DAYS);
    }
  }

  play(): void {
    if (this.playing) return;
    this.playing = true;
    this.schedule();
  }

  pause(): void {
    this.playing = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  setSpeed(speed: number): void {
    this.speed = Math.max(MIN_SPEED, Math.min(MAX_SPEED, speed));
    if (this.playing) {
      this.pause();
      this.play();
    }
  }

  /**
   * Timer cadence. Above ~20 days/second the per-tick interval gets shorter than
   * `setTimeout` resolution is worth trusting, so speed is delivered as several days
   * per tick instead of more ticks per second. A `stepDay()` at 240×144 measures about
   * 5ms, so even 3 days per tick is a ~15ms block — short enough that the HTTP handler
   * for the next frame is never left waiting long.
   */
  private schedule(): void {
    const perTick = this.speed <= 20 ? 1 : Math.ceil(this.speed / 20);
    const interval = Math.max(8, Math.round((1000 * perTick) / this.speed));
    this.timer = setTimeout(() => {
      if (!this.playing) return;
      this.advance(perTick);
      this.schedule();
    }, interval);
  }

  status(): SessionStatus {
    const verdict = assessStability(this.samples);
    return {
      day: Math.round(this.world.day),
      generation: this.generation,
      seed: this.seed,
      preset: this.preset,
      width: this.width,
      height: this.height,
      playing: this.playing,
      speed: this.speed,
      samples: this.samples.length,
      entropy: this.world.biomeEntropy(),
      proportions: [...this.world.biomeProportions()],
      verdict,
      cycles: this.cycles,
      msPerDay: this.msPerDay,
      frameBytes: this.world.grid.size * 2,
    };
  }
}
