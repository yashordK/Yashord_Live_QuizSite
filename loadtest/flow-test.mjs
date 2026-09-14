#!/usr/bin/env node
/**
 * End-to-end host-flow test for the paths the load test doesn't cover:
 *
 *   - the auto-leaderboard firing after question 5 (and not re-firing)
 *   - "void this question" zeroing its points for everyone, reversibly
 *   - "skip question" removing it from the numbering
 *   - the CSV export being complete and correctly shaped
 *   - the participants endpoint reporting per-question correctness
 *
 *   node loadtest/flow-test.mjs --host-password <pw> [--url http://localhost:3400]
 *
 * Creates a handful of fake students, so run `node loadtest/run.mjs
 * --cleanup --roll-prefix FT` afterwards.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

for (const f of [".env.local", ".env"]) {
  const p = path.resolve(process.cwd(), f);
  if (fs.existsSync(p)) {
    for (const l of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i !== -1 && args[i + 1] ? args[i + 1] : d; };

const BASE = (opt("url", "http://localhost:3400")).replace(/\/$/, "");
const PW = opt("host-password", process.env.HOST_PASSWORD);
const CODE = (process.env.SESSION_CODE ?? "QUIZ01").toUpperCase();
const N = Number(opt("n", 5));

let pass = 0, fail = 0;
function check(name, ok, detail = "") {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}\n        ${detail}`); }
}

const jar = new Map();
function cookieHeader(j) { return [...j].map(([k, v]) => `${k}=${v}`).join("; "); }
function absorb(j, res) {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(";"); const i = pair.indexOf("=");
    if (i > 0) j.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}
async function req(j, method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: { "Content-Type": "application/json", ...(j.size ? { Cookie: cookieHeader(j) } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  absorb(j, res);
  const ct = res.headers.get("content-type") ?? "";
  return { status: res.status, body: ct.includes("json") ? await res.json().catch(() => ({})) : await res.text() };
}
const host = (m, u, b) => req(jar, m, u, b);
const act = (a) => host("POST", "/api/host/action", { action: a });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

console.log(`\nFlow test → ${BASE}\n`);

if (!PW) { console.error("Need --host-password or HOST_PASSWORD."); process.exit(1); }
const login = await host("POST", "/api/host/login", { password: PW });
if (login.status !== 200) { console.error(`Host login failed (${login.status}).`); process.exit(1); }

await act("RESET");

// ---- students ---------------------------------------------------------
const students = [];
for (let i = 0; i < N; i++) {
  const j = new Map();
  const roll = `FT${String(i + 1).padStart(3, "0")}`;
  const r = await req(j, "POST", "/api/join", { name: `Flow ${i + 1}`, roll, code: CODE, device_token: `ft-${i}` });
  if (r.status === 200) students.push({ jar: j, roll });
}
check("students joined", students.length === N, `only ${students.length}/${N} joined`);

// ---- walk 6 questions -------------------------------------------------
console.log("\n-- walking questions 1..6 --");
let sawLeaderboardAfter5 = false;
let q5Id = null, q3Id = null;

for (let n = 1; n <= 6; n++) {
  await act(n === 1 ? "START" : "NEXT");
  let st = (await host("GET", "/api/state")).body;

  // The auto-leaderboard interrupts NEXT after question 5.
  if (st.session.phase === "LEADERBOARD") {
    sawLeaderboardAfter5 = true;
    check("auto-leaderboard fired after Q5", n === 6, `fired while advancing to question ${n}`);
    await act("NEXT");
    st = (await host("GET", "/api/state")).body;
  }

  await act("SHOW_OPTIONS");
  st = (await host("GET", "/api/state")).body;
  const q = st.question;
  if (st.question_number === 3) q3Id = q.id;
  if (st.question_number === 5) q5Id = q.id;

  // The answer key must come from the HOST dashboard, not /api/state.
  // /api/state strips correct_option during ACCEPTING_ANSWERS for every
  // caller including the host — which is the whole point of that endpoint,
  // and which silently broke this test when it read the key from there.
  const dash = (await host("GET", "/api/host/dashboard")).body;
  const correct = dash.state?.question?.correct_option;
  if (!correct) {
    check(`answer key available to host on question ${st.question_number}`, false, "host dashboard returned no correct_option");
    break;
  }
  for (const [i, s] of students.entries()) {
    const pick = i === 0 ? correct : q.options[(i + 1) % q.options.length].key;
    await req(s.jar, "POST", "/api/answer", { question_id: q.id, option: pick });
  }

  await act("LOCK");
  await act("REVEAL");
}

check("auto-leaderboard fired exactly once in 6 questions", sawLeaderboardAfter5);

// ---- scores before voiding -------------------------------------------
let lb = (await host("GET", "/api/leaderboard?limit=50")).body;
const topBefore = lb.entries[0];
check("leader is the always-correct student", topBefore?.roll_number === "FT001", `got ${topBefore?.roll_number}`);
// Track FT001 specifically for the void assertions below — comparing
// entries[0] across calls would silently compare two different students
// if the ranking changed.
const scoreBefore = lb.entries.find(e => e.roll_number === "FT001")?.total_score ?? 0;
check("leader has a non-zero score", scoreBefore > 0, `score ${scoreBefore}`);

// ---- void a question --------------------------------------------------
console.log("\n-- void / un-void --");
await host("POST", "/api/host/question", { question_id: q3Id, voided: true });
await sleep(300);
lb = (await host("GET", "/api/leaderboard?limit=50")).body;
const scoreVoided = lb.entries.find(e => e.roll_number === "FT001")?.total_score ?? -1;
check("voiding a question lowers the score", scoreVoided < scoreBefore, `${scoreBefore} -> ${scoreVoided}`);

await host("POST", "/api/host/question", { question_id: q3Id, voided: false });
await sleep(300);
lb = (await host("GET", "/api/leaderboard?limit=50")).body;
const scoreRestored = lb.entries.find(e => e.roll_number === "FT001")?.total_score ?? -1;
check("un-voiding restores the exact original score", scoreRestored === scoreBefore, `${scoreBefore} -> ${scoreRestored}`);

// ---- skip -------------------------------------------------------------
console.log("\n-- skip --");
const beforeSkip = (await host("GET", "/api/state")).body.question_total;
await host("POST", "/api/host/question", { question_id: q5Id, skipped: true });
await sleep(300);
const afterSkip = (await host("GET", "/api/state")).body.question_total;
check("skipping removes a question from the count", afterSkip === beforeSkip - 1, `${beforeSkip} -> ${afterSkip}`);
await host("POST", "/api/host/question", { question_id: q5Id, skipped: false });

// ---- participants -----------------------------------------------------
console.log("\n-- participants + export --");
const parts = (await host("GET", "/api/host/participants")).body;
// Count only this run's FT rows: a real session may already hold other
// participants (a demo, an earlier join), and the endpoint is right to return them.
const ours = (parts.participants ?? []).filter((p) => String(p.roll_number).startsWith("FT"));
check("participants endpoint returns every test student", ours.length === N, `got ${ours.length} of ${N} (session total ${parts.participants?.length})`);
const first = parts.participants?.find(p => p.roll_number === "FT001");
check("per-question correctness recorded", Object.keys(first?.answers ?? {}).length === 6, `${Object.keys(first?.answers ?? {}).length} answers`);
check("always-correct student is 6/6", first?.correct_count === 6, `correct_count=${first?.correct_count}`);

// ---- CSV --------------------------------------------------------------
const csv = (await host("GET", "/api/host/export")).body;
const lines = String(csv).trim().split(/\r?\n/);
const ftRows = lines.slice(1).filter((l) => /(^|,)"?FT[0-9]{3}"?(,|$)/.test(l)).length;
check("CSV has a header plus one row per test student", ftRows === N && lines.length >= N + 1, `${ftRows} FT rows of ${N}, ${lines.length} lines total`);
check("CSV header has identity columns", /rank.*name.*roll_number.*total_score/i.test(lines[0]), lines[0]?.slice(0, 80));
check("CSV has a column group per question", (lines[0].match(/Q\d+ choice/g) ?? []).length >= 6, `${(lines[0].match(/Q\d+ choice/g) ?? []).length} question columns`);
check("CSV contains the students", lines.some(l => l.includes("FT001")));

// ---- host auth boundary ----------------------------------------------
console.log("\n-- auth boundary --");
const anon = new Map();
for (const [name, url] of [
  ["action", "/api/host/action"], ["settings", "/api/host/settings"],
  ["question", "/api/host/question"], ["rebroadcast", "/api/host/rebroadcast"],
]) {
  const r = await req(anon, "POST", url, { action: "REVEAL" });
  check(`unauthenticated POST ${name} is refused`, r.status === 401, `got ${r.status}`);
}
for (const [name, url] of [["dashboard", "/api/host/dashboard"], ["participants", "/api/host/participants"], ["export", "/api/host/export"]]) {
  const r = await req(anon, "GET", url);
  check(`unauthenticated GET ${name} is refused`, r.status === 401, `got ${r.status}`);
}

// ---- answer key never leaks to students -------------------------------
console.log("\n-- answer key exposure --");
await act("NEXT"); await act("SHOW_OPTIONS");
const studentView = (await req(students[0].jar, "GET", "/api/state")).body;
check("no correct_option during ACCEPTING_ANSWERS", studentView.question?.correct_option == null, `leaked: ${studentView.question?.correct_option}`);
check("no solution_text during ACCEPTING_ANSWERS", studentView.question?.solution_text == null);
await act("LOCK");
const lockedView = (await req(students[0].jar, "GET", "/api/state")).body;
check("no correct_option during LOCKED", lockedView.question?.correct_option == null, `leaked: ${lockedView.question?.correct_option}`);
await act("REVEAL");
const revealedView = (await req(students[0].jar, "GET", "/api/state")).body;
check("correct_option present once REVEALED", revealedView.question?.correct_option != null);

await act("RESET");

console.log(`\n${pass} passed, ${fail} failed\n`);
console.log("Clean up:  node loadtest/run.mjs --cleanup --roll-prefix FT\n");
process.exit(fail > 0 ? 1 : 0);
