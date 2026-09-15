"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { LeaderboardEntry } from "@/lib/types";
import { burst, cannons, rain, stopRain, GOLD } from "./confetti";
import { prefersReducedMotion, useCountUp } from "./core";
import { playSound } from "./sound";

/**
 * The projector's top-three reveal.
 *
 * Every beat is timed from the PODIUM phase's server-side start, not from
 * when this component mounted. Two consequences:
 *
 *  - a projector that refreshes mid-reveal lands at the right moment
 *    instead of starting the drumroll over;
 *  - the phones know exactly when the reveal is over (PODIUM_TIMELINE.done)
 *    and can stop hiding the names without spoiling the winner.
 *
 * Delays are frozen per element at mount (negative = already happened).
 * Recomputing them on every poll would shift animations that are already
 * running.
 */

export const PODIUM_TIMELINE = {
  title: 0.2,
  rise3: 1.0,
  name3: 1.8,
  rise2: 3.0,
  name2: 3.8,
  drum: 5.0,
  rise1: 6.3,
  name1: 7.1,
  /** Everything has landed. */
  done: 8.6,
} as const;

const T = PODIUM_TIMELINE;

type Place = 1 | 2 | 3;

const PLACE: Record<
  Place,
  { m1: string; m2: string; glow: string; label: string; rise: number; name: number; confetti: string[] }
> = {
  1: {
    m1: "#fde68a",
    m2: "#d97706",
    glow: "rgba(251,191,36,.75)",
    label: "CHAMPION",
    rise: T.rise1,
    name: T.name1,
    confetti: GOLD,
  },
  2: {
    m1: "#f1f5f9",
    m2: "#64748b",
    glow: "rgba(203,213,225,.6)",
    label: "SECOND",
    rise: T.rise2,
    name: T.name2,
    confetti: ["#f1f5f9", "#cbd5e1", "#94a3b8", "#c4b5fd"],
  },
  3: {
    m1: "#fed7aa",
    m2: "#9a3412",
    glow: "rgba(251,146,60,.6)",
    label: "THIRD",
    rise: T.rise3,
    name: T.name3,
    confetti: ["#fed7aa", "#fb923c", "#ea580c", "#f5f3ff"],
  },
};

/** Seconds since the phase began, by the server clock, frozen at mount. */
function useElapsedAtMount(startedAt: string, serverNow: () => number): number {
  const [t] = useState(() => {
    const start = Date.parse(startedAt);
    return Number.isFinite(start) ? (serverNow() - start) / 1000 : 999;
  });
  return t;
}

const delay = (at: number, t: number) => `${(at - t).toFixed(2)}s`;

export function Podium({
  entries,
  startedAt,
  serverNow,
  eyebrow,
}: {
  entries: LeaderboardEntry[];
  startedAt: string;
  serverNow: () => number;
  eyebrow?: string;
}) {
  const t = useElapsedAtMount(startedAt, serverNow);
  const cols = useRef<Record<Place, HTMLDivElement | null>>({ 1: null, 2: null, 3: null });

  useEffect(() => {
    if (prefersReducedMotion()) return;

    const timers: number[] = [];
    const at = (sec: number, fn: () => void, grace = 1.2) => {
      const ms = (sec - t) * 1000;
      if (ms < -grace * 1000) return; // long past — don't fire stale confetti
      timers.push(window.setTimeout(fn, Math.max(0, ms)));
    };

    const fromPlace = (p: Place, count: number, power = 13) => {
      const col = cols.current[p];
      const rect = (col?.querySelector(".plate") ?? col)?.getBoundingClientRect();
      if (!rect) return;
      burst({
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        count,
        spread: 120,
        power,
        colors: PLACE[p].confetti,
      });
    };

    at(T.name3 + 0.15, () => fromPlace(3, 70));
    at(T.name2 + 0.15, () => fromPlace(2, 85));
    at(
      T.name1 + 0.05,
      () => {
        cannons(1.4);
        fromPlace(1, 170, 17);
        rain(7500);
      },
      3
    );

    return () => {
      timers.forEach((id) => clearTimeout(id));
      stopRain();
    };
    // Timed once from the frozen phase clock.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Crowd cheer the moment the podium is shown; at ~20s it covers the whole
  // reveal. Deliberately separate from the confetti schedule above, and not
  // gated on reduced motion (that setting is about movement, not sound).
  // A projector that joins the reveal late — a refresh — stays quiet rather
  // than erupting mid-sequence, and moving on fades the cheer out.
  useEffect(() => {
    if (t > 3) return;
    let stop: (() => void) | null = null;
    let cancelled = false;
    const id = window.setTimeout(() => {
      void playSound("cheer").then((s) => {
        if (cancelled) s?.();
        else stop = s;
      });
    }, Math.max(0, -t * 1000));
    return () => {
      cancelled = true;
      clearTimeout(id);
      stop?.();
    };
    // Timed once from the frozen phase clock.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const order: Place[] = [2, 1, 3];

  return (
    <div className="stage" role="region" aria-label="Top three">
      <div className="stage-floor" />

      <div className="spot-wrap spot-wrap--sweep" style={{ animationDelay: delay(T.drum, t) }}>
        <div className="spot spot-a" />
        <div className="spot spot-b" />
      </div>
      <div className="spot-wrap spot-wrap--hero" style={{ animationDelay: delay(T.rise1, t) }}>
        <div className="spot spot-hero" />
      </div>

      <header className="stage-head" style={{ animationDelay: delay(T.title, t) }}>
        {eyebrow && <p className="stage-eyebrow">{eyebrow}</p>}
        <h1 className="stage-title">The Podium</h1>
      </header>

      <div className="podium">
        {order.map((p) => {
          const entry = entries[p - 1];
          return (
            <div
              key={p}
              ref={(el) => {
                cols.current[p] = el;
              }}
              className={`podium-col podium-col--${p}`}
              style={{ "--m1": PLACE[p].m1, "--m2": PLACE[p].m2, "--glow": PLACE[p].glow } as CSSProperties}
            >
              {entry ? (
                <NamePlate
                  key={entry.roll_number}
                  place={p}
                  entry={entry}
                  startedAt={startedAt}
                  serverNow={serverNow}
                />
              ) : (
                <div className="plate plate--empty" />
              )}
              <div className="podium-block" style={{ animationDelay: delay(PLACE[p].rise, t) }}>
                <span className="podium-numeral">{p}</span>
                <span className="podium-label">{PLACE[p].label}</span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Drumroll: everything dims, the centre charges, then the flash. */}
      <div className="stage-dim" style={{ animationDelay: delay(T.drum, t) }} />
      <div className="podium-charge" style={{ animationDelay: delay(T.drum, t) }} />
      <p className="drum-text" style={{ animationDelay: delay(T.drum, t) }}>
        And the champion is…
      </p>
      <div className="stage-flash" style={{ animationDelay: delay(T.name1, t) }} />

      {entries.length === 0 && <p className="stage-empty">Waiting for scores…</p>}
    </div>
  );
}

function NamePlate({
  place,
  entry,
  startedAt,
  serverNow,
}: {
  place: Place;
  entry: LeaderboardEntry;
  startedAt: string;
  serverNow: () => number;
}) {
  // Frozen at THIS element's mount: names can arrive after the stage did.
  const t = useElapsedAtMount(startedAt, serverNow);
  const P = PLACE[place];

  const score = useCountUp(entry.total_score, {
    duration: 1200,
    delay: (P.name + 0.3 - t) * 1000,
    enabled: !prefersReducedMotion(),
  });

  // Staggered float so the three names bob out of phase with each other.
  const floatOffset = `${(-place * 1.15).toFixed(2)}s`;

  return (
    <div className="plate" style={{ animationDelay: delay(P.name, t) }}>
      {place === 1 && (
        <div className="crown-wrap" style={{ animationDelay: delay(P.name + 0.35, t) }}>
          <Crown className="crown" />
        </div>
      )}

      <div className="plate-name">
        {place === 1 && (
          <span className="orbit-tilt" aria-hidden="true">
            <span className="orbit">
              {Array.from({ length: 8 }, (_, i) => (
                <i key={i} style={{ transform: `rotate(${i * 45}deg) translateX(var(--orbit-r))` }} />
              ))}
            </span>
          </span>
        )}
        <span
          className={`glow-name${place === 1 ? " glow-name--gold" : ""}`}
          style={{ animationDelay: place === 1 ? `0s, ${floatOffset}, 0s` : `0s, ${floatOffset}` }}
        >
          {entry.name}
        </span>
      </div>

      <div className="plate-meta">
        <span className="plate-roll">{entry.roll_number}</span>
        <span className="plate-score">{score}</span>
      </div>
    </div>
  );
}

function Crown({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 64 46" aria-hidden="true">
      <defs>
        <linearGradient id="podium-crown-gold" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fef3c7" />
          <stop offset="0.5" stopColor="#fbbf24" />
          <stop offset="1" stopColor="#b45309" />
        </linearGradient>
      </defs>
      <path
        d="M4 38 L8 12 L22 26 L32 5 L42 26 L56 12 L60 38 Z"
        fill="url(#podium-crown-gold)"
        stroke="#fde68a"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <rect x="4" y="36" width="56" height="8" rx="2" fill="#d97706" />
      <circle cx="32" cy="5" r="3.6" fill="#ec4899" />
      <circle cx="8" cy="12" r="3" fill="#a855f7" />
      <circle cx="56" cy="12" r="3" fill="#a855f7" />
      <circle cx="20" cy="40" r="2" fill="#fef3c7" />
      <circle cx="32" cy="40" r="2" fill="#fef3c7" />
      <circle cx="44" cy="40" r="2" fill="#fef3c7" />
    </svg>
  );
}
