import { NextResponse } from "next/server";
import { broadcastNudge } from "@/lib/supabase";
import { requireHost } from "@/lib/hostAuth";
import { getSession, NotFoundError } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The emergency button. Re-sends the "state changed" nudge WITHOUT
 * touching the session row — so a stuck client refetches and snaps
 * forward, and every running countdown keeps its original origin.
 *
 * If this doesn't unstick someone, the 5-second poll will within five
 * seconds anyway. That's the point of having both.
 */
export async function POST() {
  const denied = await requireHost();
  if (denied) return denied;

  try {
    const session = await getSession();
    await broadcastNudge(session.code, session.state_version);
    return NextResponse.json({ ok: true, state_version: session.state_version });
  } catch (err) {
    if (err instanceof NotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    console.error("[/api/host/rebroadcast]", err);
    return NextResponse.json({ error: "Re-broadcast failed." }, { status: 500 });
  }
}
