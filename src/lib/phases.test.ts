import { describe, it, expect } from "vitest";
import {
  applyAction,
  PhaseError,
  phaseAcceptsAnswers,
  phaseShowsAnswerKey,
  phaseShowsOptions,
  questionNumber,
  remainingSeconds,
  type MachineContext,
  type MachineState,
  type HostAction,
} from "./phases";
import { PHASES } from "./types";

function makeCtx(count = 6, interval = 5): MachineContext {
  return {
    leaderboardInterval: interval,
    questions: Array.from({ length: count }, (_, i) => ({
      order_index: i + 1,
      reading_time_sec: 5,
      answer_time_sec: 20,
      skipped: false,
    })),
  };
}

const IDLE: MachineState = {
  phase: "IDLE",
  status: "lobby",
  currentIndex: null,
  leaderboardShownAfter: 0,
};

function at(phase: MachineState["phase"], index: number | null = 1): MachineState {
  return { phase, status: "live", currentIndex: index, leaderboardShownAfter: 0 };
}

describe("answer window is exactly one phase", () => {
  it("only ACCEPTING_ANSWERS accepts answers", () => {
    for (const p of PHASES) {
      expect(phaseAcceptsAnswers(p)).toBe(p === "ACCEPTING_ANSWERS");
    }
  });

  it("never exposes the answer key before REVEALED", () => {
    for (const p of PHASES) {
      const shouldShow = p === "REVEALED" || p === "SOLUTION";
      expect(phaseShowsAnswerKey(p), p).toBe(shouldShow);
    }
    expect(phaseShowsAnswerKey("ACCEPTING_ANSWERS")).toBe(false);
    expect(phaseShowsAnswerKey("LOCKED")).toBe(false);
  });

  it("hides options during QUESTION_ONLY", () => {
    expect(phaseShowsOptions("QUESTION_ONLY")).toBe(false);
    expect(phaseShowsOptions("ACCEPTING_ANSWERS")).toBe(true);
  });
});

describe("the reveal is one-way", () => {
  it("refuses to reopen answering once the key is public", () => {
    for (const phase of ["REVEALED", "SOLUTION"] as const) {
      expect(() => applyAction(at(phase), "SHOW_OPTIONS", makeCtx())).toThrow(
        PhaseError
      );
      try {
        applyAction(at(phase), "SHOW_OPTIONS", makeCtx());
      } catch (e) {
        expect((e as Error).message).toMatch(/already public/i);
      }
    }
  });

  it("allows reopening from LOCKED so the host can grant more time", () => {
    const r = applyAction(at("LOCKED"), "SHOW_OPTIONS", makeCtx());
    expect(r.phase).toBe("ACCEPTING_ANSWERS");
    // Reopening restarts the answer clock.
    expect(r.durationSec).toBe(20);
  });
});

describe("happy path", () => {
  it("walks IDLE -> question -> answers -> lock -> reveal -> solution -> next", () => {
    const ctx = makeCtx();
    let s: MachineState = IDLE;
    const step = (a: HostAction) => {
      const r = applyAction(s, a, ctx);
      s = {
        phase: r.phase,
        status: r.status,
        currentIndex: r.currentIndex,
        leaderboardShownAfter: r.leaderboardShownAfter,
      };
      return r;
    };

    expect(step("START").phase).toBe("QUESTION_ONLY");
    expect(s.currentIndex).toBe(1);

    expect(step("SHOW_OPTIONS").phase).toBe("ACCEPTING_ANSWERS");
    expect(step("LOCK").phase).toBe("LOCKED");
    expect(step("REVEAL").phase).toBe("REVEALED");
    expect(step("SOLUTION").phase).toBe("SOLUTION");

    expect(step("NEXT").phase).toBe("QUESTION_ONLY");
    expect(s.currentIndex).toBe(2);
  });

  it("sets the reading timer entering a question and the answer timer opening it", () => {
    const ctx = makeCtx();
    expect(applyAction(IDLE, "START", ctx).durationSec).toBe(5);
    expect(applyAction(at("QUESTION_ONLY"), "SHOW_OPTIONS", ctx).durationSec).toBe(20);
  });

  it("clears the timer for phases that don't count down", () => {
    const ctx = makeCtx();
    for (const a of ["LOCK", "REVEAL", "LEADERBOARD"] as const) {
      const from = a === "LOCK" ? at("ACCEPTING_ANSWERS") : at("LOCKED");
      expect(applyAction(from, a, ctx).durationSec).toBeNull();
    }
  });

  it("lets REVEAL implicitly lock from an open window", () => {
    expect(applyAction(at("ACCEPTING_ANSWERS"), "REVEAL", makeCtx()).phase).toBe(
      "REVEALED"
    );
  });
});

describe("auto leaderboard cadence", () => {
  it("interrupts NEXT after question 5 to show the leaderboard", () => {
    const ctx = makeCtx(12, 5);
    const r = applyAction(at("SOLUTION", 5), "NEXT", ctx);
    expect(r.phase).toBe("LEADERBOARD");
    expect(r.currentIndex).toBe(5);
    expect(r.leaderboardShownAfter).toBe(5);
  });

  it("advances to question 6 on the following NEXT", () => {
    const ctx = makeCtx(12, 5);
    const s: MachineState = {
      phase: "LEADERBOARD",
      status: "live",
      currentIndex: 5,
      leaderboardShownAfter: 5,
    };
    const r = applyAction(s, "NEXT", ctx);
    expect(r.phase).toBe("QUESTION_ONLY");
    expect(r.currentIndex).toBe(6);
  });

  it("does not re-trigger when the host navigates back over the boundary", () => {
    const ctx = makeCtx(12, 5);
    const s: MachineState = {
      phase: "SOLUTION",
      status: "live",
      currentIndex: 5,
      leaderboardShownAfter: 5,
    };
    expect(applyAction(s, "NEXT", ctx).phase).toBe("QUESTION_ONLY");
  });

  it("does not fire on non-multiples", () => {
    const ctx = makeCtx(12, 5);
    expect(applyAction(at("SOLUTION", 4), "NEXT", ctx).phase).toBe("QUESTION_ONLY");
  });

  it("can be disabled with interval 0", () => {
    const ctx = makeCtx(12, 0);
    expect(applyAction(at("SOLUTION", 5), "NEXT", ctx).phase).toBe("QUESTION_ONLY");
  });

  it("lands on a final leaderboard past the last question", () => {
    const ctx = makeCtx(6, 5);
    const r = applyAction(at("SOLUTION", 6), "NEXT", ctx);
    expect(r.phase).toBe("LEADERBOARD");
  });
});

describe("skip", () => {
  it("marks the current question skipped and moves on", () => {
    const ctx = makeCtx(6);
    const r = applyAction(at("QUESTION_ONLY", 2), "SKIP", ctx);
    expect(r.skipIndex).toBe(2);
    expect(r.currentIndex).toBe(3);
    expect(r.phase).toBe("QUESTION_ONLY");
  });

  it("steps over already-skipped questions when advancing", () => {
    const ctx = makeCtx(6);
    ctx.questions[2].skipped = true; // order_index 3
    const r = applyAction(at("SOLUTION", 2), "NEXT", ctx);
    expect(r.currentIndex).toBe(4);
  });

  it("excludes skipped questions from the numbering shown to students", () => {
    const ctx = makeCtx(6);
    ctx.questions[1].skipped = true; // order_index 2
    expect(questionNumber(ctx.questions, 1)).toBe(1);
    expect(questionNumber(ctx.questions, 3)).toBe(2);
  });
});

describe("navigation guards", () => {
  it("refuses PREV on the first question", () => {
    expect(() => applyAction(at("QUESTION_ONLY", 1), "PREV", makeCtx())).toThrow(
      /first question/i
    );
  });

  it("refuses LOCK outside an open window", () => {
    expect(() => applyAction(at("REVEALED"), "LOCK", makeCtx())).toThrow(PhaseError);
  });

  it("reports a clear error when no questions are loaded", () => {
    expect(() => applyAction(IDLE, "START", makeCtx(0))).toThrow(/no questions/i);
  });

  it("allows the leaderboard from any live phase", () => {
    for (const p of ["QUESTION_ONLY", "ACCEPTING_ANSWERS", "LOCKED", "REVEALED", "SOLUTION"] as const) {
      expect(applyAction(at(p), "LEADERBOARD", makeCtx()).phase).toBe("LEADERBOARD");
    }
  });

  it("RESET returns to a clean IDLE lobby", () => {
    const r = applyAction(at("SOLUTION", 4), "RESET", makeCtx());
    expect(r).toMatchObject({
      phase: "IDLE",
      status: "lobby",
      currentIndex: null,
      leaderboardShownAfter: 0,
    });
  });

  it("END marks the session ended", () => {
    const r = applyAction(at("SOLUTION", 6), "END", makeCtx());
    expect(r.status).toBe("ended");
  });
});

describe("remainingSeconds", () => {
  const start = "2026-08-14T10:00:00.000Z";
  const t0 = Date.parse(start);

  it("counts down from the server timestamp", () => {
    expect(remainingSeconds(start, 20, t0)).toBe(20);
    expect(remainingSeconds(start, 20, t0 + 5000)).toBe(15);
  });

  it("floors at zero rather than going negative", () => {
    expect(remainingSeconds(start, 20, t0 + 60_000)).toBe(0);
  });

  it("returns null when the phase has no timer", () => {
    expect(remainingSeconds(start, null, t0)).toBeNull();
  });

  it("returns null on an unparseable timestamp instead of NaN", () => {
    expect(remainingSeconds("not-a-date", 20, t0)).toBeNull();
  });
});
