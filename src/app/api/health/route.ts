import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { sessionConfig } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Setup and pre-flight check. Hit this first when something isn't
 * working, and again 30 minutes before the event — it also serves as the
 * daily "keep Supabase awake" ping in the run-up.
 *
 * Reports which env vars are missing WITHOUT ever echoing their values.
 */
/** Role claim from a Supabase JWT-style key, or null if it isn't one. */
function jwtRole(key: string): string | null {
  const parts = key.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8")
    );
    return typeof payload.role === "string" ? payload.role : null;
  } catch {
    return null;
  }
}

function checkServiceKey(
  serviceKey: string,
  anonKey: string
): { problem: string; hint: string } | null {
  if (serviceKey.trim() === anonKey.trim()) {
    return {
      problem: "SUPABASE_SERVICE_ROLE_KEY is the same value as the anon key",
      hint:
        "In Supabase → Settings → API, copy the 'service_role' key (the secret one, " +
        "hidden behind a Reveal button), not the 'anon'/'public' key. RLS is deny-all, " +
        "so the anon key cannot read or write anything.",
    };
  }

  const role = jwtRole(serviceKey);
  if (role !== null && role !== "service_role") {
    return {
      problem: `SUPABASE_SERVICE_ROLE_KEY carries role "${role}", expected "service_role"`,
      hint:
        "Copy the 'service_role' key from Supabase → Settings → API. Only that key " +
        "bypasses RLS, which is how every API route reads and writes.",
    };
  }

  const anonRole = jwtRole(anonKey);
  if (anonRole !== null && anonRole !== "anon") {
    return {
      problem: `NEXT_PUBLIC_SUPABASE_ANON_KEY carries role "${anonRole}", expected "anon"`,
      hint:
        "This key ships to every student's browser. If it is the service_role key, " +
        "rotate it in Supabase immediately — it bypasses RLS.",
    };
  }

  return null;
}

export async function GET() {
  const required = [
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "HOST_PASSWORD",
    "HOST_SESSION_SECRET",
  ];

  const missing = required.filter((k) => !process.env[k]?.trim());

  // A service key accidentally exposed to the browser is the one config
  // mistake worth shouting about.
  const leaked = Object.keys(process.env).filter(
    (k) => k.startsWith("NEXT_PUBLIC_") && /SERVICE_ROLE|HOST_PASSWORD|SESSION_SECRET/.test(k)
  );

  if (missing.length) {
    return NextResponse.json(
      {
        ok: false,
        problem: "Missing environment variables",
        missing,
        hint: "Copy .env.example to .env.local (or set them in Vercel) and restart.",
      },
      { status: 503 }
    );
  }

  // Pasting the anon key into BOTH slots is an easy slip: the two keys sit
  // next to each other in the dashboard and look nearly identical. With
  // RLS deny-all the symptom is every single request failing with an
  // opaque permission error, so it's worth naming precisely.
  const keyProblem = checkServiceKey(
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
  if (keyProblem) {
    return NextResponse.json({ ok: false, ...keyProblem }, { status: 503 });
  }

  try {
    const { data: session, error } = await db()
      .from("sessions")
      .select("id, code, title, phase, status, join_cap, joining_locked")
      .eq("code", sessionConfig.code)
      .maybeSingle();

    if (error) {
      return NextResponse.json(
        {
          ok: false,
          problem: "Database query failed",
          detail: error.message,
          hint: "Have all five migrations in supabase/migrations been applied?",
        },
        { status: 503 }
      );
    }

    if (!session) {
      return NextResponse.json(
        {
          ok: false,
          problem: `No session with code "${sessionConfig.code}"`,
          hint: "Run supabase/seed.sql, and make sure the code in it matches SESSION_CODE.",
        },
        { status: 503 }
      );
    }

    const [{ count: questionCount }, { count: participantCount }] = await Promise.all([
      db()
        .from("questions")
        .select("id", { count: "exact", head: true })
        .eq("session_id", session.id)
        .eq("skipped", false),
      db()
        .from("participants")
        .select("id", { count: "exact", head: true })
        .eq("session_id", session.id),
    ]);

    return NextResponse.json({
      ok: true,
      session: {
        code: session.code,
        title: session.title,
        phase: session.phase,
        status: session.status,
        join_cap: session.join_cap,
        joining_locked: session.joining_locked,
      },
      questions: questionCount ?? 0,
      participants: participantCount ?? 0,
      warnings: [
        ...(leaked.length
          ? [`SECRET EXPOSED TO BROWSER via ${leaked.join(", ")} — rename and rotate the key.`]
          : []),
        ...(questionCount === 0 ? ["No questions loaded. Run npm run questions:load."] : []),
        ...(session.phase !== "IDLE"
          ? [`Phase is ${session.phase}, not IDLE. Use RESET if you meant to start clean.`]
          : []),
      ],
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        problem: "Could not reach Supabase",
        detail: err instanceof Error ? err.message : String(err),
        hint: "Check the project isn't paused and that the URL and service key are right.",
      },
      { status: 503 }
    );
  }
}
