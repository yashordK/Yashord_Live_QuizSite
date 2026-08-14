import { requireHost } from "@/lib/hostAuth";
import { NextResponse } from "next/server";
import {
  getSession,
  getQuestions,
  getScoreRows,
  getAllAnswers,
} from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * CSV export. Run this IMMEDIATELY after the event — a paused Supabase
 * project is a bad time to discover you never took the data out.
 *
 * One row per participant: identity, rank, total, then one column per
 * question showing the chosen option and whether it was right.
 */
function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  // Excel interprets a leading =, +, - or @ as a formula. Prefixing with
  // an apostrophe stops a roll number or a name turning into one.
  const guarded = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return `"${guarded.replace(/"/g, '""')}"`;
}

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

    const playable = questions
      .filter((q) => !q.skipped)
      .sort((a, b) => a.order_index - b.order_index);

    const answerMap = new Map<string, (typeof answers)[number]>();
    for (const a of answers) {
      answerMap.set(`${a.participant_id}:${a.question_id}`, a);
    }

    scores.sort(
      (a, b) => b.total_score - a.total_score || a.name.localeCompare(b.name)
    );

    const header = [
      "rank",
      "name",
      "roll_number",
      "total_score",
      "correct_count",
      "answered_count",
      "joined_at",
      "last_seen_at",
      "flagged_duplicate",
      "device_mismatches",
    ];
    for (const q of playable) {
      const suffix = q.voided ? " (VOIDED)" : "";
      header.push(`Q${q.order_index} choice${suffix}`, `Q${q.order_index} correct${suffix}`, `Q${q.order_index} points${suffix}`);
    }

    const lines: string[] = [header.map(csvCell).join(",")];

    let lastScore: number | null = null;
    let lastRank = 0;

    scores.forEach((s, i) => {
      const rank = s.total_score === lastScore ? lastRank : i + 1;
      lastScore = s.total_score;
      lastRank = rank;

      const row: unknown[] = [
        rank,
        s.name,
        s.roll_number,
        s.total_score,
        s.correct_count,
        s.answered_count,
        s.joined_at,
        s.last_seen_at,
        s.flagged_duplicate ? "YES" : "",
        s.device_mismatches,
      ];

      for (const q of playable) {
        const a = answerMap.get(`${s.participant_id}:${q.id}`);
        row.push(
          a?.selected_option ?? "",
          a ? (a.is_correct ? "1" : "0") : "",
          // A voided question contributes nothing, and the export says so
          // rather than showing points that were never counted.
          a ? (q.voided ? 0 : a.points_earned) : ""
        );
      }

      lines.push(row.map(csvCell).join(","));
    });

    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    // BOM so Excel opens UTF-8 names correctly.
    const body = "﻿" + lines.join("\r\n") + "\r\n";

    return new NextResponse(body, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="quiz-results-${session.code}-${stamp}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("[/api/host/export]", err);
    return NextResponse.json({ error: "Export failed." }, { status: 500 });
  }
}
