#!/usr/bin/env node
/**
 * Security probe: proves the PUBLIC anon key cannot reach the database.
 *
 *   npm run probe
 *
 * This is a better check than reading pg_policies, because it tests the
 * thing you actually care about: a student opening devtools, lifting the
 * anon key out of the JS bundle (it is public by design), and pointing it
 * straight at your tables to read the answer keys.
 *
 * Every one of these MUST fail. A success is a hole.
 *
 * Run it after any change in the Supabase dashboard — the "Enable RLS"
 * flow there sometimes offers to add a starter policy such as "Enable
 * read access for all users", which would open exactly this door.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createClient } from "@supabase/supabase-js";

for (const f of [".env.local", ".env"]) {
  const p = path.resolve(process.cwd(), f);
  if (fs.existsSync(p)) {
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
  }
}

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!URL || !ANON) {
  console.error("Need NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.");
  process.exit(1);
}

// Exactly what a student's browser has.
const anon = createClient(URL, ANON, { auth: { persistSession: false } });

let failures = 0;

function report(name, blocked, detail) {
  if (blocked) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${detail}`);
  }
}

console.log(`\nProbing ${URL} with the PUBLIC anon key`);
console.log("Everything below must be blocked.\n");

// ---- reads -----------------------------------------------------------
for (const table of [
  "sessions",
  "questions",
  "participants",
  "answers",
  "participant_scores",
]) {
  const { data, error } = await anon.from(table).select("*").limit(1);
  const blocked = !!error || data === null;
  report(
    `read ${table}`,
    blocked,
    `Returned ${data?.length ?? 0} row(s). The anon key can read this table.` +
      (table === "questions"
        ? " THIS LEAKS YOUR ANSWER KEYS — drop the policy on public.questions."
        : "")
  );
}

// ---- writes ----------------------------------------------------------
{
  const { error } = await anon.from("participants").insert({
    session_id: "00000000-0000-0000-0000-000000000000",
    roll_number: "PROBE001",
    name: "probe",
  });
  report(
    "insert into participants",
    !!error,
    "The anon key can create participants directly, bypassing the join cap."
  );
}

{
  const { error } = await anon
    .from("sessions")
    .update({ phase: "REVEALED" })
    .neq("id", "00000000-0000-0000-0000-000000000000");
  report(
    "update sessions.phase",
    !!error,
    "The anon key can drive the state machine. Any student could reveal answers."
  );
}

// ---- RPCs ------------------------------------------------------------
for (const [fn, args] of [
  ["get_state", { p_code: process.env.SESSION_CODE ?? "QUIZ01", p_participant_id: null }],
  ["join_participant", {
    p_session_id: "00000000-0000-0000-0000-000000000000",
    p_roll: "PROBE001", p_raw_roll: "PROBE001", p_name: "probe", p_device_token: null,
  }],
  ["answer_distribution", { p_question_id: "00000000-0000-0000-0000-000000000000" }],
]) {
  const { error } = await anon.rpc(fn, args);
  report(`execute ${fn}()`, !!error, `The anon key can call ${fn}() directly.`);
}

// ---- verdict ---------------------------------------------------------
console.log("");
if (failures === 0) {
  console.log("✓ All probes blocked. The public key cannot reach the database.\n");
  process.exit(0);
} else {
  console.log(
    `✗ ${failures} probe(s) got through. Re-run supabase/migrations/0002_rls.sql\n` +
      `  and drop any policy the dashboard added.\n`
  );
  process.exit(1);
}
