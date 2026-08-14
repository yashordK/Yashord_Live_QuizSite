import { NextResponse } from "next/server";
import { clearHostCookie } from "@/lib/hostAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  await clearHostCookie();
  return NextResponse.json({ ok: true });
}
