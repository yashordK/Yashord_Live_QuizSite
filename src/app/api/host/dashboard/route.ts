import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { requireHost } from "@/lib/hostAuth";
import {
  buildStatePayload,
  getSession,
  getQuestions,
  getAnswerDistribution,
  NotFoundError,
} from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The light, frequently-polled host payload: current state (WITH the
 * answer key, so the host can verify it before revealing), live counters,
 * and the answer distribution for the current question.
 *
 * The heavy participants table lives at /api/host/participants and is
 * fetched on demand, so polling this every couple of seconds stays cheap.
 */
export async function GET() {
  const denied = await requireHost();
  if (denied) return denied;

  try {
    const session = await getSession();

    const [state, questions] = await Promise.all([
      buildStatePayload({ includeAnswerKey: true }),
      getQuestions(session.id),
    ]);

    let answeredCount = 0;
    let distribution: Record<string, number> = {};

    if (session.current_question_id) {
      const [{ count }, dist] = await Promise.all([
        db()
          .from("answers")
          .select("id", { count: "exact", head: true })
          .eq("question_id", session.current_question_id),
        getAnswerDistribution(session.current_question_id),
      ]);

      answeredCount = count ?? 0;
      distribution = dist;
    }

    // Online = heartbeat within the last 60s. Computed here rather than
    // trusting the is_online flag, which goes stale when a phone simply
    // goes to sleep without telling us.
    const cutoff = new Date(Date.now() - 60_000).toISOString();
    const { count: onlineCount } = await db()
      .from("participants")
      .select("id", { count: "exact", head: true })
      .eq("session_id", session.id)
      .gte("last_seen_at", cutoff);

    const { count: flaggedCount } = await db()
      .from("participants")
      .select("id", { count: "exact", head: true })
      .eq("session_id", session.id)
      .eq("flagged_duplicate", true);

    return NextResponse.json(
      {
        state,
        settings: {
          joining_locked: session.joining_locked,
          auto_advance: session.auto_advance,
          leaderboard_interval: session.leaderboard_interval,
          join_cap: session.join_cap,
          status: session.status,
          roll_prefixes: Array.isArray(session.roll_prefixes)
            ? session.roll_prefixes
            : [],
        },
        counters: {
          joined: state.session.joined_count,
          online: onlineCount ?? 0,
          answered: answeredCount,
          flagged: flaggedCount ?? 0,
        },
        distribution,
        questions: questions.map((q) => ({
          id: q.id,
          order_index: q.order_index,
          question_text: q.question_text,
          correct_option: q.correct_option,
          reading_time_sec: q.reading_time_sec,
          answer_time_sec: q.answer_time_sec,
          voided: q.voided,
          skipped: q.skipped,
        })),
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    if (err instanceof NotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    console.error("[/api/host/dashboard]", err);
    return NextResponse.json(
      { error: "Could not load the dashboard." },
      { status: 500 }
    );
  }
}
