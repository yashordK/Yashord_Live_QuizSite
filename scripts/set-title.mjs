#!/usr/bin/env node
/**
 * Set the session title shown on every screen.
 *
 *   node scripts/set-title.mjs "The Yashord Quiz"
 *
 * The title lives on the `sessions` row, not in code, so changing it does
 * not need a redeploy — every client picks it up on its next poll.
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

const title = process.argv[2] ?? process.env.SESSION_TITLE;
if (!title) {
  console.error('Usage: node scripts/set-title.mjs "Your Quiz Title"');
  process.exit(1);
}

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const { data, error } = await db
  .from("sessions")
  .update({ title })
  .eq("code", (process.env.SESSION_CODE ?? "QUIZ01").toUpperCase())
  .select("code, title, phase, join_cap")
  .single();

if (error) {
  console.error("Failed:", error.message);
  process.exit(1);
}

console.log("✓ Session updated:", JSON.stringify(data));
