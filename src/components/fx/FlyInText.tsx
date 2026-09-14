"use client";

import { Fragment, useMemo, type CSSProperties } from "react";
import { parseQuestionText } from "@/components/QuestionBody";
import { seeded, useOnce } from "./core";

/**
 * Question text that assembles itself: every word flies in from a seeded
 * off-screen vector — some rushing in from "near the camera", some from
 * far away — overshoots, and snaps into its place in the sentence.
 *
 * Words, not letters: a 20-word question is 20 transforms rather than 110,
 * which matters on a budget phone, and the sentence reads as it lands.
 * Code blocks fly in as a single unit so their layout never breaks.
 *
 * Plays once per question (see useOnce); every later render — the next
 * phase, a poll, a refresh — renders the settled text.
 */

type Variant = "phone" | "stage";

interface Piece {
  space: boolean;
  text: string;
  vars?: CSSProperties;
}

type Paragraph =
  | { kind: "code"; content: string; vars: CSSProperties }
  | { kind: "text"; lines: Piece[][] };

export function FlyInText({
  id,
  text,
  variant = "phone",
  animate = true,
  className = "",
  style,
  codeStyle,
}: {
  id: string;
  text: string;
  variant?: Variant;
  animate?: boolean;
  className?: string;
  style?: CSSProperties;
  codeStyle?: CSSProperties;
}) {
  const once = useOnce(animate ? `fly:${variant}:${id}` : null);
  const mode = animate ? once : "static";

  const paragraphs = useMemo<Paragraph[]>(() => {
    const r = seeded(`fly:${id}:${text}`);
    const segments = parseQuestionText(text);

    let flying = 0;
    for (const s of segments) {
      flying += s.kind === "code" ? 1 : s.content.split(/\s+/).filter(Boolean).length;
    }
    // Cap the total cascade at ~1.2s so long questions don't drag.
    const step = Math.min(variant === "stage" ? 55 : 42, 1150 / Math.max(1, flying));
    let index = 0;

    const vector = (): CSSProperties => {
      const angle = r() * Math.PI * 2;
      const reach = variant === "stage" ? 1 : 0.85;
      const nearCamera = r() < 0.5;
      return {
        "--fx": `${(Math.cos(angle) * (55 + r() * 45) * reach).toFixed(1)}vw`,
        "--fy": `${(Math.sin(angle) * (55 + r() * 55) * reach).toFixed(1)}vh`,
        "--fr": `${((r() - 0.5) * 170).toFixed(0)}deg`,
        "--fs": (nearCamera ? 1.9 + r() * 1.3 : 0.2 + r() * 0.35).toFixed(2),
        "--fdl": `${Math.round(index++ * step + r() * 70)}ms`,
        "--fdur": `${variant === "stage" ? 980 : 820}ms`,
      } as CSSProperties;
    };

    return segments.map((s): Paragraph => {
      if (s.kind === "code") return { kind: "code", content: s.content, vars: vector() };
      return {
        kind: "text",
        lines: s.content.split("\n").map((line) =>
          line
            .split(/(\s+)/)
            .filter((t) => t !== "")
            .map((t): Piece =>
              /^\s+$/.test(t) ? { space: true, text: " " } : { space: false, text: t, vars: vector() }
            )
        ),
      };
    });
  }, [id, text, variant]);

  const wordClass =
    mode === "animate"
      ? `fly-word${variant === "stage" ? " fly-word--stage" : ""}`
      : mode === "pending"
        ? "fx-wait"
        : undefined;

  return (
    <div className={className} style={style}>
      {paragraphs.map((p, pi) =>
        p.kind === "code" ? (
          <pre
            key={pi}
            className={`code-block${mode === "animate" ? " fly-block" : mode === "pending" ? " fx-wait" : ""}`}
            style={{ ...codeStyle, ...(mode === "animate" ? p.vars : null) }}
          >
            <code>{p.content}</code>
          </pre>
        ) : (
          <p key={pi}>
            {p.lines.map((line, li) => (
              <Fragment key={li}>
                {li > 0 && <br />}
                {line.map((piece, ti) =>
                  piece.space ? (
                    <Fragment key={ti}> </Fragment>
                  ) : (
                    <span
                      key={ti}
                      className={wordClass}
                      style={mode === "animate" ? piece.vars : undefined}
                    >
                      {piece.text}
                    </span>
                  )
                )}
              </Fragment>
            ))}
          </p>
        )
      )}
    </div>
  );
}
