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
import { CYCLE_PRESETS } from '../sim/cycles.ts';

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
}

export class ViewerSession {
  world: World;
  width: number;
  height: number;
  seed: number;
  preset: string;

  playing = false;
  speed = 6;
  generation = 0;

  private samples: Sample[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: SessionOptions) {
    this.width = opts.width;
    this.height = opts.height;
    this.seed = opts.seed;
    this.preset = opts.preset;
    this.world = this.build();
    this.samples = [sample(this.world)];
  }

  private build(): World {
    const cycles = CYCLE_PRESETS[this.preset];
    if (cycles === undefined) throw new Error(`Unknown cycle preset: ${this.preset}`);
    // Specs are passed straight through. `makeCycle` destructures every spec into a
    // fresh params object and never writes back to it, so the preset table cannot be
    // mutated by having been used — a defensive copy here would only obscure that.
    return new World({
      width: this.width,
      height: this.height,
      seed: this.seed,
      cycles,
    });
  }

  /** Rebuild the world from scratch. Same seed + preset ⇒ the same world, every time. */
  reset(opts: Partial<SessionOptions> = {}): void {
    this.pause();
    if (opts.seed !== undefined) this.seed = Math.floor(opts.seed);
    if (opts.preset !== undefined) this.preset = opts.preset;
    if (opts.width !== undefined) this.width = opts.width;
    if (opts.height !== undefined) this.height = opts.height;
    this.world = this.build();
    this.samples = [sample(this.world)];
    this.generation++;
  }

  /** Advance N days, recording one sample per day. */
  advance(days: number): void {
    for (let d = 0; d < days; d++) {
      this.world.stepDay();
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
    };
  }
}
