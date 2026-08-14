import { NextResponse } from "next/server";
import { db, broadcastNudge } from "@/lib/supabase";
import { requireHost } from "@/lib/hostAuth";
import { getSession, NotFoundError } from "@/lib/session";
import { phaseAcceptsAnswers } from "@/lib/phases";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Per-question host controls: live timer edits, void, unvoid, skip.
 *
 * Editing the answer timer while a question is OPEN also updates the
 * session's live phase_duration_sec, without moving phase_started_at.
 * That is the difference between "give everyone 10 more seconds" and
 * "restart the clock and hand everyone a fresh full speed bonus".
 */
export async function POST(req: Request) {
  const denied = await requireHost();
  if (denied) return denied;

  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const questionId = body.question_id;

    if (typeof questionId !== "string") {
      return NextResponse.json({ error: "Missing question_id." }, { status: 400 });
    }

    const session = await getSession();

    const { data: question, error: qErr } = await db()
      .from("questions")
      .select("*")
      .eq("id", questionId)
      .eq("session_id", session.id)
      .maybeSingle();

    if (qErr) throw qErr;
    if (!question) {
      return NextResponse.json({ error: "Question not found." }, { status: 404 });
    }

    const patch: Record<string, unknown> = {};

    if (typeof body.reading_time_sec === "number") {
      patch.reading_time_sec = clampSec(body.reading_time_sec);
    }
    if (typeof body.answer_time_sec === "number") {
      patch.answer_time_sec = clampSec(body.answer_time_sec);
    }
    if (typeof body.voided === "boolean") {
      // Voiding nulls this question's points for EVERYONE. The answer
      // rows are left untouched and simply excluded from the score view,
      // so this is fully reversible if you void the wrong one.
      patch.voided = body.voided;
    }
    if (typeof body.skipped === "boolean") {
      patch.skipped = body.skipped;
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
    }

    const { data: updated, error } = await db()
      .from("questions")
      .update(patch)
      .eq("id", questionId)
      .select("*")
      .single();

    if (error) throw error;

    // If we just changed the timer on the question that is currently
    // open, push it to the live countdown too.
    let stateVersion = session.state_version;
    const isCurrent = session.current_question_id === questionId;

    if (isCurrent && typeof patch.answer_time_sec === "number" && phaseAcceptsAnswers(session.phase)) {
      const { data: v, error: dErr } = await db().rpc("set_phase_duration", {
        p_session_id: session.id,
        p_duration_sec: patch.answer_time_sec,
      });
      if (dErr) throw dErr;
      stateVersion = Number(v);
    } else if (isCurrent && typeof patch.reading_time_sec === "number" && session.phase === "QUESTION_ONLY") {
      const { data: v, error: dErr } = await db().rpc("set_phase_duration", {
        p_session_id: session.id,
        p_duration_sec: patch.reading_time_sec,
      });
      if (dErr) throw dErr;
      stateVersion = Number(v);
    } else if (typeof patch.voided === "boolean") {
      // Scores just changed for everyone; make clients refetch.
      const { data: s, error: sErr } = await db()
        .from("sessions")
        .update({ state_version: session.state_version + 1 })
        .eq("id", session.id)
        .select("state_version")
        .single();
      if (sErr) throw sErr;
      stateVersion = s.state_version;
    }

    await broadcastNudge(session.code, stateVersion);

    return NextResponse.json({ ok: true, question: updated });
  } catch (err) {
    if (err instanceof NotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    console.error("[/api/host/question]", err);
    return NextResponse.json(
      { error: "Could not update the question." },
      { status: 500 }
    );
  }
}

function clampSec(n: number): number {
  return Math.max(0, Math.min(600, Math.round(n)));
}
