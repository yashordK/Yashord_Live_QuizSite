import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { getSession, NotFoundError } from "@/lib/session";
import { normalizeAndValidateName, normalizeAndValidateRoll } from "@/lib/roll";
import { setParticipantCookie } from "@/lib/participantAuth";
import { rateLimit, clientIp } from "@/lib/rateLimit";
import { abuseConfig, sessionConfig } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Join or rejoin.
 *
 * The whole rejoin guarantee rests on two things happening in this
 * order, server-side, every single time:
 *
 *   1. NORMALIZE the roll  (roll.ts)
 *   2. look up / insert by the CANONICAL value  (join_participant)
 *
 * Skip step 1 and a student who typed "22CS-101" on join and "22cs101"
 * on rejoin gets a second participant row and loses their score. The
 * client is never trusted to normalize; whatever it sends is raw input.
 *
 * The lookup and the cap check are done inside a database function under
 * an advisory lock, so 200 simultaneous joins can't race past the cap or
 * turn a legitimate double-tap into a unique-constraint error.
 */
export async function POST(req: Request) {
  try {
    // Per-IP flood guard, sized for a whole lecture hall behind one NAT.
    // See the note in config.ts — an 8/min limit here would let eight
    // students in and lock out the other 192.
    const ip = clientIp(req);
    const limited = rateLimit(`join:ip:${ip}`, abuseConfig.joinRateLimitPerMin);
    if (!limited.allowed) {
      return NextResponse.json(
        {
          error:
            "The server is handling a lot of joins right now. Wait a few seconds and try again.",
        },
        {
          status: 429,
          headers: { "Retry-After": String(limited.retryAfterSec) },
        }
      );
    }

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json(
        { error: "Please fill in the form and try again." },
        { status: 400 }
      );
    }

    const {
      name: rawName,
      roll: rawRoll,
      roll_prefix: rawPrefix,
      code: rawCode,
      device_token,
    } = body as {
      name?: unknown;
      roll?: unknown;
      roll_prefix?: unknown;
      code?: unknown;
      device_token?: unknown;
    };

    // ---- join code ----------------------------------------------------
    const code =
      typeof rawCode === "string" ? rawCode.trim().toUpperCase().replace(/\s|-/g, "") : "";
    if (code !== sessionConfig.code) {
      return NextResponse.json(
        {
          error: "That join code doesn't match this quiz. Check the code on screen.",
          field: "code",
        },
        { status: 400 }
      );
    }

    // ---- name and roll ------------------------------------------------
    const nameResult = normalizeAndValidateName(rawName);
    if (!nameResult.ok) {
      return NextResponse.json(
        { error: nameResult.message, field: "name" },
        { status: 400 }
      );
    }

    // When the join screen offered a prefix picker, the client sends the
    // chosen prefix and the digits separately. We simply concatenate and
    // then run the SAME normalization as free text — the composed value
    // is treated as raw input, never as a pre-canonicalised roll. That's
    // what keeps both entry paths resolving to one participant row.
    const composedRoll =
      typeof rawPrefix === "string" && rawPrefix.trim() !== ""
        ? `${rawPrefix}${typeof rawRoll === "string" ? rawRoll : ""}`
        : rawRoll;

    const rollResult = normalizeAndValidateRoll(composedRoll);
    if (!rollResult.ok) {
      return NextResponse.json(
        { error: rollResult.message, field: "roll" },
        { status: 400 }
      );
    }

    // Per-roll limit: the tight one. Bounds a single student hammering
    // retry without touching the 199 other students on the same IP.
    // Applied after normalization so "22cs101" and "22CS-101" count
    // against the same bucket.
    const perRoll = rateLimit(
      `join:roll:${rollResult.canonical}`,
      abuseConfig.joinRateLimitPerRollPerMin
    );
    if (!perRoll.allowed) {
      return NextResponse.json(
        {
          error: "Too many attempts for that roll number. Wait a moment and try again.",
        },
        { status: 429, headers: { "Retry-After": String(perRoll.retryAfterSec) } }
      );
    }

    const session = await getSession();

    if (session.status === "ended") {
      return NextResponse.json(
        { error: "This quiz has finished.", reason: "ended" },
        { status: 409 }
      );
    }

    const deviceToken =
      typeof device_token === "string" && device_token.length > 0
        ? device_token.slice(0, 100)
        : null;

    // ---- atomic join / rejoin -----------------------------------------
    const { data, error } = await db().rpc("join_participant", {
      p_session_id: session.id,
      p_roll: rollResult.canonical,
      p_raw_roll:
        typeof composedRoll === "string" ? composedRoll.slice(0, 100) : null,
      p_name: nameResult.name,
      p_device_token: deviceToken,
    });

    if (error) throw error;

    const row = (Array.isArray(data) ? data[0] : data) as {
      participant_id: string | null;
      outcome: "created" | "rejoined" | "full" | "locked";
      device_mismatch: boolean;
    };

    if (row.outcome === "full") {
      return NextResponse.json(
        {
          error: "Quiz is full",
          detail:
            "This session has reached its participant limit. If you joined earlier, enter the same roll number to get back in.",
          reason: "full",
        },
        { status: 409 }
      );
    }

    if (row.outcome === "locked") {
      return NextResponse.json(
        {
          error: "Joining is closed",
          detail:
            "The host has closed new joins for this quiz. If you joined earlier, enter the same roll number to get back in.",
          reason: "locked",
        },
        { status: 409 }
      );
    }

    if (!row.participant_id) {
      throw new Error("join_participant returned no participant id");
    }

    await setParticipantCookie(row.participant_id);

    return NextResponse.json({
      ok: true,
      participant_id: row.participant_id,
      name: nameResult.name,
      // Echoed back so the student sees the canonical form we stored and
      // learns what to type next time.
      roll_number: rollResult.canonical,
      rejoined: row.outcome === "rejoined",
      // Surfaced to the student only as a gentle notice; the host sees
      // the flag on the dashboard. We never block on it — real rejoins
      // from a second device are common and blocking creates a support
      // queue mid-presentation.
      device_mismatch: row.device_mismatch,
    });
  } catch (err) {
    if (err instanceof NotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    console.error("[/api/join]", err);
    return NextResponse.json(
      { error: "Something went wrong joining. Please try again." },
      { status: 500 }
    );
  }
}
