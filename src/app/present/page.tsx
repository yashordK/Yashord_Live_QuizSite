"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useQuizState, useCountdown } from "@/lib/useQuizState";
import { Leaderboard } from "@/components/Leaderboard";
import { FlyInText } from "@/components/fx/FlyInText";
import { Podium } from "@/components/fx/Podium";
import { burst } from "@/components/fx/confetti";
import { useOnce } from "@/components/fx/core";
import { useAudioUnlock } from "@/components/fx/sound";
import type { LeaderboardEntry } from "@/lib/types";

/**
 * Projector view. Runs on the screen at the front of the room while the
 * host drives /host/control on their own laptop or phone.
 *
 * Two rules this page exists to enforce:
 *   - NO controls. Nothing here can change the session, so a stray click
 *     on the presentation machine can't advance the quiz.
 *   - NO answer key before REVEALED. This page never requests the host
 *     payload, so the correct option is not merely hidden in the DOM —
 *     it isn't in the response at all until the phase makes it public.
 */
export default function PresentPage() {
  const { state, serverNow } = useQuizState();

  const phase = state?.session.phase;
  const question = state?.question ?? null;

  const remaining = useCountdown(
    state?.session.phase_started_at,
    state?.session.phase_duration_sec,
    serverNow
  );

  const [board, setBoard] = useState<LeaderboardEntry[]>([]);
  const showsBoard = phase === "LEADERBOARD" || phase === "PODIUM";
  const stateVersion = state?.state_version;

  useEffect(() => {
    if (!showsBoard) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/leaderboard", { cache: "no-store" });
        if (!res.ok) return;
        const b = await res.json();
        if (!cancelled) setBoard(b.entries);
      } catch {
        /* cosmetic */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [showsBoard, stateVersion]);

  // ---- motion ---------------------------------------------------------
  const qid = question?.id;
  const optsMode = useOnce(question?.options && qid ? `present-opts:${qid}` : null);
  const revealMode = useOnce(
    (phase === "REVEALED" || phase === "SOLUTION") && qid ? `present-reveal:${qid}` : null
  );
  const correctCardRef = useRef<HTMLDivElement | null>(null);
  const soundOn = useAudioUnlock(["cheer"]);

  // The room's moment: confetti bursts out of the right answer's card.
  useEffect(() => {
    if (revealMode !== "animate") return;
    const id = window.setTimeout(() => {
      const r = correctCardRef.current?.getBoundingClientRect();
      if (!r) return;
      burst({ x: r.left + r.width / 2, y: r.top + r.height / 2, count: 150, spread: 360, power: 15 });
    }, 260);
    return () => clearTimeout(id);
  }, [revealMode]);

  if (!state) {
    return (
      <div className="present-root flex items-center justify-center">
        <p className="text-4xl text-slate-500">Connecting…</p>
      </div>
    );
  }

  const urgent = remaining !== null && remaining <= 5;

  return (
    <div className="present-root flex flex-col px-[3vw] py-[2vh]">
      {/* Nobody taps the projector, and browsers stay silent until someone
          does. One click here (or any key) enables the podium cheer; the
          button disappears once sound is live. */}
      {!soundOn && (
        <button
          type="button"
          className="fixed bottom-4 left-4 z-50 rounded-full border border-edge bg-panel/90 px-4 py-2 text-sm font-semibold text-slate-300 hover:border-accent"
        >
          🔊 Click to enable sound
        </button>
      )}
      {/* ---- top strip: join info + progress + timer ---- */}
      <header
        className="flex shrink-0 flex-wrap items-center justify-between gap-x-[2vw] gap-y-2 border-b border-edge pb-[1.5vh]"
        style={{ fontSize: "clamp(0.95rem, 1.5vw, 2rem)" }}
      >
        <div className="flex items-baseline gap-8">
          {phase === "IDLE" ? (
            <span className="text-slate-400">Join at the link on the board</span>
          ) : (
            <span className="font-bold text-slate-300">
              Question {state.question_number}
              <span className="text-slate-500"> / {state.question_total}</span>
            </span>
          )}
        </div>

        <div className="flex items-center gap-[2.5vw]">
          <span className="text-slate-400">
            Code <span className="font-mono font-bold text-slate-200">{state.session.code}</span>
          </span>
          <span className="text-slate-400">
            <span className="font-bold text-slate-200">{state.session.joined_count}</span> joined
          </span>
          {remaining !== null && (
            <span
              className={`font-mono font-bold tabular-nums ${
                urgent ? "text-warn timer-urgent" : "text-accent"
              }`}
              style={{ fontSize: "clamp(1.75rem, 3.5vw, 4rem)" }}
            >
              {Math.ceil(remaining)}
            </span>
          )}
        </div>
      </header>

      {/* ---- timer bar ---- */}
      {remaining !== null && state.session.phase_duration_sec ? (
        <div className="h-3 w-full shrink-0 overflow-hidden rounded-full bg-edge">
          <div
            className={`h-full transition-[width] duration-200 ease-linear ${
              urgent ? "bg-warn" : "bg-accent"
            }`}
            style={{
              width: `${Math.max(
                0,
                Math.min(100, (remaining / state.session.phase_duration_sec) * 100)
              )}%`,
            }}
          />
        </div>
      ) : (
        <div className="h-3 shrink-0" />
      )}

      {/* ---- body ---- */}
      <main className="flex min-h-0 flex-1 flex-col justify-center py-6">
        {phase === "IDLE" && (
          <div className="text-center">
            <h1 className="brand title-float text-present font-bold">{state.session.title}</h1>
            <p className="mt-10 text-5xl text-slate-400">
              {state.session.joining_locked
                ? "Joining is closed"
                : "Join now — the quiz starts shortly"}
            </p>
            <p className="mt-14 text-3xl text-slate-500">
              <span key={state.session.joined_count} className="count-pop">
                {state.session.joined_count}
              </span>{" "}
              / {state.session.join_cap} joined
            </p>
          </div>
        )}

        {question && phase !== "IDLE" && phase !== "LEADERBOARD" && phase !== "PODIUM" && (
          <>
            {/*
              Type scales with the viewport rather than using fixed sizes.
              A projector might be 16:9 or 4:3, 1080p or 720p, and a long
              question with four long options has to fit without clipping —
              a half-visible option in front of a lecture hall is the one
              failure this view exists to prevent. clamp() keeps it large
              on a big screen and lets it shrink rather than overflow on a
              short one.
            */}
            <FlyInText
              id={question.id}
              variant="stage"
              text={question.question_text}
              className="shrink-0 font-bold leading-tight"
              codeStyle={{
                fontSize: "clamp(0.85rem, min(1.6vw, 2.8vh), 2rem)",
                fontWeight: 400,
              }}
              style={{
                // Sized on min(vw, vh): vertical space is the real
                // constraint once four options are on screen, and a
                // width-only rule overflows on a 4:3 or short projector.
                fontSize:
                  question.question_text.length > 120
                    ? "clamp(1.25rem, min(2.6vw, 4.2vh), 3.25rem)"
                    : "clamp(1.5rem, min(3.4vw, 5.4vh), 4.5rem)",
              }}
            />

            {question.image_url && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={question.image_url}
                alt=""
                className="mt-4 min-h-0 flex-1 object-contain"
              />
            )}

            {/* Options appear only once the phase publishes them. */}
            {question.options && (
              <div
                className={`mt-[3vh] grid min-h-0 flex-1 auto-rows-fr gap-[1.5vh] overflow-y-auto ${
                  // Cap at TWO columns. auto-fit would give four across a
                  // 1920px projector, which makes each option a narrow
                  // column and wraps short answers like "Binary search
                  // tree" onto three lines. 2x2 keeps lines long and the
                  // type big, which is what reads from the back row.
                  question.options.length > 2
                    ? "grid-cols-1 md:grid-cols-2"
                    : "grid-cols-1"
                }`}
              >
                {question.options.map((o, i) => {
                  // Hold the reveal look for the one "pending" frame so the
                  // stamp animation starts from the un-revealed state.
                  const revealed = question.correct_option !== null && revealMode !== "pending";
                  const isCorrect = revealed && o.key === question.correct_option;
                  const dim = revealed && !isCorrect;
                  const motion =
                    revealMode === "animate" && revealed
                      ? isCorrect
                        ? " reveal-stamp"
                        : " reveal-sink"
                      : optsMode === "animate"
                        ? " option-in"
                        : optsMode === "pending"
                          ? " fx-wait"
                          : "";

                  return (
                    <div
                      key={o.key}
                      ref={o.key === question.correct_option ? correctCardRef : undefined}
                      className={`flex min-w-0 items-center gap-[2vw] rounded-2xl border-4 px-[2vw] py-[1.5vh] ${
                        isCorrect
                          ? "border-good bg-good/25"
                          : dim
                            ? `border-edge bg-panel${revealMode === "animate" ? "" : " opacity-40"}`
                            : "border-edge bg-panel"
                      }${motion}`}
                      style={{ "--odl": `${60 + i * 70}ms`, "--sdl": `${i * 90}ms` } as CSSProperties}
                    >
                      <span
                        className="flex shrink-0 items-center justify-center rounded-xl bg-edge font-bold"
                        style={{
                          width: "clamp(2rem, min(4vw, 6.5vh), 5rem)",
                          height: "clamp(2rem, min(4vw, 6.5vh), 5rem)",
                          fontSize: "clamp(1rem, min(2.2vw, 3.5vh), 3rem)",
                        }}
                      >
                        {o.key}
                      </span>
                      <span
                        className="min-w-0 leading-snug"
                        style={{ fontSize: "clamp(0.9rem, min(1.7vw, 2.9vh), 2.5rem)" }}
                      >
                        {o.text}
                      </span>
                      {isCorrect && (
                        <span
                          className="ml-auto shrink-0"
                          style={{ fontSize: "clamp(1.5rem, 3vw, 3.75rem)" }}
                        >
                          ✓
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {phase === "QUESTION_ONLY" && (
              <p className="mt-14 text-center text-4xl text-slate-500">
                Read the question…
              </p>
            )}

            {phase === "LOCKED" && (
              <p className="mt-10 text-center text-5xl font-bold text-warn">
                🔒 Answers locked
              </p>
            )}

            {phase === "SOLUTION" && question.solution_text && (
              <div className="mt-8 shrink-0 overflow-auto rounded-2xl border-2 border-edge bg-panel p-8">
                <p className="text-3xl leading-relaxed text-slate-200">
                  {question.solution_text}
                </p>
              </div>
            )}
          </>
        )}

        {phase === "PODIUM" && (
          <Podium
            key={state.session.phase_started_at}
            entries={board.slice(0, 3)}
            startedAt={state.session.phase_started_at}
            serverNow={serverNow}
            eyebrow={state.session.title}
          />
        )}

        {phase === "LEADERBOARD" && (
          <div className="mx-auto flex h-full w-full max-w-[92vw] flex-col">
            <h1
              className="mb-[2vh] shrink-0 text-center font-bold"
              style={{ fontSize: "clamp(1.5rem, min(3.4vw, 5.4vh), 4rem)" }}
            >
              {state.session.status === "ended" ? "Final Scores" : "Leaderboard"}
              <span
                className="ml-4 font-normal text-slate-500"
                style={{ fontSize: "0.45em" }}
              >
                top {state.session.leaderboard_top} qualify
              </span>
            </h1>

            {/*
              24 names will not fit in one column on a projector. Split
              into two balanced columns so the type stays large enough to
              read from the back row — the whole point of this screen.
            */}
            <div
              className={`grid min-h-0 flex-1 content-start gap-x-[3vw] gap-y-[0.8vh] ${
                board.length > 12 ? "grid-cols-2" : "grid-cols-1"
              }`}
            >
              {board.map((e, i) => {
                const mine = false;
                return (
                  <div
                    key={e.roll_number}
                    className="lb-row-in flex min-w-0 items-center gap-[1.2vw] rounded-lg border border-edge bg-panel px-[1.2vw] py-[0.7vh]"
                    style={{ "--odl": `${i * 45}ms` } as CSSProperties}
                  >
                    <span
                      className="w-[2.6em] shrink-0 text-center font-mono font-bold tabular-nums text-slate-400"
                      style={{ fontSize: "clamp(0.9rem, min(1.4vw, 2.4vh), 2rem)" }}
                    >
                      {e.rank}
                    </span>
                    <span
                      className="min-w-0 flex-1 truncate font-semibold"
                      style={{ fontSize: "clamp(0.95rem, min(1.5vw, 2.6vh), 2.1rem)" }}
                    >
                      {e.name}
                    </span>
                    <span
                      className="shrink-0 truncate font-mono text-slate-500"
                      style={{ fontSize: "clamp(0.75rem, min(1.1vw, 1.9vh), 1.4rem)" }}
                    >
                      {e.roll_number}
                    </span>
                    <span
                      className="shrink-0 text-right font-mono font-bold tabular-nums text-accent"
                      style={{ fontSize: "clamp(0.95rem, min(1.5vw, 2.6vh), 2.1rem)" }}
                    >
                      {e.total_score}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
