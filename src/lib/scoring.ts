/**
 * Scoring. Locked formula:
 *
 *   wrong or unanswered  -> 0                       (no negative marking)
 *   correct              -> 100 + round(50 * time_remaining / answer_time_sec)
 *
 * `time_remaining` is derived from the server-recorded elapsed time since
 * `phase_started_at`. A client-reported timestamp is never an input here.
 * The bonus is clamped to [0, 50] so a late-arriving request can produce
 * neither a negative score nor an inflated one.
 */

export const MAX_SPEED_BONUS = 50;

/**
 * Grace window past the answer timer. A request that left the phone
 * before the timer expired can still be in flight when it does; without
 * this, students on slow mobile data get robbed of legitimate answers.
 * Answers landing inside the grace window score the base points with a
 * zero bonus (the clamp handles that automatically).
 */
export const LATE_GRACE_MS = 1500;

export function clampBonus(bonus: number): number {
  if (!Number.isFinite(bonus)) return 0;
  return Math.max(0, Math.min(MAX_SPEED_BONUS, Math.round(bonus)));
}

export interface ScoreInput {
  isCorrect: boolean;
  /** Server-measured ms from phase_started_at to request arrival. */
  elapsedMs: number;
  answerTimeSec: number;
  /** Base points for this question; defaults to 100. */
  basePoints?: number;
}

export function computePoints({
  isCorrect,
  elapsedMs,
  answerTimeSec,
  basePoints = 100,
}: ScoreInput): number {
  if (!isCorrect) return 0;

  // A question with no answer window can't earn a speed bonus.
  if (!Number.isFinite(answerTimeSec) || answerTimeSec <= 0) {
    return basePoints;
  }

  const safeElapsedMs = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  const remainingSec = answerTimeSec - safeElapsedMs / 1000;
  const bonus = clampBonus((MAX_SPEED_BONUS * remainingSec) / answerTimeSec);

  return basePoints + bonus;
}

/**
 * Whether an answer arriving now is still inside the open window.
 * Phase is checked separately (and again by a database trigger); this is
 * purely the timing-sanity check from the plan's anti-abuse section.
 */
export function isWithinAnswerWindow(
  elapsedMs: number,
  answerTimeSec: number | null
): boolean {
  if (answerTimeSec === null || !Number.isFinite(answerTimeSec)) return true;
  return elapsedMs <= answerTimeSec * 1000 + LATE_GRACE_MS;
}
