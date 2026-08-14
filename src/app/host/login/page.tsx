"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function HostLoginPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const res = await fetch("/api/host/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ password }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "Login failed.");
        return;
      }

      // The cookie is what actually authorises anything; this navigation
      // is just a convenience.
      router.push("/host/control");
      router.refresh();
    } catch {
      setError("No connection.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-5">
      <h1 className="mb-2 text-2xl font-bold">Host login</h1>
      <p className="mb-6 text-sm text-slate-400">
        Works from any device — if your laptop dies mid-session, log in on your
        phone and carry on.
      </p>

      <form onSubmit={submit} className="space-y-4">
        <input
          type="password"
          className="field"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Host password"
          autoComplete="current-password"
          autoFocus
          required
        />

        {error && (
          <p
            role="alert"
            className="rounded-xl border border-bad/50 bg-bad/10 px-4 py-3 text-sm text-red-200"
          >
            {error}
          </p>
        )}

        <button className="btn btn-primary w-full py-3" disabled={busy}>
          {busy ? "Checking…" : "Log in"}
        </button>
      </form>
    </main>
  );
}
