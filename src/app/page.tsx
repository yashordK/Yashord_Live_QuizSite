"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { normalizeRoll } from "@/lib/roll";

/**
 * Pad width for the on-screen preview only. The SERVER is authoritative
 * (it uses ROLL_PAD_LENGTH); this exists purely so a student can see the
 * canonical form before committing, which is what stops "I typed it
 * differently last time" from ever becoming a lost score.
 */
const PREVIEW_PAD = Number(process.env.NEXT_PUBLIC_ROLL_PAD_LENGTH ?? 3) || 3;

/** Stable per-device id, used only to flag (never block) duplicate logins. */
function getDeviceToken(): string {
  const KEY = "lq_device_token";
  try {
    let t = localStorage.getItem(KEY);
    if (!t) {
      t = crypto.randomUUID();
      localStorage.setItem(KEY, t);
    }
    return t;
  } catch {
    // Private browsing with storage blocked. The host just sees no
    // device info for this student, which is fine — it's advisory.
    return "";
  }
}

type Blocked = { title: string; detail: string } | null;

export default function JoinPage() {
  const router = useRouter();

  const [name, setName] = useState("");
  const [roll, setRoll] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<Blocked>(null);

  // Prefix picker. Empty list = plain free-text entry.
  const [prefixes, setPrefixes] = useState<string[]>([]);
  const [prefix, setPrefix] = useState<string>("");
  // The escape hatch. A student whose prefix isn't on the list must
  // always be able to join — locked out is worse than a typo.
  const [freeText, setFreeText] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/state", { cache: "no-store" });
        if (!res.ok) return;
        const s = await res.json();
        const list: string[] = s?.session?.roll_prefixes ?? [];
        if (!cancelled && Array.isArray(list) && list.length > 0) {
          setPrefixes(list);
          setPrefix((p) => p || list[0]);
        }
      } catch {
        // Prefixes are a convenience; free-text entry still works.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const usingPicker = prefixes.length > 0 && !freeText;

  // Show the canonical form as they type. Display-only — the server
  // normalizes again and its result is what's stored.
  const canonicalPreview = useMemo(() => {
    const c = normalizeRoll(usingPicker ? prefix + roll : roll, PREVIEW_PAD);
    // Don't show it until it looks like a real roll, otherwise it flickers
    // nonsense at them after the first keystroke.
    return c.length >= 3 && /\d/.test(c) && /^[A-Z0-9]+$/.test(c) ? c : "";
  }, [roll, prefix, usingPicker]);

  // Remember what they typed so a refresh mid-lecture isn't a retype.
  useEffect(() => {
    try {
      setName(localStorage.getItem("lq_name") ?? "");
      setRoll(localStorage.getItem("lq_roll") ?? "");
      setCode(localStorage.getItem("lq_code") ?? "");
    } catch {
      /* storage blocked; not important */
    }
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;

    setBusy(true);
    setError(null);

    try {
      const res = await fetch("/api/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          name,
          roll,
          // Sent separately; the server concatenates and re-normalizes.
          roll_prefix: usingPicker ? prefix : undefined,
          code,
          device_token: getDeviceToken(),
        }),
      });

      const body = await res.json().catch(() => ({}));

      if (!res.ok) {
        if (body.reason === "full" || body.reason === "locked" || body.reason === "ended") {
          setBlocked({ title: body.error, detail: body.detail ?? "" });
        } else {
          setError(body.error ?? "Could not join. Please try again.");
        }
        return;
      }

      try {
        localStorage.setItem("lq_name", body.name ?? name);
        // Store the CANONICAL roll the server settled on, so a rejoin
        // sends the same value we already have a participant row for.
        localStorage.setItem("lq_roll", body.roll_number ?? roll);
        localStorage.setItem("lq_code", code.trim().toUpperCase());
      } catch {
        /* storage blocked */
      }

      router.push("/play");
    } catch {
      setError("No connection. Check your network and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (blocked) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-5 py-10">
        <div className="card border-warn/40 text-center">
          <div className="mb-3 text-5xl">🚦</div>
          <h1 className="mb-3 text-2xl font-bold text-warn">{blocked.title}</h1>
          <p className="text-slate-300">{blocked.detail}</p>
          <button
            className="btn mt-6 w-full"
            onClick={() => {
              setBlocked(null);
              setError(null);
            }}
          >
            Try again
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-5 py-10">
      <p className="mb-1 font-mono text-xs uppercase tracking-[0.35em] text-accent">
        Live Quiz
      </p>
      <h1 className="brand mb-3 text-4xl font-extrabold leading-tight">
        The Yashord Quiz
      </h1>
      <p className="mb-8 text-slate-400">
        Use the same roll number every time — it&apos;s how your score follows
        you if you get disconnected.
      </p>

      <form onSubmit={submit} className="space-y-4">
        <div>
          <label htmlFor="name" className="mb-2 block text-sm font-medium text-slate-300">
            Your name
          </label>
          <input
            id="name"
            className="field"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
            enterKeyHint="next"
            maxLength={40}
            required
          />
        </div>

        <div>
          <label htmlFor="roll" className="mb-2 block text-sm font-medium text-slate-300">
            Roll number
          </label>

          {usingPicker && (
            <div
              className="mb-2 flex flex-wrap gap-2"
              role="radiogroup"
              aria-label="Roll number prefix"
            >
              {prefixes.map((p) => (
                <button
                  key={p}
                  type="button"
                  role="radio"
                  aria-checked={prefix === p}
                  onClick={() => setPrefix(p)}
                  className={`rounded-xl border-2 px-4 py-3 font-mono text-base font-bold transition-colors ${
                    prefix === p
                      ? "border-accent bg-accent/20 text-white"
                      : "border-edge bg-panel/80 text-slate-300"
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>
          )}

          <div className={usingPicker ? "flex items-stretch gap-2" : ""}>
            {usingPicker && (
              <span className="flex select-none items-center rounded-xl border-2 border-edge bg-edge/40 px-4 font-mono text-lg font-bold text-slate-300">
                {prefix}
              </span>
            )}
            <input
              id="roll"
              className="field uppercase"
              value={roll}
              onChange={(e) => setRoll(e.target.value)}
              inputMode={usingPicker ? "numeric" : "text"}
              placeholder={usingPicker ? "101" : ""}
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="next"
              maxLength={usingPicker ? 8 : 25}
              required
            />
          </div>
          {canonicalPreview ? (
            <p className="mt-2 text-xs text-slate-400">
              You&apos;ll join as{" "}
              <span className="font-mono font-bold text-accent">
                {canonicalPreview}
              </span>
              {" "}— use this same roll if you get disconnected.
            </p>
          ) : (
            <p className="mt-2 text-xs text-slate-500">
              {usingPicker
                ? "Pick your prefix, then type just the numbers."
                : "Spaces, dashes and capitals don't matter."}
            </p>
          )}

          {/* The escape hatch. Never remove this: a student whose prefix
              isn't on the list must still be able to join. */}
          {prefixes.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setFreeText((f) => !f);
                setRoll("");
              }}
              className="mt-2 text-xs font-medium text-accent underline underline-offset-2"
            >
              {freeText
                ? "← Pick from the list instead"
                : "My roll number looks different"}
            </button>
          )}
        </div>

        <div>
          <label htmlFor="code" className="mb-2 block text-sm font-medium text-slate-300">
            Join code
          </label>
          <input
            id="code"
            className="field uppercase tracking-[0.3em]"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
            maxLength={10}
            required
          />
          <p className="mt-2 text-xs text-slate-500">Shown on the screen at the front.</p>
        </div>

        {error && (
          <div
            role="alert"
            className="rounded-xl border border-bad/50 bg-bad/10 px-4 py-3 text-sm text-red-200"
          >
            {error}
          </div>
        )}

        <button type="submit" className="btn btn-primary w-full py-4 text-lg" disabled={busy}>
          {busy ? "Joining…" : "Join"}
        </button>
      </form>
    </main>
  );
}
