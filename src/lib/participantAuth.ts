import "server-only";

import crypto from "node:crypto";
import { cookies } from "next/headers";
import { requireEnv } from "./config";

/**
 * Participant identity cookie.
 *
 * Signed server-side so a student can't edit it to become someone else
 * and answer on their behalf. It carries only the participant id — the
 * score is always derived from the database, never from the cookie.
 *
 * Deliberately long-lived: the whole point of the roll-number identity is
 * that a student can force-close the browser, come back, and land where
 * the class is. The cookie is a convenience so they usually don't even
 * retype their roll; re-entering the roll rebuilds it either way.
 */

const COOKIE_NAME = "lq_pid";
const TTL_SECONDS = 24 * 3600;

function sign(payload: string): string {
  return crypto
    .createHmac("sha256", requireEnv("HOST_SESSION_SECRET"))
    .update(`participant|${payload}`)
    .digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const ah = crypto.createHash("sha256").update(a).digest();
  const bh = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ah, bh);
}

export function createParticipantToken(participantId: string): string {
  const expiresAt = Date.now() + TTL_SECONDS * 1000;
  const payload = `${participantId}|${expiresAt}`;
  return `${payload}|${sign(payload)}`;
}

export function verifyParticipantToken(
  token: string | undefined
): string | null {
  if (!token) return null;

  const parts = token.split("|");
  if (parts.length !== 3) return null;

  const [participantId, expiresAtRaw, sig] = parts;

  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return null;

  if (!safeEqual(sig, sign(`${participantId}|${expiresAtRaw}`))) return null;

  // Shape check so a malformed id can never reach a SQL query.
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      participantId
    )
  ) {
    return null;
  }

  return participantId;
}

const isProd = process.env.NODE_ENV === "production";

export function participantCookieOptions() {
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax" as const,
    path: "/",
    maxAge: TTL_SECONDS,
  };
}

export async function setParticipantCookie(participantId: string) {
  const jar = await cookies();
  jar.set(
    COOKIE_NAME,
    createParticipantToken(participantId),
    participantCookieOptions()
  );
}

export async function clearParticipantCookie() {
  const jar = await cookies();
  jar.set(COOKIE_NAME, "", { ...participantCookieOptions(), maxAge: 0 });
}

/** Current participant id from the cookie, or null. */
export async function getParticipantId(): Promise<string | null> {
  try {
    const jar = await cookies();
    return verifyParticipantToken(jar.get(COOKIE_NAME)?.value);
  } catch {
    return null;
  }
}

export const PARTICIPANT_COOKIE_NAME = COOKIE_NAME;
