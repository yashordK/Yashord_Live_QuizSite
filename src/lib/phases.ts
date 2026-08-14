import type { Phase, SessionStatus } from "./types";

/**
 * The session state machine, as pure functions so it can be unit-tested
 * without a database.
 *
 *   IDLE
 *    └─ START / NEXT ─────────> QUESTION_ONLY      (text only, no options)
 *        └─ SHOW_OPTIONS ─────> ACCEPTING_ANSWERS  (the only answerable phase)
 *            └─ LOCK ─────────> LOCKED
 *                └─ REVEAL ───> REVEALED
 *                    └─ SOLUTION ─> SOLUTION
 *                        └─ NEXT ─> QUESTION_ONLY (next question)
 *
 * The host may also jump to LEADERBOARD at any point, step back a
 * question, or skip one. Two rules are enforced rather than advisory:
 *
 *  1. Answers are only ever accepted in ACCEPTING_ANSWERS. Checked here,
 *     again in /api/answer, and again by a database trigger.
 *  2. A question that has already been REVEALED can never be reopened
 *     for answers. Reopening from LOCKED is allowed (the host wants to
 *     give more time); reopening once the key is public is not.
 */

export type HostAction =
  | "START"
  | "SHOW_OPTIONS"
  | "LOCK"
  | "REVEAL"
  | "SOLUTION"
  | "LEADERBOARD"
  | "NEXT"
  | "PREV"
  | "SKIP"
  | "END"
  | "RESET";

export interface MachineQuestion {
  order_index: number;
  reading_time_sec: number;
  answer_time_sec: number;
  skipped: boolean;
}

export interface MachineState {
  phase: Phase;
  status: SessionStatus;
  /** order_index of the current question, or null in IDLE. */
  currentIndex: number | null;
  leaderboardShownAfter: number;
}

export interface MachineContext {
  questions: MachineQuestion[];
  leaderboardInterval: number;
}

export interface MachineResult {
  phase: Phase;
  status: SessionStatus;
  currentIndex: number | null;
  /** Countdown length for the new phase; null means "no timer". */
  durationSec: number | null;
  leaderboardShownAfter: number;
  /** Set when the action marks the outgoing question as skipped. */
  skipIndex?: number;
}

export class PhaseError extends Error {}

/** Phases from which each action is legal. */
const LEGAL_FROM: Record<HostAction, Phase[]> = {
  START: ["IDLE"],
  // Reopening from LOCKED is intentional (host grants more time).
  // REVEALED and SOLUTION are absent on purpose — once the answer key is
  // public, the window can never be reopened.
  SHOW_OPTIONS: ["QUESTION_ONLY", "LOCKED"],
  LOCK: ["ACCEPTING_ANSWERS"],
  // REVEAL from ACCEPTING_ANSWERS implicitly locks first.
  REVEAL: ["ACCEPTING_ANSWERS", "LOCKED", "LEADERBOARD"],
  SOLUTION: ["REVEALED", "LEADERBOARD"],
  LEADERBOARD: [
    "QUESTION_ONLY",
    "ACCEPTING_ANSWERS",
    "LOCKED",
    "REVEALED",
    "SOLUTION",
    "LEADERBOARD",
  ],
  NEXT: [
    "IDLE",
    "QUESTION_ONLY",
    "ACCEPTING_ANSWERS",
    "LOCKED",
    "REVEALED",
    "SOLUTION",
    "LEADERBOARD",
  ],
  PREV: [
    "QUESTION_ONLY",
    "ACCEPTING_ANSWERS",
    "LOCKED",
    "REVEALED",
    "SOLUTION",
    "LEADERBOARD",
  ],
  SKIP: [
    "QUESTION_ONLY",
    "ACCEPTING_ANSWERS",
    "LOCKED",
    "REVEALED",
    "SOLUTION",
  ],
  END: [
    "IDLE",
    "QUESTION_ONLY",
    "ACCEPTING_ANSWERS",
    "LOCKED",
    "REVEALED",
    "SOLUTION",
    "LEADERBOARD",
  ],
  RESET: [
    "IDLE",
    "QUESTION_ONLY",
    "ACCEPTING_ANSWERS",
    "LOCKED",
    "REVEALED",
    "SOLUTION",
    "LEADERBOARD",
  ],
};

/** Only ACCEPTING_ANSWERS accepts submissions. Single source of truth. */
export function phaseAcceptsAnswers(phase: Phase): boolean {
  return phase === "ACCEPTING_ANSWERS";
}

/** Options are withheld from students until the answer window opens. */
export function phaseShowsOptions(phase: Phase): boolean {
  return (
    phase === "ACCEPTING_ANSWERS" ||
    phase === "LOCKED" ||
    phase === "REVEALED" ||
    phase === "SOLUTION"
  );
}

/** The answer key becomes public only from REVEALED onward. */
export function phaseShowsAnswerKey(phase: Phase): boolean {
  return phase === "REVEALED" || phase === "SOLUTION";
}

export function phaseShowsSolution(phase: Phase): boolean {
  return phase === "SOLUTION";
}

function playable(questions: MachineQuestion[]): MachineQuestion[] {
  return questions.filter((q) => !q.skipped).sort((a, b) => a.order_index - b.order_index);
}

function findQuestion(
  questions: MachineQuestion[],
  index: number | null
): MachineQuestion | null {
  if (index === null) return null;
  return questions.find((q) => q.order_index === index) ?? null;
}

function nextPlayableAfter(
  questions: MachineQuestion[],
  index: number | null
): MachineQuestion | null {
  const list = playable(questions);
  if (index === null) return list[0] ?? null;
  return list.find((q) => q.order_index > index) ?? null;
}

function prevPlayableBefore(
  questions: MachineQuestion[],
  index: number | null
): MachineQuestion | null {
  const list = playable(questions);
  if (index === null) return null;
  const before = list.filter((q) => q.order_index < index);
  return before[before.length - 1] ?? null;
}

/** 1-based position of a question among the playable ones. */
export function questionNumber(
  questions: MachineQuestion[],
  index: number | null
): number | null {
  if (index === null) return null;
  const pos = playable(questions).findIndex((q) => q.order_index === index);
  return pos === -1 ? null : pos + 1;
}

export function playableCount(questions: MachineQuestion[]): number {
  return playable(questions).length;
}

function enterQuestion(
  q: MachineQuestion,
  leaderboardShownAfter: number
): MachineResult {
  return {
    phase: "QUESTION_ONLY",
    status: "live",
    currentIndex: q.order_index,
    durationSec: q.reading_time_sec,
    leaderboardShownAfter,
  };
}

/**
 * Apply a host action. Throws PhaseError with a message suitable for
 * showing to the host when the action isn't legal from here.
 */
export function applyAction(
  state: MachineState,
  action: HostAction,
  ctx: MachineContext
): MachineResult {
  const legal = LEGAL_FROM[action];
  if (!legal) throw new PhaseError(`Unknown action "${action}".`);

  if (!legal.includes(state.phase)) {
    if (action === "SHOW_OPTIONS" && (state.phase === "REVEALED" || state.phase === "SOLUTION")) {
      throw new PhaseError(
        "The answer for this question is already public, so answering can't be reopened. Move to the next question instead."
      );
    }
    throw new PhaseError(
      `"${action}" isn't available from ${state.phase}.`
    );
  }

  const current = findQuestion(ctx.questions, state.currentIndex);

  switch (action) {
    case "START":
    case "NEXT": {
      // Auto-leaderboard: after finishing question N where N is a
      // multiple of the interval, show the leaderboard once before
      // moving on. `leaderboardShownAfter` stops it re-triggering if the
      // host navigates back across the same boundary.
      if (action === "NEXT" && current && state.phase !== "LEADERBOARD") {
        const n = questionNumber(ctx.questions, current.order_index);
        const interval = ctx.leaderboardInterval;
        if (
          n !== null &&
          interval > 0 &&
          n % interval === 0 &&
          state.leaderboardShownAfter !== current.order_index
        ) {
          return {
            phase: "LEADERBOARD",
            status: "live",
            currentIndex: current.order_index,
            durationSec: null,
            leaderboardShownAfter: current.order_index,
          };
        }
      }

      const next = nextPlayableAfter(ctx.questions, state.currentIndex);
      if (!next) {
        if (playableCount(ctx.questions) === 0) {
          throw new PhaseError(
            "There are no questions loaded for this session yet."
          );
        }
        // Past the last question: land on the final leaderboard.
        return {
          phase: "LEADERBOARD",
          status: "live",
          currentIndex: state.currentIndex,
          durationSec: null,
          leaderboardShownAfter: state.leaderboardShownAfter,
        };
      }
      return enterQuestion(next, state.leaderboardShownAfter);
    }

    case "PREV": {
      const prev = prevPlayableBefore(ctx.questions, state.currentIndex);
      if (!prev) {
        throw new PhaseError("You're already on the first question.");
      }
      return enterQuestion(prev, state.leaderboardShownAfter);
    }

    case "SKIP": {
      if (!current) throw new PhaseError("There's no current question to skip.");
      const next = nextPlayableAfter(ctx.questions, current.order_index);
      if (!next) {
        return {
          phase: "LEADERBOARD",
          status: "live",
          currentIndex: null,
          durationSec: null,
          leaderboardShownAfter: state.leaderboardShownAfter,
          skipIndex: current.order_index,
        };
      }
      return { ...enterQuestion(next, state.leaderboardShownAfter), skipIndex: current.order_index };
    }

    case "SHOW_OPTIONS": {
      if (!current) throw new PhaseError("There's no current question.");
      return {
        phase: "ACCEPTING_ANSWERS",
        status: "live",
        currentIndex: current.order_index,
        durationSec: current.answer_time_sec,
        leaderboardShownAfter: state.leaderboardShownAfter,
      };
    }

    case "LOCK":
      return {
        phase: "LOCKED",
        status: "live",
        currentIndex: state.currentIndex,
        durationSec: null,
        leaderboardShownAfter: state.leaderboardShownAfter,
      };

    case "REVEAL":
      if (state.currentIndex === null) {
        throw new PhaseError("There's no current question to reveal.");
      }
      return {
        phase: "REVEALED",
        status: "live",
        currentIndex: state.currentIndex,
        durationSec: null,
        leaderboardShownAfter: state.leaderboardShownAfter,
      };

    case "SOLUTION":
      if (state.currentIndex === null) {
        throw new PhaseError("There's no current question.");
      }
      return {
        phase: "SOLUTION",
        status: "live",
        currentIndex: state.currentIndex,
        durationSec: null,
        leaderboardShownAfter: state.leaderboardShownAfter,
      };

    case "LEADERBOARD":
      return {
        phase: "LEADERBOARD",
        status: "live",
        currentIndex: state.currentIndex,
        durationSec: null,
        leaderboardShownAfter: state.leaderboardShownAfter,
      };

    case "END":
      return {
        phase: "LEADERBOARD",
        status: "ended",
        currentIndex: state.currentIndex,
        durationSec: null,
        leaderboardShownAfter: state.leaderboardShownAfter,
      };

    case "RESET":
      return {
        phase: "IDLE",
        status: "lobby",
        currentIndex: null,
        durationSec: null,
        leaderboardShownAfter: 0,
      };
  }
}

/** Seconds left in the current phase, computed from server timestamps only. */
export function remainingSeconds(
  phaseStartedAt: string,
  durationSec: number | null,
  nowMs: number
): number | null {
  if (durationSec === null) return null;
  const started = Date.parse(phaseStartedAt);
  if (!Number.isFinite(started)) return null;
  const elapsed = (nowMs - started) / 1000;
  return Math.max(0, durationSec - elapsed);
}
