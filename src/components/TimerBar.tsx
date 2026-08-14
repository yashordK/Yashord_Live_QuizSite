"use client";

/**
 * Countdown bar. `remaining` is always computed from the server's phase
 * origin (see useCountdown), never from a local start time, so every
 * phone in the room drains in step regardless of its own clock.
 */
export function TimerBar({
  remaining,
  duration,
  large = false,
}: {
  remaining: number | null;
  duration: number | null | undefined;
  large?: boolean;
}) {
  if (remaining === null || !duration) return null;

  const pct = Math.max(0, Math.min(100, (remaining / duration) * 100));
  const urgent = remaining <= 5;

  return (
    <div className="w-full">
      <div
        className={`flex items-baseline justify-between ${large ? "mb-3" : "mb-1.5"}`}
      >
        <span
          className={`font-mono font-bold tabular-nums ${
            large ? "text-5xl" : "text-2xl"
          } ${urgent ? "text-warn" : "text-slate-300"}`}
        >
          {Math.ceil(remaining)}s
        </span>
      </div>
      <div
        className={`w-full overflow-hidden rounded-full bg-edge ${
          large ? "h-4" : "h-2.5"
        }`}
        role="progressbar"
        aria-valuenow={Math.ceil(remaining)}
        aria-valuemin={0}
        aria-valuemax={duration}
        aria-label="Time remaining"
      >
        <div
          className={`h-full rounded-full transition-[width] duration-200 ease-linear ${
            urgent ? "bg-warn" : "bg-accent"
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
