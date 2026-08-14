import { NextResponse } from "next/server";
import { buildStatePayload, NotFoundError } from "@/lib/session";
import { getParticipantId } from "@/lib/participantAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The polling fallback. Every client hits this every 5 seconds and snaps
 * to whatever it returns, which silently rescues anyone whose realtime
 * socket died without them noticing.
 *
 * The answer key is stripped here according to the current phase, so a
 * student reading this response in devtools during ACCEPTING_ANSWERS
 * sees no `correct_option` at all.
 */
export async function GET() {
  try {
    const participantId = await getParticipantId();
    const payload = await buildStatePayload({ participantId });

    return NextResponse.json(payload, {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate",
      },
    });
  } catch (err) {
    if (err instanceof NotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    console.error("[/api/state]", err);
    return NextResponse.json(
      { error: "Could not load the quiz state." },
      { status: 500 }
    );
  }
}
