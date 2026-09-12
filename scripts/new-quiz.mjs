#!/usr/bin/env node
/**
 * Start a fresh quiz WITHOUT destroying the last one.
 *
 *   node scripts/new-quiz.mjs [--archive-code ARCHIVE-2026-09-12]
 *
 * Renames the current session's join code to an archive code and creates
 * a new session under the original SESSION_CODE. Because the app looks
 * the session up by code, the new one becomes live immediately with no
 * redeploy and no env change, while the finished event keeps every
 * participant, answer and score row intact under the archive code.
 *
 * This is the safe alternative to `questions:load --replace` on a session
 * that has already been played: that deletes questions, and answers
 * cascade-delete with them.
 *
 * Run `node scripts/backup.mjs` first regardless. Belt and braces.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createClient } from "@supabase/supabase-js";

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
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : d;
};

const CODE = (process.env.SESSION_CODE ?? "QUIZ01").toUpperCase();
const stamp = new Date().toISOString().slice(0, 10);
const ARCHIVE = opt("archive-code", `ARCHIVE-${stamp}`).toUpperCase();
const TITLE = opt("title", null);

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const { data: current, error: e1 } = await db
  .from("sessions")
  .select("*")
  .eq("code", CODE)
  .maybeSingle();
if (e1) throw e1;

if (!current) {
  console.error(`No session with code ${CODE}. Nothing to archive.`);
  process.exit(1);
}

const { count: pc } = await db
  .from("participants")
  .select("id", { count: "exact", head: true })
  .eq("session_id", current.id);

console.log(`Archiving "${current.title}" (${CODE}) -> ${ARCHIVE}`);
console.log(`  it keeps ${pc ?? 0} participants and all their answers\n`);

const { error: e2 } = await db
  .from("sessions")
  .update({ code: ARCHIVE, status: "ended", phase: "LEADERBOARD" })
  .eq("id", current.id);
if (e2) throw e2;

// Carry the operational settings forward; a new event almost always
// wants the same cap, cadence and roll handling as the last one.
const { data: fresh, error: e3 } = await db
  .from("sessions")
  .insert({
    code: CODE,
    title: TITLE ?? current.title,
    status: "lobby",
    phase: "IDLE",
    join_cap: current.join_cap,
    leaderboard_interval: current.leaderboard_interval,
    leaderboard_top: current.leaderboard_top,
    roll_prefixes: current.roll_prefixes,
    joining_locked: false,
  })
  .select("id, code, title, join_cap, leaderboard_interval, leaderboard_top")
  .single();
if (e3) throw e3;

console.log(`New live session ${fresh.code}: "${fresh.title}"`);
console.log(`  cap ${fresh.join_cap} · leaderboard every ${fresh.leaderboard_interval} · shows top ${fresh.leaderboard_top}`);
console.log(`  0 participants, 0 questions\n`);
console.log("Next: node scripts/load-questions.mjs --file data/questions.json");
