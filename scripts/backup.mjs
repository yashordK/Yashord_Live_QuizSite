#!/usr/bin/env node
/**
 * Full backup of a completed quiz. Run this BEFORE loading a new question
 * set — `questions:load --replace` deletes questions, and answers
 * cascade-delete with them, so the results of a finished event are gone
 * the moment you reload.
 *
 *   node scripts/backup.mjs
 *
 * Writes two files into exports/:
 *   quiz-backup-<date>.json  every row from every table, verbatim
 *   quiz-results-<date>.csv  ranked results, one row per student, with
 *                            per-question choice / correctness / points
 *
 * Both contain student names and roll numbers, so exports/ is gitignored.
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
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
  }
}

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

/** PostgREST caps a response at 1000 rows, so page explicitly. */
async function all(table, sel = "*") {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from(table).select(sel).range(from, from + 999);
    if (error) throw error;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
fs.mkdirSync("exports", { recursive: true });

const sessions = await all("sessions");
const questions = await all("questions");
const participants = await all("participants");
const answers = await all("answers");
const scores = await all("participant_scores");

const jsonPath = `exports/quiz-backup-${stamp}.json`;
fs.writeFileSync(
  jsonPath,
  JSON.stringify(
    { exported_at: new Date().toISOString(), sessions, questions, participants, answers, scores },
    null,
    2
  )
);

const qs = [...questions].sort((a, b) => a.order_index - b.order_index);
const byParticipant = new Map();
for (const a of answers) {
  if (!byParticipant.has(a.participant_id)) byParticipant.set(a.participant_id, {});
  byParticipant.get(a.participant_id)[a.question_id] = a;
}

const ranked = [...scores].sort(
  (a, b) => b.total_score - a.total_score || String(a.name).localeCompare(String(b.name))
);

const esc = (v) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

const header = ["rank", "name", "roll_number", "total_score", "correct", "answered"];
for (const q of qs) {
  header.push(`Q${q.order_index} choice`, `Q${q.order_index} correct`, `Q${q.order_index} pts`);
}

const lines = [header.join(",")];
ranked.forEach((p, i) => {
  const row = [i + 1, p.name, p.roll_number, p.total_score, p.correct_count, p.answered_count];
  const mine = byParticipant.get(p.participant_id) ?? {};
  for (const q of qs) {
    const a = mine[q.id];
    row.push(a ? a.selected_option : "", a ? (a.is_correct ? "Y" : "N") : "", a ? a.points_earned : "");
  }
  lines.push(row.map(esc).join(","));
});

const csvPath = `exports/quiz-results-${stamp}.csv`;
fs.writeFileSync(csvPath, lines.join("\n"));

console.log(`sessions     : ${sessions.length}`);
console.log(`questions    : ${questions.length}`);
console.log(`participants : ${participants.length}`);
console.log(`answers      : ${answers.length}`);
console.log("");
console.log(`wrote ${jsonPath}`);
console.log(`wrote ${csvPath}`);
