"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

interface Participant {
  participant_id: string;
  name: string;
  roll_number: string;
  total_score: number;
  correct_count: number;
  answered_count: number;
  joined_at: string;
  last_seen_at: string;
  online: boolean;
  flagged_duplicate: boolean;
  device_mismatches: number;
  answers: Record<string, { selected: string; correct: boolean; points: number }>;
}

interface QuestionMeta {
  id: string;
  order_index: number;
  correct_option: string;
  voided: boolean;
  skipped: boolean;
}

type SortKey =
  | "rank"
  | "name"
  | "roll_number"
  | "total_score"
  | "correct_count"
  | "online";

/**
 * Full participants table. Fetched on demand and refreshed on a slower
 * interval than the control panel — it carries every answer row, so it's
 * the heavy query.
 */
export function ParticipantsTable() {
  const [rows, setRows] = useState<Participant[]>([]);
  const [questions, setQuestions] = useState<QuestionMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({
    key: "total_score",
    dir: -1,
  });
  const [filter, setFilter] = useState("");
  const [onlyFlagged, setOnlyFlagged] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/host/participants", {
        cache: "no-store",
        credentials: "same-origin",
      });
      if (!res.ok) return;
      const d = await res.json();
      setRows(d.participants);
      setQuestions(d.questions.filter((q: QuestionMeta) => !q.skipped));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 10_000);
    return () => clearInterval(id);
  }, [load]);

  const sorted = useMemo(() => {
    const q = filter.trim().toLowerCase();

    const filtered = rows.filter((r) => {
      if (onlyFlagged && !r.flagged_duplicate) return false;
      if (!q) return true;
      return (
        r.name.toLowerCase().includes(q) || r.roll_number.toLowerCase().includes(q)
      );
    });

    // Rank always reflects score order, independent of the display sort,
    // so sorting by name doesn't renumber everybody.
    const byScore = [...rows].sort((a, b) => b.total_score - a.total_score);
    const rankOf = new Map<string, number>();
    let lastScore: number | null = null;
    let lastRank = 0;
    byScore.forEach((r, i) => {
      const rank = r.total_score === lastScore ? lastRank : i + 1;
      lastScore = r.total_score;
      lastRank = rank;
      rankOf.set(r.participant_id, rank);
    });

    const cmp = (a: Participant, b: Participant): number => {
      switch (sort.key) {
        case "rank":
          return (rankOf.get(a.participant_id)! - rankOf.get(b.participant_id)!);
        case "name":
          return a.name.localeCompare(b.name);
        case "roll_number":
          return a.roll_number.localeCompare(b.roll_number);
        case "total_score":
          return a.total_score - b.total_score;
        case "correct_count":
          return a.correct_count - b.correct_count;
        case "online":
          return Number(a.online) - Number(b.online);
      }
    };

    return filtered
      .sort((a, b) => cmp(a, b) * sort.dir)
      .map((r) => ({ ...r, rank: rankOf.get(r.participant_id)! }));
  }, [rows, sort, filter, onlyFlagged]);

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: key === "name" || key === "roll_number" ? 1 : -1 }));

  const Th = ({ label, sortKey }: { label: string; sortKey: SortKey }) => (
    <th
      className="cursor-pointer select-none whitespace-nowrap py-2 pr-3 hover:text-slate-200"
      onClick={() => toggleSort(sortKey)}
    >
      {label}
      {sort.key === sortKey && <span className="ml-1">{sort.dir === 1 ? "▲" : "▼"}</span>}
    </th>
  );

  if (loading) return <p className="text-slate-400">Loading participants…</p>;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <input
          className="w-64 rounded-lg border border-edge bg-ink px-3 py-2 text-sm"
          placeholder="Filter by name or roll…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="h-4 w-4 accent-blue-500"
            checked={onlyFlagged}
            onChange={(e) => setOnlyFlagged(e.target.checked)}
          />
          Only flagged duplicates
        </label>
        <span className="text-sm text-slate-400">
          {sorted.length} of {rows.length} shown
        </span>
        <a className="btn ml-auto py-1.5 text-xs" href="/api/host/export">
          ⬇ Export CSV
        </a>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
            <tr className="border-b border-edge">
              <Th label="#" sortKey="rank" />
              <Th label="Name" sortKey="name" />
              <Th label="Roll" sortKey="roll_number" />
              <Th label="Score" sortKey="total_score" />
              <Th label="Correct" sortKey="correct_count" />
              <Th label="On" sortKey="online" />
              <th className="py-2 pr-3">Flags</th>
              {questions.map((q) => (
                <th
                  key={q.id}
                  className={`py-2 pr-2 text-center font-mono ${
                    q.voided ? "text-warn line-through" : ""
                  }`}
                  title={q.voided ? "Voided — scores 0 for everyone" : undefined}
                >
                  {q.order_index}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.participant_id} className="border-b border-edge/40">
                <td className="py-1.5 pr-3 font-mono tabular-nums">{r.rank}</td>
                <td className="max-w-[14rem] truncate py-1.5 pr-3">{r.name}</td>
                <td className="py-1.5 pr-3 font-mono">{r.roll_number}</td>
                <td className="py-1.5 pr-3 font-mono font-bold tabular-nums">
                  {r.total_score}
                </td>
                <td className="py-1.5 pr-3 tabular-nums text-slate-400">
                  {r.correct_count}/{r.answered_count}
                </td>
                <td className="py-1.5 pr-3">
                  <span
                    className={`inline-block h-2.5 w-2.5 rounded-full ${
                      r.online ? "bg-good" : "bg-slate-600"
                    }`}
                    title={r.online ? "Online" : `Last seen ${r.last_seen_at}`}
                  />
                </td>
                <td className="py-1.5 pr-3">
                  {r.flagged_duplicate && (
                    <span
                      className="rounded bg-warn/20 px-1.5 py-0.5 text-xs text-warn"
                      title={`Rejoined from a different device ${r.device_mismatches} time(s). Flagged, not blocked.`}
                    >
                      dup ×{r.device_mismatches}
                    </span>
                  )}
                </td>
                {questions.map((q) => {
                  const a = r.answers[q.id];
                  return (
                    <td key={q.id} className="py-1.5 pr-2 text-center">
                      {!a ? (
                        <span className="text-slate-700">·</span>
                      ) : (
                        <span
                          className={
                            q.voided
                              ? "text-slate-500"
                              : a.correct
                                ? "text-good"
                                : "text-bad"
                          }
                          title={`Chose ${a.selected} — ${a.points} pts`}
                        >
                          {a.correct ? "✓" : "✗"}
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {rows.some((r) => r.flagged_duplicate) && (
        <p className="mt-4 text-xs text-slate-500">
          <b className="text-warn">dup</b> means someone rejoined on that roll
          number from a different device. Real rejoins do this all the time, so
          it&apos;s a flag to eyeball, not a block.
        </p>
      )}
    </div>
  );
}
