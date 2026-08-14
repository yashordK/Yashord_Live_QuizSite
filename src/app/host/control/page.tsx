"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { StatePayload, Phase } from "@/lib/types";
import { ParticipantsTable } from "@/components/ParticipantsTable";
import { QuestionBody } from "@/components/QuestionBody";

const POLL_MS = 2500;

interface DashboardQuestion {
  id: string;
  order_index: number;
  question_text: string;
  correct_option: string;
  reading_time_sec: number;
  answer_time_sec: number;
  voided: boolean;
  skipped: boolean;
}

interface Dashboard {
  state: StatePayload;
  settings: {
    joining_locked: boolean;
    auto_advance: boolean;
    leaderboard_interval: number;
    join_cap: number;
    status: string;
    roll_prefixes: string[];
    leaderboard_top: number;
  };
  counters: { joined: number; online: number; answered: number; flagged: number };
  distribution: Record<string, number>;
  questions: DashboardQuestion[];
}

type Tab = "control" | "participants" | "questions";

export default function HostControlPage() {
  const router = useRouter();
  const [dash, setDash] = useState<Dashboard | null>(null);
  const [tab, setTab] = useState<Tab>("control");
  const [banner, setBanner] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const clockOffset = useRef(0);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/host/dashboard", {
        cache: "no-store",
        credentials: "same-origin",
      });

      if (res.status === 401) {
        router.replace("/host/login");
        return;
      }
      if (!res.ok) return;

      const d = (await res.json()) as Dashboard;
      clockOffset.current = Date.parse(d.state.server_now) - Date.now();
      setDash(d);
    } catch {
      /* transient; the next poll will pick it up */
    }
  }, [router]);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const post = useCallback(
    async (url: string, body: unknown, okMsg?: string) => {
      setBusy(true);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(body),
        });

        const data = await res.json().catch(() => ({}));

        if (res.status === 401) {
          router.replace("/host/login");
          return false;
        }
        if (!res.ok) {
          setBanner({ kind: "err", text: data.error ?? "That didn't work." });
          return false;
        }

        if (okMsg) setBanner({ kind: "ok", text: okMsg });
        await load();
        return true;
      } catch {
        setBanner({ kind: "err", text: "No connection to the server." });
        return false;
      } finally {
        setBusy(false);
      }
    },
    [load, router]
  );

  const act = useCallback(
    (action: string) => post("/api/host/action", { action }),
    [post]
  );

  useEffect(() => {
    if (!banner) return;
    const id = setTimeout(() => setBanner(null), 4000);
    return () => clearTimeout(id);
  }, [banner]);

  // ---- live countdown ------------------------------------------------
  // `tickN` is the VALUE, not the setter — the setter is referentially
  // stable, so depending on it would freeze this memo and the host's
  // clock would sit still while the students' counted down.
  const [tickN, setTickN] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTickN((n) => n + 1), 250);
    return () => clearInterval(id);
  }, []);

  const remaining = useMemo(() => {
    if (!dash?.state.session.phase_duration_sec) return null;
    const started = Date.parse(dash.state.session.phase_started_at);
    const now = Date.now() + clockOffset.current;
    return Math.max(0, dash.state.session.phase_duration_sec - (now - started) / 1000);
  }, [dash, tickN]);

  // ---- auto-advance ---------------------------------------------------
  // Driven from this page rather than the server: Vercel's free tier has
  // no second-granularity scheduler, and the host page is guaranteed to
  // be open during the session. Defaults to OFF so you control pacing
  // while you're presenting.
  const autoFiredFor = useRef<string>("");
  useEffect(() => {
    if (!dash?.settings.auto_advance || remaining === null || remaining > 0) return;

    const phase = dash.state.session.phase;
    if (phase !== "QUESTION_ONLY" && phase !== "ACCEPTING_ANSWERS") return;

    const key = `${dash.state.state_version}:${phase}`;
    if (autoFiredFor.current === key) return;
    autoFiredFor.current = key;

    void act(phase === "QUESTION_ONLY" ? "SHOW_OPTIONS" : "LOCK");
  }, [dash, remaining, act]);

  if (!dash) {
    return (
      <main className="flex min-h-dvh items-center justify-center">
        <p className="text-slate-400">Loading control panel…</p>
      </main>
    );
  }

  const s = dash.state.session;
  const q = dash.state.question;
  const currentMeta = dash.questions.find((x) => x.id === q?.id);
  const totalAnswered = Object.values(dash.distribution).reduce((a, b) => a + b, 0);

  return (
    <div className="min-h-dvh">
      <TopBar
        phase={s.phase}
        title={s.title}
        code={s.code}
        counters={dash.counters}
        cap={s.join_cap}
        remaining={remaining}
        status={dash.settings.status}
      />

      {banner && (
        <div
          role="status"
          className={`px-6 py-2.5 text-sm font-medium ${
            banner.kind === "ok"
              ? "bg-good/20 text-green-200"
              : "bg-bad/20 text-red-200"
          }`}
        >
          {banner.text}
        </div>
      )}

      <nav className="flex gap-1 border-b border-edge px-3 pt-3 sm:px-6">
        {(["control", "participants", "questions"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-t-lg px-4 py-2 text-sm font-semibold capitalize ${
              tab === t
                ? "border-x border-t border-edge bg-panel text-white"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            {t}
            {t === "participants" && dash.counters.flagged > 0 && (
              <span className="ml-2 rounded-full bg-warn/25 px-2 py-0.5 text-xs text-warn">
                {dash.counters.flagged}
              </span>
            )}
          </button>
        ))}
      </nav>

      <main className="px-3 py-4 sm:px-6 sm:py-5">
        {tab === "control" && (
          <div className="grid gap-5 xl:grid-cols-[1.2fr_1fr]">
            {/* ---------------- question preview ---------------- */}
            <section className="space-y-5">
              <div className="card">
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="text-sm font-bold uppercase tracking-wide text-slate-400">
                    Current question
                    {dash.state.question_number && (
                      <span className="ml-2 text-slate-500">
                        {dash.state.question_number} / {dash.state.question_total}
                      </span>
                    )}
                  </h2>
                  {currentMeta?.voided && (
                    <span className="rounded bg-warn/20 px-2 py-1 text-xs font-bold text-warn">
                      VOIDED
                    </span>
                  )}
                </div>

                {q ? (
                  <>
                    <QuestionBody
                      text={q.question_text}
                      className="mb-4 text-lg leading-snug [&_.code-block]:text-sm"
                    />
                    <div className="space-y-2">
                      {(q.options ?? []).map((o) => {
                        const correct = o.key === q.correct_option;
                        return (
                          <div
                            key={o.key}
                            className={`flex items-center gap-3 rounded-lg border px-3 py-2 text-sm ${
                              correct
                                ? "border-good bg-good/15 font-semibold"
                                : "border-edge"
                            }`}
                          >
                            <span className="w-6 font-bold">{o.key}</span>
                            <span className="flex-1">{o.text}</span>
                            {correct && (
                              <span className="text-xs font-bold text-good">
                                ← ANSWER KEY
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>

                    {q.solution_text && (
                      <details className="mt-3">
                        <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-slate-400">
                          Solution text
                        </summary>
                        <p className="mt-2 whitespace-pre-wrap text-sm text-slate-300">
                          {q.solution_text}
                        </p>
                      </details>
                    )}
                  </>
                ) : (
                  <p className="text-slate-400">
                    No question selected. Press <b>Start / Next</b>.
                  </p>
                )}
              </div>

              {/* ---------------- timers ---------------- */}
              {currentMeta && (
                <div className="card">
                  <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-slate-400">
                    Timers — editable live
                  </h2>
                  <div className="flex flex-wrap gap-4">
                    <TimerInput
                      label="Reading (s)"
                      value={currentMeta.reading_time_sec}
                      onCommit={(v) =>
                        post(
                          "/api/host/question",
                          { question_id: currentMeta.id, reading_time_sec: v },
                          "Reading time updated."
                        )
                      }
                    />
                    <TimerInput
                      label="Answer (s)"
                      value={currentMeta.answer_time_sec}
                      onCommit={(v) =>
                        post(
                          "/api/host/question",
                          { question_id: currentMeta.id, answer_time_sec: v },
                          "Answer time updated."
                        )
                      }
                    />
                  </div>
                  <p className="mt-3 text-xs text-slate-500">
                    Changing the answer time while the window is open extends the
                    running countdown — it does not restart it, so nobody gets a
                    fresh full speed bonus.
                  </p>
                </div>
              )}
            </section>

            {/* ---------------- controls + distribution ---------------- */}
            <section className="space-y-5">
              <div className="card">
                <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-slate-400">
                  Phase
                </h2>
                <div className="grid grid-cols-2 gap-2">
                  <PhaseButton label="Start / Next Question" action={s.phase === "IDLE" ? "START" : "NEXT"} onAct={act} busy={busy} primary />
                  <PhaseButton label="Show Options" action="SHOW_OPTIONS" onAct={act} busy={busy} />
                  <PhaseButton label="Lock Answers" action="LOCK" onAct={act} busy={busy} />
                  <PhaseButton label="Reveal Answer" action="REVEAL" onAct={act} busy={busy} />
                  <PhaseButton label="Show Solution" action="SOLUTION" onAct={act} busy={busy} />
                  <PhaseButton label="Show Leaderboard" action="LEADERBOARD" onAct={act} busy={busy} />
                  <PhaseButton label="← Previous" action="PREV" onAct={act} busy={busy} />
                  <PhaseButton label="Skip Question" action="SKIP" onAct={act} busy={busy} />
                </div>
              </div>

              {/* ---------------- live distribution ---------------- */}
              <div className="card">
                <div className="mb-3 flex items-baseline justify-between">
                  <h2 className="text-sm font-bold uppercase tracking-wide text-slate-400">
                    Answer distribution
                  </h2>
                  <span className="text-sm text-slate-400">
                    <b className="text-slate-200">{dash.counters.answered}</b> of{" "}
                    {dash.counters.joined} answered
                  </span>
                </div>

                {q?.options?.length ? (
                  <div className="space-y-2">
                    {q.options.map((o) => {
                      const n = dash.distribution[o.key] ?? 0;
                      const pct = totalAnswered ? (n / totalAnswered) * 100 : 0;
                      const correct = o.key === q.correct_option;
                      return (
                        <div key={o.key} className="flex items-center gap-3">
                          <span className="w-6 shrink-0 font-bold">{o.key}</span>
                          <div className="h-7 flex-1 overflow-hidden rounded-md bg-edge">
                            <div
                              className={`h-full transition-[width] duration-300 ${
                                correct ? "bg-good" : "bg-accent"
                              }`}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <span className="w-20 shrink-0 text-right text-sm tabular-nums text-slate-300">
                            {n} ({Math.round(pct)}%)
                          </span>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-sm text-slate-500">
                    Available once options are shown.
                  </p>
                )}
                <p className="mt-3 text-xs text-slate-500">
                  Visible to you at every phase — discuss the split before you
                  reveal. Students never see this.
                </p>
              </div>

              {/* ---------------- session controls ---------------- */}
              <div className="card space-y-3">
                <h2 className="text-sm font-bold uppercase tracking-wide text-slate-400">
                  Session
                </h2>

                <Toggle
                  label="Lock joining"
                  hint="Stops new students joining. Anyone already in can still rejoin."
                  checked={dash.settings.joining_locked}
                  onChange={(v) =>
                    post("/api/host/settings", { joining_locked: v },
                      v ? "Joining locked." : "Joining reopened.")
                  }
                />

                <NumberSetting
                  label="Leaderboard places (qualifying cut)"
                  hint="How many places show on the projector and on students' phones. Top N proceed to the next game."
                  value={dash.settings.leaderboard_top ?? 10}
                  min={1}
                  max={200}
                  onSave={(n) =>
                    post(
                      "/api/host/settings",
                      { leaderboard_top: n },
                      `Leaderboard now shows the top ${n}.`
                    )
                  }
                  busy={busy}
                />

                <PrefixEditor
                  value={dash.settings.roll_prefixes ?? []}
                  onSave={(list) =>
                    post(
                      "/api/host/settings",
                      { roll_prefixes: list },
                      list.length
                        ? `Join screen now offers ${list.join(", ")}.`
                        : "Prefix picker turned off — students type the full roll."
                    )
                  }
                  busy={busy}
                />

                <Toggle
                  label="Auto-advance timers"
                  hint="Advances automatically when a countdown hits zero. Needs this page open."
                  checked={dash.settings.auto_advance}
                  onChange={(v) => post("/api/host/settings", { auto_advance: v })}
                />

                <div className="flex flex-wrap gap-2 pt-1">
                  <button
                    className="btn"
                    disabled={busy}
                    onClick={() =>
                      post("/api/host/rebroadcast", {}, "State re-broadcast to all clients.")
                    }
                  >
                    📡 Re-broadcast state
                  </button>

                  {currentMeta && (
                    <button
                      className="btn"
                      disabled={busy}
                      onClick={() =>
                        post(
                          "/api/host/question",
                          { question_id: currentMeta.id, voided: !currentMeta.voided },
                          currentMeta.voided
                            ? "Question restored — its points count again."
                            : "Question voided — nobody scores on it."
                        )
                      }
                    >
                      {currentMeta.voided ? "↩ Un-void question" : "⚠ Void this question"}
                    </button>
                  )}

                  <a className="btn" href="/api/host/export">
                    ⬇ Export CSV
                  </a>

                  <a className="btn" href="/present" target="_blank" rel="noreferrer">
                    🖥 Open /present
                  </a>

                  <button
                    className="btn"
                    disabled={busy}
                    onClick={() => {
                      if (confirm("End the session? Students will see final scores.")) {
                        void act("END");
                      }
                    }}
                  >
                    ⏹ End session
                  </button>
                </div>
              </div>
            </section>
          </div>
        )}

        {tab === "participants" && <ParticipantsTable />}

        {tab === "questions" && (
          <QuestionList questions={dash.questions} currentId={q?.id} post={post} busy={busy} />
        )}
      </main>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function TopBar({
  phase,
  title,
  code,
  counters,
  cap,
  remaining,
  status,
}: {
  phase: Phase;
  title: string;
  code: string;
  counters: { joined: number; online: number; answered: number; flagged: number };
  cap: number;
  remaining: number | null;
  status: string;
}) {
  const phaseColor: Record<Phase, string> = {
    IDLE: "bg-slate-600",
    QUESTION_ONLY: "bg-accent",
    ACCEPTING_ANSWERS: "bg-good",
    LOCKED: "bg-warn",
    REVEALED: "bg-purple-600",
    SOLUTION: "bg-purple-800",
    LEADERBOARD: "bg-pink-600",
  };

  return (
    <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-edge px-3 py-3 sm:gap-x-6 sm:px-6">
      <span className="brand font-extrabold">{title}</span>
      <span className={`rounded-md px-2.5 py-1 text-xs font-bold ${phaseColor[phase]}`}>
        {phase}
      </span>
      {status === "ended" && (
        <span className="rounded-md bg-bad/30 px-2.5 py-1 text-xs font-bold text-red-200">
          ENDED
        </span>
      )}
      {remaining !== null && (
        <span className="font-mono text-2xl font-bold tabular-nums text-accent">
          {Math.ceil(remaining)}s
        </span>
      )}

      <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1 text-sm sm:gap-5">
        <Stat label="joined" value={`${counters.joined} / ${cap}`} />
        <Stat label="online" value={counters.online} />
        <Stat label="answered" value={counters.answered} />
        {counters.flagged > 0 && (
          <Stat label="flagged" value={counters.flagged} warn />
        )}
        <span className="font-mono text-slate-400">code {code}</span>
        <form action="/api/host/logout" method="post">
          <button
            className="btn py-1.5 text-xs"
            onClick={async (e) => {
              e.preventDefault();
              await fetch("/api/host/logout", { method: "POST", credentials: "same-origin" });
              window.location.href = "/host/login";
            }}
          >
            Log out
          </button>
        </form>
      </div>
    </header>
  );
}

function Stat({
  label,
  value,
  warn = false,
}: {
  label: string;
  value: React.ReactNode;
  warn?: boolean;
}) {
  return (
    <span className="flex items-baseline gap-1.5">
      <b className={`font-mono text-lg tabular-nums ${warn ? "text-warn" : ""}`}>
        {value}
      </b>
      <span className="text-xs uppercase tracking-wide text-slate-500">{label}</span>
    </span>
  );
}

function PhaseButton({
  label,
  action,
  onAct,
  busy,
  primary = false,
}: {
  label: string;
  action: string;
  onAct: (a: string) => void;
  busy: boolean;
  primary?: boolean;
}) {
  return (
    <button
      className={`btn py-3 ${primary ? "btn-primary col-span-2" : ""}`}
      disabled={busy}
      onClick={() => onAct(action)}
    >
      {label}
    </button>
  );
}

function TimerInput({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: number;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);

  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-slate-400">{label}</span>
      <input
        type="number"
        min={0}
        max={600}
        className="w-20 rounded-lg border border-edge bg-ink px-2 py-1.5 text-center font-mono"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const n = Number(draft);
          if (Number.isFinite(n) && n !== value) onCommit(Math.max(0, Math.round(n)));
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
    </label>
  );
}

/**
 * Roll prefix picker config.
 *
 * Set this BEFORE students join. It changes the join screen from a
 * free-text roll field to "tap your prefix, type the digits", which
 * removes prefix typos at the source. Leave it empty for free text.
 *
 * It is never a gate — the join screen always keeps a fallback link for
 * anyone whose prefix isn't listed.
 */
/** A single integer session setting with an explicit Save. */
function NumberSetting({
  label,
  hint,
  value,
  min,
  max,
  onSave,
  busy,
}: {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  onSave: (n: number) => void;
  busy: boolean;
}) {
  const [draft, setDraft] = useState(String(value));
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!dirty) setDraft(String(value));
  }, [value, dirty]);

  const parsed = Math.max(min, Math.min(max, Math.round(Number(draft) || 0)));

  return (
    <div className="border-t border-edge pt-3">
      <label className="block text-sm font-semibold">{label}</label>
      <p className="mb-2 text-xs text-slate-500">{hint}</p>
      <div className="flex gap-2">
        <input
          type="number"
          min={min}
          max={max}
          className="w-24 rounded-lg border border-edge bg-ink px-3 py-2 text-center font-mono text-sm"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setDirty(true);
          }}
        />
        <button
          className="btn"
          disabled={busy || !dirty}
          onClick={() => {
            onSave(parsed);
            setDirty(false);
          }}
        >
          Save
        </button>
      </div>
    </div>
  );
}

function PrefixEditor({
  value,
  onSave,
  busy,
}: {
  value: string[];
  onSave: (list: string[]) => void;
  busy: boolean;
}) {
  const [draft, setDraft] = useState(value.join(", "));
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!dirty) setDraft(value.join(", "));
  }, [value, dirty]);

  const parsed = draft
    .split(",")
    .map((p) => p.trim().toUpperCase().replace(/[^A-Z0-9]/g, ""))
    .filter(Boolean);

  return (
    <div className="border-t border-edge pt-3">
      <label className="block text-sm font-semibold">Roll prefixes</label>
      <p className="mb-2 text-xs text-slate-500">
        Comma-separated, e.g. <code>22CS, 22IT</code>. Students tap one and type
        only the digits. Leave empty for free-text entry. Set this before anyone
        joins.
      </p>
      <div className="flex flex-wrap gap-2">
        <input
          className="min-w-0 flex-1 rounded-lg border border-edge bg-ink px-3 py-2 font-mono text-sm uppercase"
          value={draft}
          placeholder="22CS, 22IT"
          onChange={(e) => {
            setDraft(e.target.value);
            setDirty(true);
          }}
        />
        <button
          className="btn"
          disabled={busy || !dirty}
          onClick={() => {
            onSave(parsed);
            setDirty(false);
          }}
        >
          Save
        </button>
      </div>
      {parsed.length > 0 && (
        <p className="mt-2 text-xs text-slate-400">
          Join screen shows:{" "}
          {parsed.map((p) => (
            <span
              key={p}
              className="mr-1 rounded bg-accent/20 px-1.5 py-0.5 font-mono text-accent"
            >
              {p}
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <input
        type="checkbox"
        className="mt-1 h-5 w-5 accent-blue-500"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        <span className="block text-sm font-semibold">{label}</span>
        <span className="block text-xs text-slate-500">{hint}</span>
      </span>
    </label>
  );
}

function QuestionList({
  questions,
  currentId,
  post,
  busy,
}: {
  questions: DashboardQuestion[];
  currentId: string | undefined;
  post: (url: string, body: unknown, msg?: string) => Promise<boolean>;
  busy: boolean;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
          <tr className="border-b border-edge">
            <th className="py-2 pr-3">#</th>
            <th className="py-2 pr-3">Question</th>
            <th className="py-2 pr-3">Key</th>
            <th className="py-2 pr-3">Read</th>
            <th className="py-2 pr-3">Answer</th>
            <th className="py-2 pr-3">State</th>
            <th className="py-2">Actions</th>
          </tr>
        </thead>
        <tbody>
          {questions.map((q) => (
            <tr
              key={q.id}
              className={`border-b border-edge/50 ${
                q.id === currentId ? "bg-accent/10" : ""
              } ${q.skipped ? "opacity-40" : ""}`}
            >
              <td className="py-2 pr-3 font-mono">{q.order_index}</td>
              <td className="max-w-md truncate py-2 pr-3">{q.question_text}</td>
              <td className="py-2 pr-3 font-bold text-good">{q.correct_option}</td>
              <td className="py-2 pr-3 font-mono">{q.reading_time_sec}s</td>
              <td className="py-2 pr-3 font-mono">{q.answer_time_sec}s</td>
              <td className="py-2 pr-3">
                {q.voided && <span className="text-warn">voided</span>}
                {q.skipped && <span className="text-slate-500">skipped</span>}
              </td>
              <td className="py-2">
                <div className="flex gap-2">
                  <button
                    className="btn px-2 py-1 text-xs"
                    disabled={busy}
                    onClick={() =>
                      post("/api/host/question", { question_id: q.id, voided: !q.voided })
                    }
                  >
                    {q.voided ? "un-void" : "void"}
                  </button>
                  <button
                    className="btn px-2 py-1 text-xs"
                    disabled={busy}
                    onClick={() =>
                      post("/api/host/question", { question_id: q.id, skipped: !q.skipped })
                    }
                  >
                    {q.skipped ? "restore" : "skip"}
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
