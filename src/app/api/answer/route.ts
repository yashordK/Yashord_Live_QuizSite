import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { getRawState, NotFoundError } from "@/lib/session";
import { getParticipantId } from "@/lib/participantAuth";
import { phaseAcceptsAnswers } from "@/lib/phases";
import { computePoints, isWithinAnswerWindow } from "@/lib/scoring";
import type { Option } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Answer submission. Four independent layers stop a bad submission:
 *
 *  1. This route checks the phase is ACCEPTING_ANSWERS.
 *  2. This route checks the server-measured elapsed time is inside the
 *     window (plus a small grace for in-flight requests on slow mobile
 *     data), so a paused tab that fires late gets nothing.
 *  3. UNIQUE (question_id, participant_id) makes a double-tap physically
 *     unable to produce two rows.
 *  4. A BEFORE INSERT trigger re-checks the phase in the database, which
 *     also covers a bug in this route — the service role bypasses RLS,
 *     so the trigger, not a policy, is the real backstop.
 *
 * The response deliberately does NOT say whether the answer was right or
 * how many points it earned. Returning that here would let anyone read
 * the answer key straight out of the network tab the moment they answer.
 */
export async function POST(req: Request) {
  try {
    const participantId = await getParticipantId();
    if (!participantId) {
      return NextResponse.json(
        { error: "You're not joined. Enter your name and roll number again.", reason: "no_participant" },
        { status: 401 }
      );
    }

    const body = await req.json().catch(() => null);
    const questionId = (body as { question_id?: unknown } | null)?.question_id;
    const selected = (body as { option?: unknown } | null)?.option;

    if (typeof questionId !== "string" || typeof selected !== "string") {
      return NextResponse.json({ error: "Malformed answer." }, { status: 400 });
    }

    const raw = await getRawState(participantId);
    const session = raw.session;
    const question = raw.question;

    if (!raw.me) {
      return NextResponse.json(
        { error: "You're not joined. Enter your name and roll number again.", reason: "no_participant" },
        { status: 401 }
      );
    }

    // ---- Layer 1: phase --------------------------------------------
    if (!phaseAcceptsAnswers(session.phase)) {
      return NextResponse.json(
        {
          error:
            session.phase === "LOCKED" || session.phase === "REVEALED"
              ? "Answers are locked for this question."
              : "Answers aren't open right now.",
          reason: "phase",
          phase: session.phase,
        },
        { status: 409 }
      );
    }

    if (!question || question.id !== session.current_question_id) {
      return NextResponse.json(
        { error: "That question isn't the current one.", reason: "stale_question" },
        { status: 409 }
      );
    }

    if (questionId !== question.id) {
      // The client is a phase behind — it'll snap forward on its next poll.
      return NextResponse.json(
        { error: "The class has moved on to another question.", reason: "stale_question" },
        { status: 409 }
      );
    }

    // ---- Layer 2: server-side timing -------------------------------
    // Both timestamps come from the database clock, so neither the phone's
    // clock nor the serverless function's clock can influence the score.
    const elapsedMs =
      Date.parse(raw.server_now) - Date.parse(session.phase_started_at);

    if (!isWithinAnswerWindow(elapsedMs, session.phase_duration_sec)) {
      return NextResponse.json(
        { error: "Time's up for this question.", reason: "too_late" },
        { status: 409 }
      );
    }

    const options = (question.options ?? []) as Option[];
    if (!options.some((o) => o.key === selected)) {
      return NextResponse.json(
        { error: "That isn't one of the options." },
        { status: 400 }
      );
    }

    const isCorrect = selected === question.correct_option;
    const points = computePoints({
      isCorrect,
      elapsedMs,
      // The LIVE duration, not the question's stored default — the host
      // may have extended the timer mid-question, and the bonus must be
      // computed against the window students actually had.
      answerTimeSec: session.phase_duration_sec ?? question.answer_time_sec,
      basePoints: question.points,
    });

    // ---- Layers 3 & 4: the insert ----------------------------------
    const { error } = await db().from("answers").insert({
      question_id: question.id,
      participant_id: participantId,
      selected_option: selected,
      is_correct: isCorrect,
      points_earned: points,
      server_elapsed_ms: Math.max(0, Math.round(elapsedMs)),
    });

    if (error) {
      // Unique violation: they already answered. This is the expected
      // outcome of a double-tap, not an error worth showing.
      if (error.code === "23505") {
        return NextResponse.json({
          ok: true,
          selected_option: selected,
          already_answered: true,
        });
      }

      // The database trigger rejected it — the host locked or revealed
      // in the gap between our phase check and this insert. The student
      // genuinely missed the window.
      if (
        error.code === "23514" ||
        String(error.message).includes("ANSWER_REJECTED")
      ) {
        return NextResponse.json(
          { error: "Answers just closed for this question.", reason: "phase" },
          { status: 409 }
        );
      }

      throw error;
    }

    // Confirmation only. No correctness, no points — see the note above.
    return NextResponse.json({
      ok: true,
      selected_option: selected,
      already_answered: false,
    });
  } catch (err) {
    if (err instanceof NotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    console.error("[/api/answer]", err);
    return NextResponse.json(
      { error: "Could not record your answer. Try again." },
      { status: 500 }
    );
  }
}
