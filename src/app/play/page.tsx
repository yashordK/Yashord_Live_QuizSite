"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuizState, useCountdown } from "@/lib/useQuizState";
import { TimerBar } from "@/components/TimerBar";
import { Leaderboard } from "@/components/Leaderboard";
import { QuestionBody } from "@/components/QuestionBody";
import type { LeaderboardEntry } from "@/lib/types";

export default function PlayPage() {
  const router = useRouter();
  const { state, status, refresh, serverNow } = useQuizState({ heartbeat: true });

  const phase = state?.session.phase;
  const question = state?.question ?? null;
  const me = state?.me;

  const remaining = useCountdown(
    state?.session.phase_started_at,
    state?.session.phase_duration_sec,
    serverNow
  );

  // ---- answering ----------------------------------------------------
  const [pending, setPending] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const submittingRef = useRef(false);

  // The server's record of their choice wins over local optimistic state.
  // This is what makes a rejoining student see their locked-in answer.
  const lockedIn = me?.my_answer?.selected_option ?? null;
  const selected = lockedIn ?? pending;

  // Clear the optimistic pick when the question changes.
  const questionId = question?.id;
  useEffect(() => {
    setPending(null);
    setSubmitError(null);
  }, [questionId]);

  // No participant cookie — they were never joined, or it expired.
  useEffect(() => {
    if (state && !state.me) router.replace("/");
  }, [state, router]);

  const submit = useCallback(
    async (option: string) => {
      if (submittingRef.current || lockedIn || !questionId) return;
      submittingRef.current = true;

      // Optimistic: the tap feels instant even on slow mobile data.
      setPending(option);
      setSubmitError(null);

      try {
        const res = await fetch("/api/answer", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ question_id: questionId, option }),
        });

        const body = await res.json().catch(() => ({}));

        if (!res.ok) {
          // Roll the optimistic pick back so they aren't shown an answer
          // that was never recorded.
          setPending(null);
          setSubmitError(body.error ?? "Could not record your answer.");
          void refresh();
        }
      } catch {
        setPending(null);
        setSubmitError("No connection — your answer wasn't recorded.");
      } finally {
        submittingRef.current = false;
      }
    },
    [lockedIn, questionId, refresh]
  );

  // ---- leaderboard: PULL, only on the phases that show it -----------
  const [board, setBoard] = useState<{
    entries: LeaderboardEntry[];
    total: number;
    myRank: number | null;
  } | null>(null);

  const showsBoard = phase === "LEADERBOARD" || phase === "REVEALED";
  const stateVersion = state?.state_version;

  useEffect(() => {
    if (!showsBoard) return;
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch("/api/leaderboard?limit=10", {
          credentials: "same-origin",
          cache: "no-store",
        });
        if (!res.ok) return;
        const b = await res.json();
        if (!cancelled) {
          setBoard({
            entries: b.entries,
            total: b.total_participants,
            myRank: b.me?.rank ?? null,
          });
        }
      } catch {
        /* leaderboard is cosmetic; never block the quiz on it */
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [showsBoard, stateVersion]);

  if (!state) {
    return (
      <main className="flex min-h-dvh items-center justify-center px-6">
        <p className="text-slate-400">Loading…</p>
      </main>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <Header
        name={me?.name ?? ""}
        roll={me?.roll_number ?? ""}
        score={me?.total_score ?? 0}
        status={status}
      />

      <main className="mx-auto w-full max-w-lg flex-1 px-4 pb-8 pt-4">
        {question && phase !== "IDLE" && phase !== "LEADERBOARD" && (
          <p className="mb-3 text-sm font-medium text-slate-400">
            Question {state.question_number} of {state.question_total}
            {question.voided && (
              <span className="ml-2 rounded bg-warn/20 px-2 py-0.5 text-warn">
                voided — no points
              </span>
            )}
          </p>
        )}

        {/* ---------- IDLE ---------- */}
        {phase === "IDLE" && (
          <Centered
            emoji="⏳"
            title="You're in!"
            body="Waiting for the host to start the quiz. Keep this page open."
          />
        )}

        {/* ---------- QUESTION_ONLY ---------- */}
        {phase === "QUESTION_ONLY" && question && (
          <div>
            <TimerBar remaining={remaining} duration={state.session.phase_duration_sec} />
            <QuestionText text={question.question_text} image={question.image_url} />
            <p className="mt-6 text-center text-slate-400">
              Read the question — options are coming.
            </p>
          </div>
        )}

        {/* ---------- ACCEPTING_ANSWERS ---------- */}
        {phase === "ACCEPTING_ANSWERS" && question && (
          <div>
            <TimerBar remaining={remaining} duration={state.session.phase_duration_sec} />
            <QuestionText text={question.question_text} image={question.image_url} />

            <div className="mt-6 space-y-3">
              {(question.options ?? []).map((o) => {
                const isPicked = selected === o.key;
                return (
                  <button
                    key={o.key}
                    className={`option-btn ${
                      isPicked
                        ? "border-accent bg-accent/20"
                        : selected
                          ? "opacity-50"
                          : ""
                    }`}
                    onClick={() => submit(o.key)}
                    disabled={!!selected}
                    aria-pressed={isPicked}
                  >
                    <span className={`option-key ${isPicked ? "bg-accent" : ""}`}>
                      {o.key}
                    </span>
                    <span>{o.text}</span>
                  </button>
                );
              })}
            </div>

            {selected && !submitError && (
              <p className="mt-5 rounded-xl border border-good/40 bg-good/10 px-4 py-3 text-center font-medium text-green-200">
                Answer locked in: {selected}
              </p>
            )}

            {submitError && (
              <p
                role="alert"
                className="mt-5 rounded-xl border border-bad/50 bg-bad/10 px-4 py-3 text-center text-sm text-red-200"
              >
                {submitError}
              </p>
            )}
          </div>
        )}

        {/* ---------- LOCKED ---------- */}
        {phase === "LOCKED" && question && (
          <div>
            <QuestionText text={question.question_text} image={question.image_url} />
            <div className="mt-6 space-y-3">
              {(question.options ?? []).map((o) => (
                <div
                  key={o.key}
                  className={`option-btn ${
                    selected === o.key ? "border-accent bg-accent/20" : "opacity-60"
                  }`}
                >
                  <span className="option-key">{o.key}</span>
                  <span>{o.text}</span>
                </div>
              ))}
            </div>
            <p className="mt-6 text-center font-medium text-slate-300">
              🔒 Answers locked. Waiting for the host…
            </p>
          </div>
        )}

        {/* ---------- REVEALED / SOLUTION ---------- */}
        {(phase === "REVEALED" || phase === "SOLUTION") && question && (
          <div>
            <QuestionText text={question.question_text} image={question.image_url} />

            <div className="mt-6 space-y-3">
              {(question.options ?? []).map((o) => {
                const isCorrect = o.key === question.correct_option;
                const isMine = selected === o.key;
                return (
                  <div
                    key={o.key}
                    className={`option-btn ${
                      isCorrect
                        ? "border-good bg-good/20"
                        : isMine
                          ? "border-bad bg-bad/20"
                          : "opacity-50"
                    }`}
                  >
                    <span className="option-key">{o.key}</span>
                    <span className="flex-1">{o.text}</span>
                    {isCorrect && <span className="text-2xl">✓</span>}
                    {isMine && !isCorrect && <span className="text-2xl">✗</span>}
                  </div>
                );
              })}
            </div>

            <ResultBanner
              answered={!!selected}
              correct={me?.my_answer?.is_correct ?? null}
              points={me?.my_answer?.points_earned ?? null}
              voided={question.voided}
            />

            {phase === "SOLUTION" && question.solution_text && (
              <div className="mt-5 rounded-2xl border border-edge bg-panel p-5">
                <h3 className="mb-2 text-sm font-bold uppercase tracking-wide text-slate-400">
                  Explanation
                </h3>
                <p className="whitespace-pre-wrap leading-relaxed text-slate-200">
                  {question.solution_text}
                </p>
              </div>
            )}
          </div>
        )}

        {/* ---------- LEADERBOARD ---------- */}
        {phase === "LEADERBOARD" && (
          <div>
            <h2 className="mb-1 text-2xl font-bold">
              {state.session.status === "ended" ? "Final scores" : "Leaderboard"}
            </h2>

            {board?.myRank ? (
              <p className="mb-5 text-slate-300">
                Your rank:{" "}
                <span className="text-xl font-bold text-accent">#{board.myRank}</span>{" "}
                of {board.total}
              </p>
            ) : (
              <p className="mb-5 text-slate-400">You&apos;re not ranked yet.</p>
            )}

            <Leaderboard
              entries={board?.entries ?? []}
              highlightRoll={me?.roll_number}
            />

            {board && !board.entries.some((e) => e.roll_number === me?.roll_number) && me && (
              <div className="mt-4 rounded-xl border border-accent bg-accent/15 px-4 py-3">
                <div className="flex items-center gap-4">
                  <span className="w-14 text-center text-lg font-bold tabular-nums">
                    {board.myRank ?? "—"}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{me.name}</span>
                    <span className="block truncate text-xs text-slate-400">
                      {me.roll_number}
                    </span>
                  </span>
                  <span className="font-mono text-lg font-bold tabular-nums">
                    {me.total_score}
                  </span>
                </div>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

function QuestionText({ text, image }: { text: string; image: string | null }) {
  return (
    <div className="mt-4">
      <QuestionBody
        text={text}
        className="text-2xl font-semibold leading-snug [&_.code-block]:text-base [&_.code-block]:font-normal"
      />
      {image && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={image}
          alt=""
          className="mt-4 max-h-64 w-full rounded-xl object-contain"
        />
      )}
    </div>
  );
}

function ResultBanner({
  answered,
  correct,
  points,
  voided,
}: {
  answered: boolean;
  correct: boolean | null;
  points: number | null;
  voided: boolean;
}) {
  if (voided) {
    return (
      <p className="mt-5 rounded-xl border border-warn/40 bg-warn/10 px-4 py-4 text-center font-semibold text-warn">
        This question was voided — nobody scored on it.
      </p>
    );
  }

  if (!answered) {
    return (
      <p className="mt-5 rounded-xl border border-edge bg-panel px-4 py-4 text-center font-medium text-slate-400">
        You didn&apos;t answer this one. 0 points.
      </p>
    );
  }

  if (correct) {
    return (
      <p className="mt-5 rounded-xl border border-good/50 bg-good/15 px-4 py-4 text-center text-lg font-bold text-green-200">
        ✓ Correct — +{points ?? 0} points
      </p>
    );
  }

  return (
    <p className="mt-5 rounded-xl border border-bad/50 bg-bad/15 px-4 py-4 text-center text-lg font-bold text-red-200">
      ✗ Not this time — 0 points
    </p>
  );
}

function Centered({
  emoji,
  title,
  body,
}: {
  emoji: string;
  title: string;
  body: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-20 text-center">
      <div className="mb-4 text-6xl">{emoji}</div>
      <h1 className="mb-2 text-2xl font-bold">{title}</h1>
      <p className="text-slate-400">{body}</p>
    </div>
  );
}

function Header({
  name,
  roll,
  score,
  status,
}: {
  name: string;
  roll: string;
  score: number;
  status: string;
}) {
  const dot =
    status === "live"
      ? "bg-good"
      : status === "polling"
        ? "bg-warn"
        : "bg-bad animate-pulse";

  return (
    <header className="sticky top-0 z-10 border-b border-edge bg-ink/95 backdrop-blur">
      <div className="mx-auto flex max-w-lg items-center gap-3 px-4 py-3">
        <span
          className={`h-2.5 w-2.5 shrink-0 rounded-full ${dot}`}
          title={
            status === "live"
              ? "Live"
              : status === "polling"
                ? "Reconnecting — still updating every 5s"
                : "Offline"
          }
          aria-label={`Connection: ${status}`}
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold leading-tight">{name}</p>
          <p className="truncate text-xs text-slate-400">{roll}</p>
        </div>
        <div className="text-right">
          <p className="font-mono text-xl font-bold leading-tight tabular-nums">
            {score}
          </p>
          <p className="text-[10px] uppercase tracking-wide text-slate-500">points</p>
        </div>
      </div>
    </header>
  );
}
