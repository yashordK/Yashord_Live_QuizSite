"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Shared motion primitives.
 *
 * Two properties every animation in the app relies on:
 *
 *  - DETERMINISM. "Random" choreography is seeded from the question id, so
 *    the projector and every phone derive the same flight paths, the same
 *    crack and the same falling bricks, and a re-render recomputes
 *    identical values instead of jittering.
 *
 *  - ONCE. The 5-second poll re-renders constantly, and the play screen
 *    remounts blocks between phases. An animation keyed with useOnce plays
 *    on first sight and renders its end state thereafter — including after
 *    a refresh, via sessionStorage.
 */

/** FNV-1a string hash. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 PRNG seeded from a string. */
export function seeded(seed: string): () => number {
  let a = hashString(seed);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Haptics on Android; silently a no-op on iOS and desktop. */
export function vibrate(pattern: number | number[]) {
  try {
    if (prefersReducedMotion()) return;
    navigator.vibrate?.(pattern);
  } catch {
    /* unsupported */
  }
}

const memory = new Set<string>();

function hasPlayed(key: string): boolean {
  if (memory.has(key)) return true;
  try {
    return sessionStorage.getItem(`lq_fx:${key}`) === "1";
  } catch {
    return false;
  }
}

function markPlayed(key: string) {
  memory.add(key);
  try {
    sessionStorage.setItem(`lq_fx:${key}`, "1");
  } catch {
    /* private mode */
  }
}

/**
 * "pending"  first frame, before we know — render the pre-animation look
 * "animate"  first time this key is seen: play it
 * "static"   already played (or reduced motion): render the end state
 */
export type OnceMode = "pending" | "animate" | "static";

export function useOnce(key: string | null | undefined): OnceMode {
  // Keyed decision object: a fresh object always re-renders, even when the
  // new mode equals the previous key's mode.
  const [decision, setDecision] = useState<{ key: string; mode: OnceMode } | null>(null);
  const decided = useRef<string | null>(null);

  useEffect(() => {
    if (!key || decided.current === key) return;
    decided.current = key;

    if (prefersReducedMotion()) {
      markPlayed(key);
      setDecision({ key, mode: "static" });
      return;
    }

    const first = !hasPlayed(key);
    markPlayed(key);
    setDecision({ key, mode: first ? "animate" : "static" });
  }, [key]);

  if (!key) return "pending";
  return decision?.key === key ? decision.mode : "pending";
}

/**
 * Eased count-up. A negative delay means "this started in the past", so a
 * late mount lands mid-count or on the final value rather than restarting.
 */
export function useCountUp(
  target: number,
  {
    duration = 900,
    delay = 0,
    enabled = true,
  }: { duration?: number; delay?: number; enabled?: boolean } = {}
): number {
  const [value, setValue] = useState(enabled ? 0 : target);

  useEffect(() => {
    if (!enabled || delay + duration <= 0) {
      setValue(target);
      return;
    }

    let raf = 0;
    const start = performance.now() + delay;
    const tick = (now: number) => {
      const p = Math.min(1, Math.max(0, (now - start) / duration));
      const eased = 1 - Math.pow(1 - p, 3);
      setValue(Math.round(target * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration, delay, enabled]);

  return value;
}
