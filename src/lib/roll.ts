/**
 * Roll number normalization and validation.
 *
 * THIS IS THE MOST SAFETY-CRITICAL MODULE IN THE APP.
 *
 * `participants` has UNIQUE (session_id, roll_number), and a student's
 * score is derived from the answer rows hanging off their participant id.
 * So the canonical roll IS the identity key. If normalization is skipped
 * or applied inconsistently, a student who rejoins typing "22cs101"
 * instead of "22CS-101" gets a brand new participant row and silently
 * loses their entire score, mid-quiz, in front of the class.
 *
 * Rules therefore:
 *   - normalizeRoll() is called server-side, ALWAYS, before validation
 *     and before the uniqueness lookup. Never trust a client to normalize.
 *   - It is idempotent: normalize(normalize(x)) === normalize(x).
 *   - Padding only ever pads UP; it never truncates a longer roll.
 *
 * Validation is deliberately LENIENT: three batches join this session and
 * they don't share a single prefix, so gating on prefix or numeric range
 * would lock real students out mid-lecture. We check shape only.
 */

import { rollConfig, NAME_MIN_LENGTH, NAME_MAX_LENGTH } from "./config";

/**
 * Characters removed during normalization.
 *
 * `\s` already covers the non-breaking ( ) and ideographic (　)
 * spaces that arrive via copy-paste; ​-‍ adds the zero-width
 * ones it misses. The second alternation covers every flavour of
 * hyphen/dash a phone keyboard or autocorrect might substitute for "-".
 *
 * Anything NOT in this set is left alone on purpose, so validation can
 * reject it loudly rather than us silently mangling one student's roll
 * into a different student's roll.
 */
const STRIP_RE = /[\s_​-‍﻿]|[-‐-―−]/g;

/** Trailing run of digits, with everything before it captured separately. */
const TRAILING_DIGITS_RE = /^(.*?)(\d+)$/;

export type RollResult =
  | { ok: true; canonical: string }
  | { ok: false; message: string };

/**
 * Canonicalize a roll number.
 *
 *   1. trim surrounding whitespace
 *   2. uppercase
 *   3. strip all whitespace, hyphens and underscores (internal too)
 *   4. zero-pad the trailing run of digits to `padLength`
 *
 * "22cs 101", "22CS-101", "22CS_101", " 22cs101 " and "22CS1" all
 * collapse to "22CS101" at padLength 3.
 */
export function normalizeRoll(
  input: string,
  padLength: number = rollConfig.padLength
): string {
  if (typeof input !== "string") return "";

  let s = input.trim().toUpperCase().replace(STRIP_RE, "");

  if (padLength > 0) {
    // Split off the TRAILING digit run. The leading part may itself
    // contain digits ("22CS" in "22CS101"), so anchoring on the tail is
    // what makes this correct.
    const m = s.match(TRAILING_DIGITS_RE);
    if (m) {
      const head = m[1];
      const tail = m[2];
      // Pad up only. A roll whose number is already >= padLength digits
      // passes through untouched, so longer formats are never corrupted.
      if (tail.length < padLength) {
        s = head + tail.padStart(padLength, "0");
      }
    }
  }

  return s;
}

/**
 * Normalize, then sanity-check the shape. Returns a friendly, specific
 * message on failure — a student staring at a rejected join screen in a
 * lecture hall needs to know what to fix, not see "Bad Request".
 */
export function normalizeAndValidateRoll(input: unknown): RollResult {
  if (typeof input !== "string" || input.trim() === "") {
    return { ok: false, message: "Please enter your roll number." };
  }

  const canonical = normalizeRoll(input);

  if (canonical.length === 0) {
    return { ok: false, message: "Please enter your roll number." };
  }

  if (!/^[A-Z0-9]+$/.test(canonical)) {
    return {
      ok: false,
      message:
        "Your roll number should only contain letters and numbers. Check for stray symbols and try again.",
    };
  }

  if (!/\d/.test(canonical)) {
    return {
      ok: false,
      message:
        "That doesn't look like a valid roll number — it needs to include your roll digits.",
    };
  }

  if (canonical.length < rollConfig.minLength) {
    return {
      ok: false,
      message:
        "That roll number looks too short. Please enter it in full (for example 22CS101).",
    };
  }

  if (canonical.length > rollConfig.maxLength) {
    return {
      ok: false,
      message: "That roll number looks too long. Please check it and try again.",
    };
  }

  return { ok: true, canonical };
}

export type NameResult =
  | { ok: true; name: string }
  | { ok: false; message: string };

/** Trim and collapse internal whitespace; reject empty or absurd names. */
export function normalizeAndValidateName(input: unknown): NameResult {
  if (typeof input !== "string") {
    return { ok: false, message: "Please enter your name." };
  }

  const name = input.trim().replace(/\s+/g, " ");

  if (name.length < NAME_MIN_LENGTH) {
    return { ok: false, message: "Please enter your name." };
  }
  if (name.length > NAME_MAX_LENGTH) {
    return {
      ok: false,
      message: `Please use a shorter name (up to ${NAME_MAX_LENGTH} characters).`,
    };
  }
  return { ok: true, name };
}
