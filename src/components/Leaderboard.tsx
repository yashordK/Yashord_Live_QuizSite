"use client";

import type { LeaderboardEntry } from "@/lib/types";

const MEDALS = ["🥇", "🥈", "🥉"];

export function Leaderboard({
  entries,
  highlightRoll,
  large = false,
}: {
  entries: LeaderboardEntry[];
  /** Roll number to highlight — the viewing student's own row. */
  highlightRoll?: string;
  /** Projector sizing: readable from the back of a large room. */
  large?: boolean;
}) {
  if (entries.length === 0) {
    return (
      <p className={`text-slate-400 ${large ? "text-4xl" : ""}`}>
        No scores yet.
      </p>
    );
  }

  return (
    <ol className={large ? "space-y-3" : "space-y-2"}>
      {entries.map((e) => {
        const mine = highlightRoll && e.roll_number === highlightRoll;
        return (
          <li
            key={e.roll_number}
            className={`flex items-center gap-4 rounded-xl border px-4 ${
              large ? "py-4" : "py-3"
            } ${
              mine
                ? "border-accent bg-accent/15"
                : "border-edge bg-panel"
            }`}
          >
            <span
              className={`w-14 shrink-0 text-center font-bold tabular-nums ${
                large ? "text-4xl" : "text-lg"
              }`}
            >
              {e.rank <= 3 ? MEDALS[e.rank - 1] : e.rank}
            </span>

            <span className="min-w-0 flex-1">
              <span
                className={`block truncate font-semibold ${
                  large ? "text-4xl" : "text-base"
                }`}
              >
                {e.name}
              </span>
              <span
                className={`block truncate text-slate-400 ${
                  large ? "text-2xl" : "text-xs"
                }`}
              >
                {e.roll_number}
              </span>
            </span>

            <span
              className={`shrink-0 font-mono font-bold tabular-nums ${
                large ? "text-4xl" : "text-lg"
              }`}
            >
              {e.total_score}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
