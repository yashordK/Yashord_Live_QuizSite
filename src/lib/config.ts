/**
 * Central env access. Everything here is read server-side only, except
 * the two NEXT_PUBLIC_ values which are inlined into the client bundle.
 */

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === "" ? fallback : raw.trim();
}

/** Throws at call time (not import time) so `next build` never fails on a missing secret. */
export function requireEnv(name: string): string {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") {
    throw new Error(
      `Missing required environment variable ${name}. See .env.example.`
    );
  }
  return raw.trim();
}

export const rollConfig = {
  /** Zero-pad the trailing digit run to this width. 0 disables padding. */
  padLength: num("ROLL_PAD_LENGTH", 3),
  minLength: num("ROLL_MIN_LENGTH", 3),
  maxLength: num("ROLL_MAX_LENGTH", 20),
};

export const sessionConfig = {
  code: str("SESSION_CODE", "QUIZ01").toUpperCase(),
  title: str("SESSION_TITLE", "Live Quiz"),
  joinCap: num("JOIN_CAP", 185),
  leaderboardInterval: num("LEADERBOARD_INTERVAL", 5),
};

export const hostConfig = {
  ttlHours: num("HOST_SESSION_TTL_HOURS", 12),
  cookieName: "lq_host",
};

export const abuseConfig = {
  /**
   * Per-IP join attempts per minute.
   *
   * Sized for a LECTURE HALL, not a single user. Every student on campus
   * wifi shares one NAT'd public IP, so a "sensible" limit like 8/min
   * would admit eight students and hand everyone else "too many
   * attempts". This is a flood guard against scripted joins, and the
   * real protection against nonsense joins is the participant cap plus
   * the joining_locked toggle.
   */
  joinRateLimitPerMin: num("JOIN_RATE_LIMIT_PER_MIN", 240),

  /**
   * Per-ROLL attempts per minute. This is the tight one, and it's the
   * right axis: one student retrying is bounded, while 200 different
   * students behind the same IP are not affected at all.
   */
  joinRateLimitPerRollPerMin: num("JOIN_RATE_LIMIT_PER_ROLL_PER_MIN", 6),
};

/** Name shown to students; also the realtime channel suffix. */
export const NAME_MIN_LENGTH = 2;
export const NAME_MAX_LENGTH = 40;
