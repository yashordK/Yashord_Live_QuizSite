#!/usr/bin/env node
/**
 * Repair UTF-8 text that was round-tripped through Windows CP1252 — the
 * classic corruption where an em-dash becomes three garbage characters —
 * and strip any BOM.
 *
 * Why this exists: PowerShell 5.1's `Set-Content -Encoding utf8` writes a
 * BOM, and its `Get-Content` decodes as the ANSI codepage. Editing a
 * UTF-8 file that way mangles every non-ASCII character in it.
 *
 * The repair is NOT a Latin-1 round-trip. Bytes 0x80-0x9F differ between
 * Latin-1 and CP1252, and those are exactly the bytes involved: the
 * em-dash's UTF-8 tail byte 0x94 decodes to U+201D under CP1252, which
 * has no Latin-1 representation at all. So we need the real CP1252
 * reverse map, below.
 *
 * Every pattern here is written as a \u escape on purpose — a literal
 * mojibake sequence in this file would itself be mangled by the next
 * tool that touches it, which is the very bug being fixed.
 */

import fs from "node:fs";
import process from "node:process";

const BOM = "﻿";

/** CP1252 0x80-0x9F -> Unicode. Everything else matches Latin-1. */
const CP1252_HIGH = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e,
  0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6,
  0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152,
  0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c,
  0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a,
  0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
};

/** Unicode -> CP1252 byte, for the 0x80-0x9F range. */
const TO_BYTE = new Map(
  Object.entries(CP1252_HIGH).map(([byte, cp]) => [cp, Number(byte)])
);

/** Lead bytes of virtually all CP1252-mangled UTF-8: U+00C2 and U+00E2. */
const MOJIBAKE = /[Âãâ][-¿€–—‘’‚“”„†‡•…‰‹›ˆ˜™ŒœŠšŽžŸƒ]/;

/** Re-encode a CP1252-mis-decoded string back to its original bytes. */
function toCp1252Bytes(text) {
  const out = Buffer.alloc(text.length);
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i);
    if (cp <= 0xff) {
      out[i] = cp;
    } else if (TO_BYTE.has(cp)) {
      out[i] = TO_BYTE.get(cp);
    } else {
      return null; // Not a pure CP1252 mis-decode; leave the file alone.
    }
  }
  return out;
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("Usage: node scripts/fix-encoding.mjs <file> [file...]");
  process.exit(1);
}

let changed = 0;

for (const file of files) {
  if (!fs.existsSync(file)) {
    console.log(`skip (missing): ${file}`);
    continue;
  }

  const original = fs.readFileSync(file, "utf8");
  let text = original;

  if (text.startsWith(BOM)) text = text.slice(BOM.length);

  if (MOJIBAKE.test(text)) {
    const bytes = toCp1252Bytes(text);
    if (bytes) {
      const repaired = bytes.toString("utf8");
      // Reject the repair if it produced replacement characters — that
      // would mean the file wasn't mojibake and we'd be destroying it.
      if (!repaired.includes("�")) text = repaired;
    }
  }

  if (text !== original) {
    fs.writeFileSync(file, text, "utf8");
    console.log(`fixed:  ${file}`);
    changed++;
  } else {
    console.log(`clean:  ${file}`);
  }
}

console.log(`\n${changed} file(s) repaired.`);
