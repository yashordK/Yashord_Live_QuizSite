import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { requireEnv } from "./config";

/**
 * Service-role Supabase client. SERVER ONLY.
 *
 * This key bypasses RLS, which is the whole point: RLS is deny-all for
 * anon, so the browser can't touch the database at all, and every read
 * and write flows through a route handler that we control. The
 * "server-only" import above makes a client-component import of this
 * module a build error rather than a leaked key.
 */
let cached: SupabaseClient | null = null;

export function db(): SupabaseClient {
  if (cached) return cached;

  cached = createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { "x-application-name": "live-quiz" } },
    }
  );

  return cached;
}

/**
 * Broadcast a "something changed" nudge on the session's shared channel.
 *
 * The payload is deliberately minimal and deliberately NOT trusted by
 * clients: anyone holding the public anon key can send on this channel,
 * so a client receiving a nudge refetches /api/state rather than
 * rendering whatever arrived. The nudge buys us instant reaction; the
 * server response is what carries authority.
 *
 * Failures here are swallowed. Realtime is an accelerator — the 5s
 * polling fallback is the thing that must never break.
 */
export async function broadcastNudge(
  code: string,
  stateVersion: number
): Promise<void> {
  try {
    const client = createClient(
      requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
      { auth: { persistSession: false, autoRefreshToken: false } }
    );

    const channel = client.channel(`session:${code}`, {
      config: { broadcast: { ack: false } },
    });

    await new Promise<void>((resolve) => {
      const done = setTimeout(resolve, 2000);
      channel.subscribe((status) => {
        if (status === "SUBSCRIBED") {
          channel
            .send({
              type: "broadcast",
              event: "state_changed",
              payload: { state_version: stateVersion },
            })
            .finally(() => {
              clearTimeout(done);
              resolve();
            });
        }
      });
    });

    await client.removeChannel(channel);
  } catch (err) {
    console.error("[broadcastNudge] failed (non-fatal):", err);
  }
}
