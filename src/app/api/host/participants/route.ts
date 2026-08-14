import { NextResponse } from "next/server";
import { requireHost } from "@/lib/hostAuth";
import {
  getSession,
  getQuestions,
  getScoreRows,
  getAllAnswers,
  NotFoundError,
} from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Full participants table: name, roll, online status, total score, and
 * per-question correctness. Heavier than /dashboard, so the host page
 * fetches it on demand and on a slower interval.
 */
export async function GET() {
  const denied = await requireHost();
  if (denied) return denied;

  try {
    const session = await getSession();

    const [questions, scores, answers] = await Promise.all([
      getQuestions(session.id),
      getScoreRows(session.id),
      getAllAnswers(session.id),
    ]);

    const byParticipant = new Map<
      string,
      Record<string, { selected: string; correct: boolean; points: number }>
    >();

    for (const a of answers) {
      let row = byParticipant.get(a.participant_id);
      if (!row) {
        row = {};
        byParticipant.set(a.participant_id, row);
      }
      row[a.question_id] = {
        selected: a.selected_option,
        correct: a.is_correct,
        points: a.points_earned,
      };
    }

    const onlineCutoff = Date.now() - 60_000;

    const participants = scores.map((s) => ({
      participant_id: s.participant_id,
      name: s.name,
      roll_number: s.roll_number,
      total_score: s.total_score,
      correct_count: Number(s.correct_count),
      answered_count: Number(s.answered_count),
      joined_at: s.joined_at,
      last_seen_at: s.last_seen_at,
      online: Date.parse(s.last_seen_at) >= onlineCutoff,
      flagged_duplicate: s.flagged_duplicate,
      device_mismatches: s.device_mismatches,
      answers: byParticipant.get(s.participant_id) ?? {},
    }));

    return NextResponse.json(
      {
        participants,
        questions: questions.map((q) => ({
          id: q.id,
          order_index: q.order_index,
          correct_option: q.correct_option,
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
    console.error("[/api/host/participants]", err);
    return NextResponse.json(
      { error: "Could not load participants." },
      { status: 500 }
    );
  }
}
