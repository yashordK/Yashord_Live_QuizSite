"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createClient, type RealtimeChannel } from "@supabase/supabase-js";
import type { StatePayload } from "./types";

const POLL_MS = 5_000;
const HEARTBEAT_MS = 25_000;

export type ConnectionStatus = "connecting" | "live" | "polling" | "offline";

interface UseQuizStateOptions {
  /** Send heartbeats. Only the student play screen should. */
  heartbeat?: boolean;
  /** Fetch from the host dashboard endpoint instead of /api/state. */
  endpoint?: string;
}

/**
 * The single sync primitive every surface uses.
 *
 * Three mechanisms, deliberately overlapping:
 *
 *  1. REALTIME BROADCAST on the one shared channel `session:{code}` —
 *     gives an instant reaction to a phase change. The payload is NOT
 *     trusted: anyone holding the public anon key can send on that
 *     channel, so a nudge only ever triggers a refetch. The server's
 *     response carries the authority.
 *
 *  2. POLLING every 5s — the safety net. This is what silently rescues a
 *     student whose socket died twenty minutes ago without them noticing.
 *     It is non-negotiable; realtime is the accelerator, not the
 *     mechanism.
 *
 *  3. HEARTBEAT every 25s — drives the online/offline dot on the host
 *     dashboard. Students only.
 *
 * Clock skew: remaining time is never computed from the phone's clock
 * alone. Each response carries `server_now`, from which we derive an
 * offset and apply it to every countdown. A student with a badly wrong
 * clock sees the same timer as everyone else.
 */
export function useQuizState(opts: UseQuizStateOptions = {}) {
  const { heartbeat = false, endpoint = "/api/state" } = opts;

  const [state, setState] = useState<StatePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");

  // ms to add to Date.now() to get server time.
  const clockOffset = useRef(0);
  const versionRef = useRef(-1);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    // Coalesce: a broadcast landing during a poll shouldn't double-fetch.
    if (inFlight.current) return;
    inFlight.current = true;

    try {
      const res = await fetch(endpoint, {
        cache: "no-store",
        credentials: "same-origin",
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? `Server returned ${res.status}`);
        setStatus("offline");
        return;
      }

      const payload = (await res.json()) as StatePayload;

      clockOffset.current = Date.parse(payload.server_now) - Date.now();

      // Discard a response that lost a race with a newer one. Without
      // this, a slow poll landing after a fast broadcast-triggered fetch
      // would drag the screen back into the previous phase.
      if (payload.state_version >= versionRef.current) {
        versionRef.current = payload.state_version;
        setState(payload);
      }

      setError(null);
      setStatus((s) => (s === "live" ? "live" : "polling"));
    } catch {
      setStatus("offline");
    } finally {
      inFlight.current = false;
    }
  }, [endpoint]);

  // ---- initial load + polling fallback ------------------------------
  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  // ---- refetch the moment the tab comes back ------------------------
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
    };
  }, [refresh]);

  // ---- realtime nudge ------------------------------------------------
  const code = state?.session.code;
  useEffect(() => {
    if (!code) return;

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    // No realtime configured? Polling alone still runs the whole quiz,
    // just with up to 5s of lag on phase changes.
    if (!url || !key) return;

    let channel: RealtimeChannel | null = null;
    const client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
      realtime: { params: { eventsPerSecond: 5 } },
    });

    channel = client
      .channel(`session:${code}`)
      .on("broadcast", { event: "state_changed" }, () => {
        // Nudge only — refetch rather than rendering the payload.
        void refresh();
      })
      .subscribe((s) => {
        if (s === "SUBSCRIBED") setStatus("live");
        else if (s === "CHANNEL_ERROR" || s === "TIMED_OUT") setStatus("polling");
      });

    return () => {
      if (channel) void client.removeChannel(channel);
    };
  }, [code, refresh]);

  // ---- heartbeat -----------------------------------------------------
  useEffect(() => {
    if (!heartbeat) return;

    const ping = () => {
      void fetch("/api/heartbeat", {
        method: "POST",
        credentials: "same-origin",
        keepalive: true,
      }).catch(() => {});
    };

    ping();
    const id = setInterval(ping, HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [heartbeat]);

  /** Server-corrected "now" in ms. */
  const serverNow = useCallback(
    () => Date.now() + clockOffset.current,
    []
  );

  return { state, error, status, refresh, serverNow, setState };
}

/**
 * Countdown driven by the server-authoritative phase origin. Re-renders
 * ~4x/second, which is smooth enough for a timer bar without being a
 * battery drain on 200 phones.
 */
export function useCountdown(
  phaseStartedAt: string | undefined,
  durationSec: number | null | undefined,
  serverNow: () => number
): number | null {
  const [, force] = useState(0);

  useEffect(() => {
    if (durationSec === null || durationSec === undefined) return;
    const id = setInterval(() => force((n) => n + 1), 250);
    return () => clearInterval(id);
  }, [durationSec, phaseStartedAt]);

  if (!phaseStartedAt || durationSec === null || durationSec === undefined) {
    return null;
  }

  const started = Date.parse(phaseStartedAt);
  if (!Number.isFinite(started)) return null;

  return Math.max(0, durationSec - (serverNow() - started) / 1000);
}
