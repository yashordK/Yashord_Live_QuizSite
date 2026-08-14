import { NextResponse } from "next/server";
import { db, broadcastNudge } from "@/lib/supabase";
import { requireHost } from "@/lib/hostAuth";
import {
  getSession,
  getQuestions,
  writeSessionState,
  NotFoundError,
} from "@/lib/session";
import { applyAction, PhaseError, type HostAction } from "@/lib/phases";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACTIONS: HostAction[] = [
  "START",
  "SHOW_OPTIONS",
  "LOCK",
  "REVEAL",
  "SOLUTION",
  "LEADERBOARD",
  "NEXT",
  "PREV",
  "SKIP",
  "END",
  "RESET",
];

/**
 * The single entry point for every phase change.
 *
 * The host client sends an ACTION, never a target phase. The server
 * decides what that action means from the current state, so a stale or
 * replayed host request can't drop the room into an arbitrary phase.
 */
export async function POST(req: Request) {
  const denied = await requireHost();
  if (denied) return denied;

  try {
    const body = await req.json().catch(() => null);
    const action = (body as { action?: unknown } | null)?.action;

    if (typeof action !== "string" || !ACTIONS.includes(action as HostAction)) {
      return NextResponse.json({ error: "Unknown action." }, { status: 400 });
    }

    const session = await getSession();
    const questions = await getQuestions(session.id);

    const current =
      questions.find((q) => q.id === session.current_question_id) ?? null;

    const next = applyAction(
      {
        phase: session.phase,
        status: session.status,
        currentIndex: current?.order_index ?? null,
        leaderboardShownAfter: session.leaderboard_shown_after ?? 0,
      },
      action as HostAction,
      {
        questions: questions.map((q) => ({
          order_index: q.order_index,
          reading_time_sec: q.reading_time_sec,
          answer_time_sec: q.answer_time_sec,
          skipped: q.skipped,
        })),
        leaderboardInterval: session.leaderboard_interval,
      }
    );

    // SKIP marks the outgoing question before we move off it, so it is
    // excluded from numbering and from any later navigation.
    if (next.skipIndex !== undefined) {
      const { error } = await db()
        .from("questions")
        .update({ skipped: true })
        .eq("session_id", session.id)
        .eq("order_index", next.skipIndex);
      if (error) throw error;
    }

    const nextQuestionId =
      next.currentIndex === null
        ? null
        : questions.find((q) => q.order_index === next.currentIndex)?.id ?? null;

    const written = await writeSessionState(session.id, {
      phase: next.phase,
      status: next.status,
      currentQuestionId: nextQuestionId,
      durationSec: next.durationSec,
      leaderboardShownAfter: next.leaderboardShownAfter,
    });

    await broadcastNudge(session.code, written.state_version);

    return NextResponse.json({
      ok: true,
      phase: next.phase,
      state_version: written.state_version,
    });
  } catch (err) {
    if (err instanceof PhaseError) {
      // Legal-but-unavailable action. Show the host the reason rather
      // than a generic failure — they're driving this live.
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof NotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    console.error("[/api/host/action]", err);
    return NextResponse.json(
      { error: "Could not change the phase." },
      { status: 500 }
    );
  }
}
