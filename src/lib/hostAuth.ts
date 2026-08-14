import "server-only";

import crypto from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { hostConfig, requireEnv } from "./config";

/**
 * Host authentication.
 *
 * The API layer is the security boundary — not the UI. Every /api/host/*
 * route calls requireHost() before doing anything, so hiding buttons in
 * the React tree is a convenience, never a control. The join URL will be
 * shared among 200 students within minutes of it appearing on a
 * projector; "the URL is secret" is not a security model.
 *
 * Token format: "<expiresAtMs>.<hmac>" where
 *   hmac = HMAC_SHA256(HOST_SESSION_SECRET, "host|<expiresAtMs>")
 * Rotating HOST_SESSION_SECRET invalidates every live host session.
 */

function sign(payload: string): string {
  return crypto
    .createHmac("sha256", requireEnv("HOST_SESSION_SECRET"))
    .update(payload)
    .digest("hex");
}

function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  // Compare a fixed-size digest of each side so differing lengths don't
  // throw and don't leak length via early return.
  const ah = crypto.createHash("sha256").update(ab).digest();
  const bh = crypto.createHash("sha256").update(bb).digest();
  return crypto.timingSafeEqual(ah, bh);
}

export function checkHostPassword(candidate: unknown): boolean {
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  return timingSafeEqual(candidate, requireEnv("HOST_PASSWORD"));
}

export function createHostToken(): string {
  const expiresAt = Date.now() + hostConfig.ttlHours * 3600 * 1000;
  return `${expiresAt}.${sign(`host|${expiresAt}`)}`;
}

export function verifyHostToken(token: string | undefined): boolean {
  if (!token) return false;

  const dot = token.lastIndexOf(".");
  if (dot <= 0) return false;

  const expiresAtRaw = token.slice(0, dot);
  const providedSig = token.slice(dot + 1);

  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt)) return false;
  if (Date.now() > expiresAt) return false;

  return timingSafeEqual(providedSig, sign(`host|${expiresAtRaw}`));
}

const isProd = process.env.NODE_ENV === "production";

export function hostCookieOptions() {
  return {
    httpOnly: true,
    // `secure` off in local dev only, so http://localhost still works.
    secure: isProd,
    sameSite: "lax" as const,
    path: "/",
    maxAge: hostConfig.ttlHours * 3600,
  };
}

export async function setHostCookie(): Promise<void> {
  const jar = await cookies();
  jar.set(hostConfig.cookieName, createHostToken(), hostCookieOptions());
}

export async function clearHostCookie(): Promise<void> {
  const jar = await cookies();
  jar.set(hostConfig.cookieName, "", { ...hostCookieOptions(), maxAge: 0 });
}

export async function isHost(): Promise<boolean> {
  try {
    const jar = await cookies();
    return verifyHostToken(jar.get(hostConfig.cookieName)?.value);
  } catch {
    return false;
  }
}

/**
 * Guard for route handlers. Returns a 401 response to return early, or
 * null when the caller is a verified host.
 *
 *   const denied = await requireHost();
 *   if (denied) return denied;
 */
export async function requireHost(): Promise<NextResponse | null> {
  if (await isHost()) return null;
  return NextResponse.json(
    { error: "Not authorised. Log in at /host/login." },
    { status: 401 }
  );
}
