import { NextResponse } from "next/server";
import { db, broadcastNudge } from "@/lib/supabase";
import { requireHost } from "@/lib/hostAuth";
import { getSession, NotFoundError } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Session-level toggles: lock joining, auto-advance, leaderboard cadence,
 * join cap. These never touch phase_started_at — flipping a toggle must
 * not restart a running countdown.
 */
export async function POST(req: Request) {
  const denied = await requireHost();
  if (denied) return denied;

  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};

    if (typeof body.joining_locked === "boolean") {
      patch.joining_locked = body.joining_locked;
    }
    if (typeof body.auto_advance === "boolean") {
      patch.auto_advance = body.auto_advance;
    }
    if (typeof body.leaderboard_interval === "number") {
      patch.leaderboard_interval = Math.max(
        0,
        Math.min(100, Math.round(body.leaderboard_interval))
      );
    }
    if (typeof body.join_cap === "number") {
      patch.join_cap = Math.max(1, Math.min(1000, Math.round(body.join_cap)));
    }
    if (typeof body.leaderboard_top === "number") {
      patch.leaderboard_top = Math.max(
        1,
        Math.min(200, Math.round(body.leaderboard_top))
      );
    }
    if (Array.isArray(body.roll_prefixes)) {
      // Normalized the same way roll numbers are, so a prefix typed as
      // "22cs" or "22-CS" ends up matching what students' rolls
      // canonicalise to. Capped at 6 so the join screen stays tappable.
      patch.roll_prefixes = body.roll_prefixes
        .filter((p): p is string => typeof p === "string")
        .map((p) => p.trim().toUpperCase().replace(/[^A-Z0-9]/g, ""))
        .filter((p) => p.length > 0 && p.length <= 12)
        .slice(0, 6);
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
    }

    const session = await getSession();

    const { data, error } = await db()
      .from("sessions")
      .update({ ...patch, state_version: session.state_version + 1 })
      .eq("id", session.id)
      .select("*")
      .single();

    if (error) throw error;

    await broadcastNudge(session.code, data.state_version);

    return NextResponse.json({ ok: true, session: data });
  } catch (err) {
    if (err instanceof NotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    console.error("[/api/host/settings]", err);
    return NextResponse.json(
      { error: "Could not update settings." },
      { status: 500 }
    );
  }
}
