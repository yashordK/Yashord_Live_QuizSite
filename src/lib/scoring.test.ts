import { describe, it, expect } from "vitest";
import {
  computePoints,
  clampBonus,
  isWithinAnswerWindow,
  MAX_SPEED_BONUS,
  LATE_GRACE_MS,
} from "./scoring";

describe("computePoints", () => {
  it("gives zero for a wrong answer, however fast (no negative marking)", () => {
    expect(
      computePoints({ isCorrect: false, elapsedMs: 0, answerTimeSec: 20 })
    ).toBe(0);
    expect(
      computePoints({ isCorrect: false, elapsedMs: 19_000, answerTimeSec: 20 })
    ).toBe(0);
  });

  it("gives the documented headline numbers", () => {
    // Instant correct answer ~= 150
    expect(
      computePoints({ isCorrect: true, elapsedMs: 0, answerTimeSec: 20 })
    ).toBe(150);
    // Correct at the buzzer ~= 100
    expect(
      computePoints({ isCorrect: true, elapsedMs: 20_000, answerTimeSec: 20 })
    ).toBe(100);
    // Halfway through the window
    expect(
      computePoints({ isCorrect: true, elapsedMs: 10_000, answerTimeSec: 20 })
    ).toBe(125);
  });

  it("keeps correctness dominant over speed", () => {
    const slowCorrect = computePoints({
      isCorrect: true,
      elapsedMs: 19_999,
      answerTimeSec: 20,
    });
    const fastWrong = computePoints({
      isCorrect: false,
      elapsedMs: 200,
      answerTimeSec: 20,
    });
    expect(slowCorrect - fastWrong).toBeGreaterThanOrEqual(100);
  });

  it("never returns less than the base for a correct late answer", () => {
    // Request lands well past the window (clock skew, retry, slow network).
    expect(
      computePoints({ isCorrect: true, elapsedMs: 999_999, answerTimeSec: 20 })
    ).toBe(100);
  });

  it("never inflates the bonus above 50", () => {
    // Negative elapsed time would otherwise produce remaining > duration.
    expect(
      computePoints({ isCorrect: true, elapsedMs: -50_000, answerTimeSec: 20 })
    ).toBe(100 + MAX_SPEED_BONUS);
  });

  it("survives a zero or nonsense answer window", () => {
    expect(
      computePoints({ isCorrect: true, elapsedMs: 100, answerTimeSec: 0 })
    ).toBe(100);
    expect(
      computePoints({ isCorrect: true, elapsedMs: 100, answerTimeSec: -5 })
    ).toBe(100);
    expect(
      computePoints({ isCorrect: true, elapsedMs: NaN, answerTimeSec: 20 })
    ).toBe(150);
  });

  it("respects a custom base points value", () => {
    expect(
      computePoints({
        isCorrect: true,
        elapsedMs: 0,
        answerTimeSec: 20,
        basePoints: 200,
      })
    ).toBe(250);
  });

  it("is monotonically non-increasing as elapsed time grows", () => {
    let prev = Infinity;
    for (let ms = 0; ms <= 25_000; ms += 500) {
      const p = computePoints({
        isCorrect: true,
        elapsedMs: ms,
        answerTimeSec: 20,
      });
      expect(p).toBeLessThanOrEqual(prev);
      expect(p).toBeGreaterThanOrEqual(100);
      expect(p).toBeLessThanOrEqual(150);
      prev = p;
    }
  });
});

describe("clampBonus", () => {
  it("clamps to [0, 50] and rounds", () => {
    expect(clampBonus(-10)).toBe(0);
    expect(clampBonus(999)).toBe(50);
    expect(clampBonus(24.4)).toBe(24);
    expect(clampBonus(24.6)).toBe(25);
    // Non-finite input forfeits the bonus rather than maxing it. Both
    // NaN and Infinity mean "we can't trust this number", and the safe
    // reading of an untrustworthy number is zero bonus, not full bonus.
    expect(clampBonus(NaN)).toBe(0);
    expect(clampBonus(Infinity)).toBe(0);
    expect(clampBonus(-Infinity)).toBe(0);
  });
});

describe("isWithinAnswerWindow", () => {
  it("accepts answers inside the window and inside the grace period", () => {
    expect(isWithinAnswerWindow(0, 20)).toBe(true);
    expect(isWithinAnswerWindow(20_000, 20)).toBe(true);
    expect(isWithinAnswerWindow(20_000 + LATE_GRACE_MS - 1, 20)).toBe(true);
  });

  it("rejects answers past the grace period", () => {
    expect(isWithinAnswerWindow(20_000 + LATE_GRACE_MS + 1, 20)).toBe(false);
    expect(isWithinAnswerWindow(60_000, 20)).toBe(false);
  });

  it("accepts anything when no duration is set", () => {
    expect(isWithinAnswerWindow(999_999, null)).toBe(true);
  });
});
