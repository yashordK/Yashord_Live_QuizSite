#!/usr/bin/env node
/**
 * Bulk-load questions from CSV or JSON into the session.
 *
 *   npm run questions:load -- --file data/questions.csv
 *   npm run questions:load -- --file data/questions.json --replace
 *   npm run questions:load -- --file data/questions.csv --dry-run
 *
 * Flags
 *   --file <path>   CSV or JSON (required)
 *   --replace       delete existing questions for this session first
 *   --dry-run       validate and print, write nothing
 *   --code <CODE>   override SESSION_CODE
 *
 * CSV columns (header row required; order doesn't matter):
 *   order_index, question_text, option_a, option_b, option_c, option_d,
 *   correct_option, solution_text, reading_time_sec, answer_time_sec,
 *   points, image_url
 *
 * Extra options beyond D are supported: add option_e, option_f, ...
 *
 * JSON: an array of objects with the same field names, or with an
 * `options` array of {key, text}.
 *
 * Every answer key is validated against the options BEFORE anything is
 * written. A typo'd key is the one mistake you cannot fix gracefully in
 * front of a class, so this refuses to load rather than warning.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createClient } from "@supabase/supabase-js";
import Papa from "papaparse";
import "dotenv/config";

// .env.local is what `next dev` reads; load it too so the script and the
// app never disagree about which database they're talking to.
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

// ---------------------------------------------------------------- args
const args = process.argv.slice(2);
function flag(name) {
  return args.includes(`--${name}`);
}
function opt(name, fallback = undefined) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}

const file = opt("file");
const replace = flag("replace");
const dryRun = flag("dry-run");
const code = (opt("code") ?? process.env.SESSION_CODE ?? "QUIZ01").toUpperCase();

if (!file) {
  console.error("Missing --file. See the header of this script for usage.");
  process.exit(1);
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!dryRun && (!SUPABASE_URL || !SERVICE_KEY)) {
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.\n" +
      "Copy .env.example to .env.local and fill them in."
  );
  process.exit(1);
}

// ---------------------------------------------------------------- parse
const raw = fs.readFileSync(path.resolve(file), "utf8");
const isJson = file.toLowerCase().endsWith(".json");

let records;
if (isJson) {
  const parsed = JSON.parse(raw);
  records = Array.isArray(parsed) ? parsed : parsed.questions;
  if (!Array.isArray(records)) {
    console.error("JSON must be an array, or an object with a `questions` array.");
    process.exit(1);
  }
} else {
  const result = Papa.parse(raw.trim(), {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim().toLowerCase().replace(/\s+/g, "_"),
  });
  if (result.errors.length) {
    console.error("CSV parse errors:");
    for (const e of result.errors.slice(0, 10)) {
      console.error(`  row ${e.row}: ${e.message}`);
    }
    process.exit(1);
  }
  records = result.data;
}

// ------------------------------------------------------------ normalize
const OPTION_KEYS = "ABCDEFGH".split("");

function buildOptions(rec) {
  if (Array.isArray(rec.options)) {
    return rec.options
      .map((o, i) =>
        typeof o === "string"
          ? { key: OPTION_KEYS[i], text: o.trim() }
          : { key: String(o.key).trim().toUpperCase(), text: String(o.text).trim() }
      )
      .filter((o) => o.text !== "");
  }

  const out = [];
  for (const k of OPTION_KEYS) {
    const v = rec[`option_${k.toLowerCase()}`];
    if (v !== undefined && v !== null && String(v).trim() !== "") {
      out.push({ key: k, text: String(v).trim() });
    }
  }
  return out;
}

function intOr(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && String(v).trim() !== "" ? Math.round(n) : fallback;
}

const errors = [];
const questions = records.map((rec, i) => {
  const line = i + 2; // +1 for zero-index, +1 for the header row
  const order_index = intOr(rec.order_index, i + 1);
  const question_text = String(rec.question_text ?? "").trim();
  const options = buildOptions(rec);
  const correct_option = String(rec.correct_option ?? "").trim().toUpperCase();

  if (!question_text) errors.push(`row ${line}: question_text is empty`);
  if (options.length < 2) errors.push(`row ${line}: needs at least 2 options`);

  // The check that matters most.
  if (!correct_option) {
    errors.push(`row ${line}: correct_option is empty`);
  } else if (!options.some((o) => o.key === correct_option)) {
    errors.push(
      `row ${line}: correct_option "${correct_option}" is not one of the options ` +
        `(${options.map((o) => o.key).join(", ")})`
    );
  }

  return {
    order_index,
    question_text,
    image_url: String(rec.image_url ?? "").trim() || null,
    options,
    correct_option,
    solution_text: String(rec.solution_text ?? "").trim() || null,
    reading_time_sec: intOr(rec.reading_time_sec, 5),
    answer_time_sec: intOr(rec.answer_time_sec, 20),
    points: intOr(rec.points, 100),
  };
});

const seen = new Set();
for (const q of questions) {
  if (seen.has(q.order_index)) {
    errors.push(`duplicate order_index ${q.order_index}`);
  }
  seen.add(q.order_index);
}

if (errors.length) {
  console.error(`\n✗ ${errors.length} problem(s) — nothing was written:\n`);
  for (const e of errors) console.error("  " + e);
  process.exit(1);
}

console.log(`\n✓ Parsed ${questions.length} questions from ${file}`);
console.log(`  Answer keys: ${questions.map((q) => `${q.order_index}${q.correct_option}`).join(" ")}`);

const totalSec = questions.reduce(
  (a, q) => a + q.reading_time_sec + q.answer_time_sec,
  0
);
console.log(
  `  Minimum runtime (timers only, no discussion): ${Math.round(totalSec / 60)} min\n`
);

if (dryRun) {
  console.log("Dry run — nothing written. Re-run without --dry-run to load.");
  process.exit(0);
}

// ------------------------------------------------------------- write
const db = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

const { data: session, error: sErr } = await db
  .from("sessions")
  .select("id, code")
  .eq("code", code)
  .maybeSingle();

if (sErr) {
  console.error("Database error:", sErr.message);
  process.exit(1);
}
if (!session) {
  console.error(
    `No session with code "${code}". Run supabase/seed.sql first (and make sure the code matches).`
  );
  process.exit(1);
}

if (replace) {
  // Answers cascade-delete with their questions. That's intended for a
  // pre-event reload, and it's why --replace is opt-in.
  const { error } = await db.from("questions").delete().eq("session_id", session.id);
  if (error) {
    console.error("Failed to clear existing questions:", error.message);
    process.exit(1);
  }
  console.log("Cleared existing questions.");
}

const rows = questions.map((q) => ({ ...q, session_id: session.id }));

const { error: upErr } = await db
  .from("questions")
  .upsert(rows, { onConflict: "session_id,order_index" });

if (upErr) {
  console.error("Insert failed:", upErr.message);
  process.exit(1);
}

console.log(`✓ Loaded ${rows.length} questions into session ${code}.`);
console.log("\nNext: open /host/control and check the answer keys in the Questions tab.");
