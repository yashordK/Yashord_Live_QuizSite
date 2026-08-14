#!/usr/bin/env node
/**
 * Load test: 200+ concurrent clients join, poll, heartbeat and answer.
 *
 * Run this BEFORE the event. Not with 50 clients — with more than you
 * expect, so you see the "quiz is full" path behave gracefully instead
 * of discovering it live.
 *
 *   node loadtest/run.mjs --n 220 --drive
 *   node loadtest/run.mjs --n 220 --drive --url https://your-app.vercel.app
 *   node loadtest/run.mjs --cleanup
 *
 * Flags
 *   --n <count>          virtual students (default 220)
 *   --url <base>         target (default LOADTEST_BASE_URL or localhost:3000)
 *   --drive              log in as host and run the phases automatically
 *   --questions <n>      how many questions to drive through (default 3)
 *   --answer-window <s>  seconds to spread answers over (default 8)
 *   --roll-prefix <s>    roll prefix for fake students (default LT)
 *   --cleanup            delete the fake participants, then exit
 *   --keep               leave fake participants behind (default is to
 *                        offer the cleanup command at the end)
 *
 * What to look for in the output:
 *   - join p95 well under a couple of seconds
 *   - ZERO unexpected join errors (429s and "full" are expected, and are
 *     the graceful paths working)
 *   - answer p95 under ~1s, and answered_count matching what you expect
 *   - no 5xx anywhere
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

for (const f of [".env.local", ".env"]) {
  const p = path.resolve(process.cwd(), f);
  if (fs.existsSync(p)) {
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
  }
}

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : d;
};

const BASE = (opt("url", process.env.LOADTEST_BASE_URL) ?? "http://localhost:3000").replace(/\/$/, "");
const N = Number(opt("n", 220));
const DRIVE = flag("drive");
const QUESTIONS = Number(opt("questions", 3));
const ANSWER_WINDOW_MS = Number(opt("answer-window", 8)) * 1000;
const ROLL_PREFIX = opt("roll-prefix", "LT").toUpperCase();
const CODE = (process.env.SESSION_CODE ?? "QUIZ01").toUpperCase();
const HOST_PASSWORD = opt("host-password", process.env.HOST_PASSWORD);

/* ------------------------------------------------------------------ */
/* stats                                                               */
/* ------------------------------------------------------------------ */

class Stat {
  constructor(name) {
    this.name = name;
    this.samples = [];
    this.codes = new Map();
    this.errors = new Map();
  }
  add(ms, status) {
    this.samples.push(ms);
    this.codes.set(status, (this.codes.get(status) ?? 0) + 1);
  }
  err(message) {
    const k = String(message).slice(0, 80);
    this.errors.set(k, (this.errors.get(k) ?? 0) + 1);
  }
  pct(p) {
    if (!this.samples.length) return 0;
    const s = [...this.samples].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
  }
  report() {
    if (!this.samples.length && !this.errors.size) return;
    const codes = [...this.codes.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([c, n]) => `${c}:${n}`)
      .join("  ");
    console.log(
      `  ${this.name.padEnd(12)} n=${String(this.samples.length).padEnd(6)} ` +
        `p50=${String(Math.round(this.pct(50))).padStart(5)}ms  ` +
        `p95=${String(Math.round(this.pct(95))).padStart(5)}ms  ` +
        `p99=${String(Math.round(this.pct(99))).padStart(5)}ms  ` +
        `max=${String(Math.round(this.pct(100))).padStart(5)}ms   [${codes}]`
    );
    for (const [msg, n] of this.errors) {
      console.log(`      ✗ ${n}× ${msg}`);
    }
  }
}

const stats = {
  join: new Stat("join"),
  state: new Stat("state"),
  answer: new Stat("answer"),
  heartbeat: new Stat("heartbeat"),
  leaderboard: new Stat("leaderboard"),
};

const outcomes = { created: 0, rejoined: 0, full: 0, locked: 0, rateLimited: 0, failed: 0 };

/* ------------------------------------------------------------------ */
/* a virtual student                                                   */
/* ------------------------------------------------------------------ */

class Student {
  constructor(i) {
    this.i = i;
    this.roll = `${ROLL_PREFIX}${String(i + 1).padStart(3, "0")}`;
    this.name = `Load Test ${i + 1}`;
    this.cookies = new Map();
    this.joined = false;
    this.deviceToken = `loadtest-${i}`;
    this.answeredFor = new Set();
  }

  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  absorb(res) {
    const set = res.headers.getSetCookie?.() ?? [];
    for (const c of set) {
      const [pair] = c.split(";");
      const idx = pair.indexOf("=");
      if (idx > 0) this.cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  }

  async req(stat, method, url, body) {
    const t0 = performance.now();
    try {
      const res = await fetch(BASE + url, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(this.cookies.size ? { Cookie: this.cookieHeader() } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      this.absorb(res);
      stat.add(performance.now() - t0, res.status);
      const json = await res.json().catch(() => ({}));
      return { status: res.status, json };
    } catch (e) {
      stat.err(e.message);
      return { status: 0, json: {} };
    }
  }

  async join() {
    const { status, json } = await this.req(stats.join, "POST", "/api/join", {
      name: this.name,
      roll: this.roll,
      code: CODE,
      device_token: this.deviceToken,
    });

    if (status === 200) {
      this.joined = true;
      outcomes[json.rejoined ? "rejoined" : "created"]++;
    } else if (status === 429) {
      outcomes.rateLimited++;
    } else if (json.reason === "full") {
      outcomes.full++;
    } else if (json.reason === "locked") {
      outcomes.locked++;
    } else {
      outcomes.failed++;
      stats.join.err(json.error ?? `HTTP ${status}`);
    }
  }

  async poll() {
    const { json } = await this.req(stats.state, "GET", "/api/state");
    return json;
  }

  async heartbeat() {
    await this.req(stats.heartbeat, "POST", "/api/heartbeat");
  }

  async answer(questionId, options) {
    if (this.answeredFor.has(questionId)) return;
    this.answeredFor.add(questionId);
    const pick = options[Math.floor(Math.random() * options.length)].key;
    const { status, json } = await this.req(stats.answer, "POST", "/api/answer", {
      question_id: questionId,
      option: pick,
    });
    if (status !== 200 && status !== 409) {
      stats.answer.err(json.error ?? `HTTP ${status}`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* host driver                                                         */
/* ------------------------------------------------------------------ */

const host = { cookies: new Map() };

async function hostReq(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(host.cookies.size
        ? { Cookie: [...host.cookies].map(([k, v]) => `${k}=${v}`).join("; ") }
        : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(";");
    const i = pair.indexOf("=");
    if (i > 0) host.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

async function hostAction(action) {
  const { status, json } = await hostReq("POST", "/api/host/action", { action });
  if (status !== 200) console.log(`    host ${action} → ${status} ${json.error ?? ""}`);
  return status === 200;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* cleanup                                                             */
/* ------------------------------------------------------------------ */

async function cleanup() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Cleanup needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local.");
    process.exit(1);
  }

  const { createClient } = await import("@supabase/supabase-js");
  const db = createClient(url, key, { auth: { persistSession: false } });

  const { data, error } = await db
    .from("participants")
    .delete()
    .like("roll_number", `${ROLL_PREFIX}%`)
    .select("id");

  if (error) {
    console.error("Cleanup failed:", error.message);
    process.exit(1);
  }
  console.log(`✓ Removed ${data?.length ?? 0} load-test participants (roll prefix ${ROLL_PREFIX}).`);
  console.log("  Their answer rows cascade-deleted with them.");
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  if (flag("cleanup")) {
    await cleanup();
    return;
  }

  console.log(`\nLoad test → ${BASE}`);
  console.log(`  ${N} virtual students, join code ${CODE}, roll prefix ${ROLL_PREFIX}`);
  if (DRIVE) console.log(`  driving ${QUESTIONS} question(s) as host\n`);
  else console.log(`  NOT driving — advance phases yourself in /host/control\n`);

  // ---- host login + reset -----------------------------------------
  if (DRIVE) {
    if (!HOST_PASSWORD) {
      console.error("--drive needs HOST_PASSWORD in .env.local or --host-password.");
      process.exit(1);
    }
    const { status } = await hostReq("POST", "/api/host/login", { password: HOST_PASSWORD });
    if (status !== 200) {
      console.error(`Host login failed (${status}). Check HOST_PASSWORD.`);
      process.exit(1);
    }
    console.log("  host logged in, resetting session to IDLE");
    await hostAction("RESET");
    // Make sure joining is open and the cap is whatever you configured.
    await hostReq("POST", "/api/host/settings", { joining_locked: false });
  }

  const students = Array.from({ length: N }, (_, i) => new Student(i));

  // ---- phase 1: the join stampede ---------------------------------
  // Everyone hits Join within a couple of seconds, which is exactly what
  // happens when the code goes up on the projector.
  console.log("→ joining…");
  const t0 = performance.now();
  await Promise.all(
    students.map(async (s, i) => {
      await sleep(Math.random() * 2000);
      await s.join();
    })
  );
  console.log(`  joined in ${Math.round(performance.now() - t0)}ms`);
  console.log(
    `  created=${outcomes.created} rejoined=${outcomes.rejoined} ` +
      `full=${outcomes.full} locked=${outcomes.locked} ` +
      `rate-limited=${outcomes.rateLimited} failed=${outcomes.failed}`
  );

  const active = students.filter((s) => s.joined);
  if (active.length === 0) {
    console.error("\nNobody joined. Is the session seeded and the code correct?");
    process.exit(1);
  }

  // ---- rejoin check ------------------------------------------------
  // Re-join a sample with DIFFERENT formatting of the same roll. These
  // must all come back as `rejoined`, never `created` — that is the
  // score-loss bug this whole design exists to prevent.
  console.log("→ testing rejoin with reformatted roll numbers…");
  const before = outcomes.created;
  const sample = active.slice(0, Math.min(20, active.length));
  await Promise.all(
    sample.map(async (s) => {
      const scrambled = s.roll.toLowerCase().replace(/^(\D+)/, "$1-");
      const saved = s.roll;
      s.roll = scrambled;
      await s.join();
      s.roll = saved;
    })
  );
  const newlyCreated = outcomes.created - before;
  if (newlyCreated > 0) {
    console.log(
      `  ✗ FAIL: ${newlyCreated} reformatted rejoin(s) created NEW participants.\n` +
        `    Roll normalization is broken — students would lose their scores.`
    );
  } else {
    console.log(`  ✓ all ${sample.length} reformatted rejoins matched the existing row`);
  }

  // ---- background polling + heartbeat ------------------------------
  let running = true;
  const pollers = active.map(async (s) => {
    // Stagger so 200 clients don't align into a thundering herd.
    await sleep(Math.random() * 5000);
    while (running) {
      await s.poll();
      await sleep(5000);
    }
  });
  const beats = active.map(async (s) => {
    await sleep(Math.random() * 25000);
    while (running) {
      await s.heartbeat();
      await sleep(25000);
    }
  });

  // ---- phase 2: drive questions ------------------------------------
  if (DRIVE) {
    for (let qi = 0; qi < QUESTIONS; qi++) {
      console.log(`→ question ${qi + 1}/${QUESTIONS}`);

      if (!(await hostAction(qi === 0 ? "START" : "NEXT"))) break;
      await sleep(1500);

      await hostAction("SHOW_OPTIONS");
      const state = await active[0].poll();
      const question = state.question;
      const options = question?.options ?? [];

      if (!options.length) {
        console.log("    no options in payload — is the session seeded with questions?");
        break;
      }

      // Everyone answers at a random point inside the window, which is
      // where the double-submit and late-answer races actually live.
      const tAnswer = performance.now();
      await Promise.all(
        active.map(async (s) => {
          await sleep(Math.random() * ANSWER_WINDOW_MS);
          await s.answer(question.id, options);
          // A slice of students double-tap. UNIQUE(question_id,
          // participant_id) must absorb this without erroring.
          if (Math.random() < 0.15) {
            s.answeredFor.delete(question.id);
            await s.answer(question.id, options);
          }
        })
      );
      console.log(`    all answers submitted in ${Math.round(performance.now() - tAnswer)}ms`);

      await hostAction("LOCK");

      // A late answer AFTER the lock must be refused, not scored.
      const late = active[0];
      late.answeredFor.delete(question.id);
      const lateRes = await late.req(stats.answer, "POST", "/api/answer", {
        question_id: question.id,
        option: options[0].key,
      });
      console.log(
        lateRes.status === 409
          ? "    ✓ post-lock answer correctly refused"
          : `    ✗ post-lock answer returned ${lateRes.status} — expected 409`
      );

      await hostAction("REVEAL");
      await sleep(500);

      // Leaderboard pull, as the clients do on REVEALED.
      await Promise.all(active.slice(0, 50).map((s) => s.req(stats.leaderboard, "GET", "/api/leaderboard?limit=10")));

      await hostAction("SOLUTION");
      await sleep(500);
    }

    await hostAction("LEADERBOARD");
  } else {
    console.log("→ polling for 60s — drive the phases in /host/control now");
    await sleep(60_000);
  }

  running = false;
  await Promise.allSettled([...pollers, ...beats]);

  // ---- report ------------------------------------------------------
  console.log("\n─── latencies ─────────────────────────────────────────────────");
  for (const s of Object.values(stats)) s.report();

  const anyServerError = Object.values(stats).some((s) =>
    [...s.codes.keys()].some((c) => c >= 500)
  );

  console.log("\n─── verdict ───────────────────────────────────────────────────");
  console.log(`  students joined:        ${active.length} / ${N}`);
  console.log(`  graceful 'full':        ${outcomes.full}`);
  console.log(`  rate-limited:           ${outcomes.rateLimited}`);
  console.log(`  unexpected failures:    ${outcomes.failed}`);
  console.log(`  5xx anywhere:           ${anyServerError ? "YES — investigate" : "none"}`);

  if (!flag("keep")) {
    console.log(
      `\n  Clean up the fake participants before the event:\n` +
        `    node loadtest/run.mjs --cleanup --roll-prefix ${ROLL_PREFIX}`
    );
  }
  console.log("");

  process.exit(anyServerError || outcomes.failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
