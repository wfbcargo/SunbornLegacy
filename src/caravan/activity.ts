/**
 * Tile activities — remain stationary for N ticks (Session 12 survey primitive).
 */

import { depositRefunds } from './inventory.ts';
import { positionAt } from './legs.ts';
import { deriveStats } from './derive.ts';
import {
  Form,
  type Caravan,
  type FitResult,
  type TileActivity,
  type TileCoord,
} from './types.ts';

export const SURVEY_DURATION = 100;
export const SURVEY_NOTES = 'survey_notes';

export type ActivityProgress = {
  kind: 'survey';
  tile: TileCoord;
  startStep: number;
  durationTicks: number;
  elapsed: number;
  remaining: number;
  fraction: number;
  done: boolean;
};

export type ProgressOk = { ok: true; progress: ActivityProgress };
export type ProgressErr = { ok: false; reason: string };
export type ProgressResult = ProgressOk | ProgressErr;

export type ResolveReport = {
  completed: boolean;
  tile?: TileCoord;
};

function cloneTile(t: TileCoord): TileCoord {
  return { col: t.col, row: t.row };
}

function characterCount(caravan: Caravan): number {
  return deriveStats(caravan).characterCount;
}

export function canStartSurvey(caravan: Caravan, step: number): FitResult {
  if (caravan.form === Form.derelict) {
    return { ok: false, reason: 'cannot survey while derelict; salvage first' };
  }
  if (caravan.activity) {
    return { ok: false, reason: 'already running a tile activity; cancel or finish it first' };
  }
  const stats = deriveStats(caravan);
  if (caravan.form !== Form.caravan || !stats.mobile) {
    return { ok: false, reason: 'cannot survey while settled as an outpost; mobilise first' };
  }
  if (characterCount(caravan) < 1) {
    return { ok: false, reason: 'need at least one fitted character to survey' };
  }
  const pos = positionAt(caravan, step);
  if (pos.travelling) {
    return {
      ok: false,
      reason: `still travelling at step ${step}; arrive or stall before surveying`,
    };
  }
  return { ok: true };
}

export function startSurvey(caravan: Caravan, step: number): FitResult {
  const gate = canStartSurvey(caravan, step);
  if (!gate.ok) return gate;
  const pos = positionAt(caravan, step);
  const activity: TileActivity = {
    kind: 'survey',
    tile: cloneTile(pos.tile),
    startStep: step,
    durationTicks: SURVEY_DURATION,
  };
  caravan.activity = activity;
  return { ok: true };
}

export function activityProgress(caravan: Caravan, step: number): ProgressResult {
  const a = caravan.activity;
  if (!a) return { ok: false, reason: 'no tile activity in progress' };
  const elapsed = Math.max(0, Math.min(a.durationTicks, step - a.startStep));
  const remaining = a.durationTicks - elapsed;
  const fraction = a.durationTicks === 0 ? 1 : elapsed / a.durationTicks;
  return {
    ok: true,
    progress: {
      kind: a.kind,
      tile: cloneTile(a.tile),
      startStep: a.startStep,
      durationTicks: a.durationTicks,
      elapsed,
      remaining,
      fraction,
      done: elapsed >= a.durationTicks,
    },
  };
}

/** Clear activity with no reward (explicit cancel or travel/settle interrupt). */
export function cancelActivity(caravan: Caravan): boolean {
  if (!caravan.activity) return false;
  caravan.activity = null;
  return true;
}

/**
 * If the active survey's duration has elapsed at `step`, deposit notes and clear.
 * Idempotent when no activity.
 */
export function resolveActivity(caravan: Caravan, step: number): ResolveReport {
  const prog = activityProgress(caravan, step);
  if (!prog.ok || !prog.progress.done) {
    return { completed: false };
  }
  const tile = cloneTile(prog.progress.tile);
  caravan.activity = null;
  depositRefunds(caravan, [{ materialId: SURVEY_NOTES, qty: 1 }]);
  return { completed: true, tile };
}
