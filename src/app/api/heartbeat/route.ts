import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { getParticipantId } from "@/lib/participantAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Heartbeat, every ~25s from each client. Drives the online/offline dot
 * on the host dashboard. Deliberately trivial — one indexed UPDATE — so
 * 200 clients pinging it costs almost nothing.
 */
export async function POST() {
  const participantId = await getParticipantId();
  if (!participantId) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const { error } = await db()
    .from("participants")
    .update({ last_seen_at: new Date().toISOString(), is_online: true })
    .eq("id", participantId);

  if (error) {
    console.error("[/api/heartbeat]", error);
    return NextResponse.json({ ok: false }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
