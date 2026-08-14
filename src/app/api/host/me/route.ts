import { NextResponse } from "next/server";
import { isHost } from "@/lib/hostAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Lets the host page redirect to /host/login without rendering controls first. */
export async function GET() {
  return NextResponse.json({ host: await isHost() });
}
