import { NextResponse } from "next/server";
import { getSession, getLeaderboard, NotFoundError } from "@/lib/session";
import { getParticipantId } from "@/lib/participantAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Leaderboard is PULL, not push. Clients fetch it when the phase becomes
 * REVEALED or LEADERBOARD and not otherwise. Subscribing 200 clients to
 * live score updates would be a message-count explosion for no benefit —
 * nobody can read a leaderboard that reshuffles every second anyway.
 */
export async function GET(req: Request) {
  try {
    const session = await getSession();
    const participantId = await getParticipantId();

    // Default to the session's configured cut (24 for this event) so the
    // number of places shown is controlled in one place and can be
    // changed live, rather than being hard-coded into three callers.
    const url = new URL(req.url);
    const requested = url.searchParams.get("limit");
    const limit = Math.min(
      200,
      Math.max(1, Number(requested ?? session.leaderboard_top) || 10)
    );

    const result = await getLeaderboard(session.id, { limit, participantId });

    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    if (err instanceof NotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    console.error("[/api/leaderboard]", err);
    return NextResponse.json(
      { error: "Could not load the leaderboard." },
      { status: 500 }
    );
  }
}
