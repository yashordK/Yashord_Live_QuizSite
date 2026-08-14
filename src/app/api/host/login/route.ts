import { NextResponse } from "next/server";
import { checkHostPassword, setHostCookie } from "@/lib/hostAuth";
import { rateLimit, clientIp } from "@/lib/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    // Tight limit: this is the one endpoint worth brute-forcing.
    const limited = rateLimit(`hostlogin:${clientIp(req)}`, 10);
    if (!limited.allowed) {
      return NextResponse.json(
        { error: "Too many attempts. Wait a minute." },
        { status: 429, headers: { "Retry-After": String(limited.retryAfterSec) } }
      );
    }

    const body = await req.json().catch(() => null);
    const password = (body as { password?: unknown } | null)?.password;

    if (!checkHostPassword(password)) {
      // Deliberately vague and constant-time (see hostAuth.ts).
      return NextResponse.json({ error: "Incorrect password." }, { status: 401 });
    }

    await setHostCookie();
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[/api/host/login]", err);
    return NextResponse.json(
      { error: "Login failed. Check HOST_PASSWORD and HOST_SESSION_SECRET are set." },
      { status: 500 }
    );
  }
}
