"use client";

import { useEffect, type CSSProperties } from "react";
import { Bolt } from "./Bolt";
import { burst } from "./confetti";
import { seeded, useCountUp, vibrate, type OnceMode } from "./core";

/**
 * The per-student verdict after a reveal.
 *
 *   correct  Bolt hops, confetti fires from the exact option they tapped,
 *            a happy haptic pattern, points count up
 *   wrong    Bolt under a rain cloud, one long sad buzz; lands after the
 *            question has started to crumble
 *   missed   no collapse — they didn't build anything wrong — Bolt just
 *            scratches his head
 *
 * Headlines are seeded by question, so neighbours see the same line and
 * it doesn't reshuffle on a poll.
 */

const LINES = {
  correct: [
    "Nailed it!",
    "Structurally sound!",
    "Engineered to perfection.",
    "That's a load-bearing answer.",
    "Precision engineering.",
    "Bang on target!",
  ],
  wrong: [
    "The bridge collapsed.",
    "Structural failure…",
    "Back to the drawing board.",
    "That one didn't hold up.",
    "Not this time.",
  ],
  missed: ["Time slipped past you.", "The window closed.", "Blink and it's gone."],
};

type Kind = "correct" | "wrong" | "missed" | "voided";

export function ResultCard({
  questionId,
  mode,
  answered,
  correct,
  points,
  voided,
  correctLabel,
  correctElement,
}: {
  questionId: string;
  mode: OnceMode;
  answered: boolean;
  correct: boolean | null;
  points: number | null;
  voided: boolean;
  correctLabel: string;
  /** The correct option's card, so confetti can fire from it. */
  correctElement: () => HTMLElement | null;
}) {
  const kind: Kind = voided ? "voided" : !answered ? "missed" : correct ? "correct" : "wrong";
  const animate = mode === "animate";

  useEffect(() => {
    if (!animate) return;

    if (kind === "correct") {
      vibrate([40, 50, 40, 50, 130]);
      const first = window.setTimeout(() => {
        const rect = correctElement()?.getBoundingClientRect();
        const x = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
        const y = rect ? rect.top + rect.height / 2 : window.innerHeight * 0.6;
        burst({ x, y, count: 110, spread: 110, power: 14 });
      }, 180);
      const second = window.setTimeout(() => {
        burst({ x: window.innerWidth / 2, y: window.innerHeight + 10, count: 70, spread: 50, power: 20 });
      }, 460);
      return () => {
        clearTimeout(first);
        clearTimeout(second);
      };
    }

    if (kind === "wrong") vibrate(180);
    // correctElement is a stable getter; the effect must only fire on the
    // animate transition, not whenever the parent re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [animate, kind]);

  const shown = useCountUp(points ?? 0, {
    duration: 900,
    delay: 380,
    enabled: animate && kind === "correct",
  });

  if (kind === "voided") {
    return (
      <p className="mt-5 rounded-xl border border-warn/40 bg-warn/10 px-4 py-4 text-center font-semibold text-warn">
        This question was voided — nobody scored on it.
      </p>
    );
  }

  const pool = LINES[kind];
  const headline = pool[Math.floor(seeded(`line:${kind}:${questionId}`)() * pool.length)];

  const tone =
    kind === "correct"
      ? "border-good/50 bg-good/10"
      : kind === "wrong"
        ? "border-bad/45 bg-bad/10"
        : "border-edge bg-panel/80";

  const entrance = mode === "pending" ? "fx-wait" : animate ? "result-pop" : "";

  return (
    <div
      role="status"
      className={`mt-5 flex items-center gap-3 rounded-2xl border px-3 py-3 ${tone} ${entrance}`}
      style={{ "--rdl": kind === "wrong" ? "900ms" : "120ms" } as CSSProperties}
    >
      <Bolt
        mood={kind === "correct" ? "happy" : kind === "wrong" ? "sad" : "missed"}
        size={88}
        className="shrink-0"
      />
      <div className="min-w-0">
        <p
          className={`text-xl font-extrabold leading-tight ${
            kind === "correct" ? "text-green-200" : kind === "wrong" ? "text-red-200" : "text-slate-200"
          }`}
        >
          {headline}
        </p>
        <p className="mt-1 text-sm text-slate-300">
          {kind === "correct" ? (
            <>
              <span className="font-mono text-2xl font-bold tabular-nums text-green-300">+{shown}</span>{" "}
              points
            </>
          ) : kind === "wrong" ? (
            <>
              0 points · the answer was <b className="text-slate-100">{correctLabel}</b>
            </>
          ) : (
            <>0 points · no answer was locked in</>
          )}
        </p>
      </div>
    </div>
  );
}
