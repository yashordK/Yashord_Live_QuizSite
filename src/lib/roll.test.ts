import { describe, it, expect } from "vitest";
import {
  normalizeRoll,
  normalizeAndValidateRoll,
  normalizeAndValidateName,
} from "./roll";

/**
 * The convergence tests below are the ones that matter most. If any of
 * them break, a student rejoining with differently-typed input creates a
 * second participant row and loses their score. Everything else in this
 * app is recoverable mid-session; that is not.
 */
describe("normalizeRoll — convergence (the score-loss bug)", () => {
  it("collapses the documented variants to one canonical roll", () => {
    const variants = [
      "22CS101",
      "22cs101",
      "22cs 101",
      "22CS-101",
      "22CS_101",
      "  22Cs101  ",
      "22 c s 1 0 1",
      "22cs\t101",
      "22CS–101", // en dash
      "22CS—101", // em dash
      "22CS‐101", // unicode hyphen U+2010
      "22CS 101", // non-breaking space
      "22CS​101", // zero-width space
    ];

    const canonical = variants.map((v) => normalizeRoll(v, 3));
    for (const c of canonical) expect(c).toBe("22CS101");
    expect(new Set(canonical).size).toBe(1);
  });

  it("converges short and zero-padded forms of the same roll", () => {
    // A student who types "22CS1" on join and "22CS001" on rejoin must
    // land on the same participant row.
    expect(normalizeRoll("22CS1", 3)).toBe("22CS101".slice(0, 4) + "001");
    expect(normalizeRoll("22CS1", 3)).toBe("22CS001");
    expect(normalizeRoll("22CS01", 3)).toBe("22CS001");
    expect(normalizeRoll("22cs-1", 3)).toBe("22CS001");
    expect(normalizeRoll("22CS001", 3)).toBe("22CS001");
  });

  it("is idempotent", () => {
    const inputs = ["22cs 101", "22CS-1", "  21it_07 ", "101", "22CS101"];
    for (const raw of inputs) {
      const once = normalizeRoll(raw, 3);
      expect(normalizeRoll(once, 3)).toBe(once);
    }
  });
});

describe("normalizeRoll — padding is pad-up-only", () => {
  it("pads the trailing digit run up to padLength", () => {
    expect(normalizeRoll("22CS7", 3)).toBe("22CS007");
    expect(normalizeRoll("22CS7", 4)).toBe("22CS0007");
  });

  it("never truncates a roll whose number is already long enough", () => {
    expect(normalizeRoll("22CS1234", 3)).toBe("22CS1234");
    expect(normalizeRoll("22CS101", 2)).toBe("22CS101");
  });

  it("anchors on the TRAILING digits, not digits in the prefix", () => {
    // "22CS101" must not become "022CS101" or similar — the leading "22"
    // is part of the batch prefix, not the roll number.
    expect(normalizeRoll("22CS101", 5)).toBe("22CS00101");
    expect(normalizeRoll("2022CS9", 3)).toBe("2022CS009");
  });

  it("leaves rolls with no trailing digit run alone", () => {
    expect(normalizeRoll("22CS101A", 3)).toBe("22CS101A");
    expect(normalizeRoll("ABC", 3)).toBe("ABC");
  });

  it("handles a purely numeric roll", () => {
    expect(normalizeRoll("7", 3)).toBe("007");
    expect(normalizeRoll("007", 3)).toBe("007");
    expect(normalizeRoll("1234", 3)).toBe("1234");
  });

  it("disables padding when padLength is 0", () => {
    expect(normalizeRoll("22CS1", 0)).toBe("22CS1");
    expect(normalizeRoll("22cs-1", 0)).toBe("22CS1");
  });
});

describe("normalizeRoll — distinct rolls stay distinct", () => {
  it("does not merge different students", () => {
    const rolls = ["22CS101", "22CS102", "21CS101", "22IT101", "22CS1011"];
    const canonical = rolls.map((r) => normalizeRoll(r, 3));
    expect(new Set(canonical).size).toBe(rolls.length);
  });

  it("keeps the three batches separate", () => {
    // Two batches share a prefix but not a number range; the third has a
    // different prefix. All must remain distinct identities.
    expect(normalizeRoll("22CS030", 3)).not.toBe(normalizeRoll("22CS090", 3));
    expect(normalizeRoll("22CS030", 3)).not.toBe(normalizeRoll("22IT030", 3));
  });
});

describe("normalizeAndValidateRoll", () => {
  it("accepts realistic rolls and returns the canonical form", () => {
    const r = normalizeAndValidateRoll("22cs 101");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.canonical).toBe("22CS101");
  });

  it("accepts a roll from a differently-prefixed batch (lenient by design)", () => {
    for (const raw of ["22IT045", "21ece7", "23-me-012"]) {
      const r = normalizeAndValidateRoll(raw);
      expect(r.ok, `expected ${raw} to be accepted`).toBe(true);
    }
  });

  it("rejects empty input with a friendly message", () => {
    for (const raw of ["", "   ", null, undefined, 42]) {
      const r = normalizeAndValidateRoll(raw as unknown);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toMatch(/roll number/i);
    }
  });

  it("rejects rolls containing stray symbols rather than silently stripping them", () => {
    const r = normalizeAndValidateRoll("22CS@101");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/letters and numbers/i);
  });

  it("rejects a roll with no digits", () => {
    const r = normalizeAndValidateRoll("ABCDEF");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/roll digits/i);
  });

  it("rejects absurdly long input", () => {
    const r = normalizeAndValidateRoll("22CS" + "1".repeat(50));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/too long/i);
  });

  it("never returns a message that looks like a generic error", () => {
    const r = normalizeAndValidateRoll("!!!");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).not.toMatch(/bad request|error|invalid input/i);
      expect(r.message.length).toBeGreaterThan(10);
    }
  });
});

describe("normalizeAndValidateName", () => {
  it("trims and collapses internal whitespace", () => {
    const r = normalizeAndValidateName("  Yash   Upadhyay ");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.name).toBe("Yash Upadhyay");
  });

  it("rejects empty and over-long names", () => {
    expect(normalizeAndValidateName("").ok).toBe(false);
    expect(normalizeAndValidateName("  ").ok).toBe(false);
    expect(normalizeAndValidateName("a".repeat(80)).ok).toBe(false);
  });

  it("accepts names with punctuation and non-latin scripts", () => {
    for (const n of ["R. K. Narayan", "O'Brien", "अनन्या", "José"]) {
      expect(normalizeAndValidateName(n).ok, n).toBe(true);
    }
  });
});
