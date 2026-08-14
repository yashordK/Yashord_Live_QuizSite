import "server-only";

/**
 * Best-effort in-memory rate limiter for the join endpoint.
 *
 * Honest about its limits: on Vercel this is per-instance, so with
 * several warm lambdas the effective limit is a multiple of the
 * configured one. That is fine for what it's for — stopping someone
 * scripting a few hundred fake joins to eat the 185-seat cap. It is not
 * a defence against a distributed attack, and nothing security-critical
 * depends on it.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();
const WINDOW_MS = 60_000;

function sweep(now: number) {
  if (buckets.size < 5_000) return;
  for (const [k, v] of buckets) {
    if (v.resetAt <= now) buckets.delete(k);
  }
}

export function rateLimit(
  key: string,
  limit: number
): { allowed: boolean; retryAfterSec: number } {
  const now = Date.now();
  sweep(now);

  const existing = buckets.get(key);

  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true, retryAfterSec: 0 };
  }

  existing.count += 1;

  if (existing.count > limit) {
    return {
      allowed: false,
      retryAfterSec: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }

  return { allowed: true, retryAfterSec: 0 };
}

/** Client IP, trusting Vercel's proxy headers. */
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}
