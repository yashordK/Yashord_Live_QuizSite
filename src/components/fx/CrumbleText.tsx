"use client";

import { Fragment, useEffect, useMemo, useState, type CSSProperties } from "react";
import { parseQuestionText, QuestionBody } from "@/components/QuestionBody";
import { seeded, type OnceMode } from "./core";

/**
 * A wrong answer brings the question down.
 *
 *   crack  (0 – 0.56s)  the sentence turns to masonry: letter-chunks become
 *                       bricks with mortar lines, a glowing crack draws
 *                       itself from a seeded epicentre, the wall shakes
 *   fall   (to 2.9s)    bricks tumble off-screen under gravity, nearest
 *                       the crack first, each with its own spin and drift
 *   ghost               the question fades back, dimmed, so the solution
 *                       that follows still has its context
 *
 * Bricks are 2–4 character chunks rather than single letters: it reads as
 * a wall breaking up instead of confetti, and it's roughly a third of the
 * animated elements on a low-end phone.
 */

type Stage = "whole" | "crack" | "fall" | "ghost";

interface Brick {
  text: string;
  code: boolean;
  vars: Record<string, string>;
}

type Token = { space: true } | { space: false; bricks: Brick[] };

type Block =
  | { kind: "code"; brick: Brick }
  | { kind: "text"; lines: Token[][] };

export function CrumbleText({
  id,
  text,
  mode,
  className = "",
  style,
  codeStyle,
}: {
  id: string;
  text: string;
  mode: OnceMode;
  className?: string;
  style?: CSSProperties;
  codeStyle?: CSSProperties;
}) {
  const [stage, setStage] = useState<Stage>("whole");

  useEffect(() => {
    if (mode === "pending") return;
    if (mode === "static") {
      setStage("ghost");
      return;
    }
    setStage("crack");
    const toFall = window.setTimeout(() => setStage("fall"), 560);
    const toGhost = window.setTimeout(() => setStage("ghost"), 2900);
    return () => {
      clearTimeout(toFall);
      clearTimeout(toGhost);
    };
  }, [mode]);

  const plan = useMemo(() => {
    const r = seeded(`crumble:${id}:${text}`);
    const all: Brick[] = [];
    const make = (piece: string, code = false): Brick => {
      const b: Brick = { text: piece, code, vars: {} };
      all.push(b);
      return b;
    };

    const blocks: Block[] = parseQuestionText(text).map((s): Block => {
      if (s.kind === "code") return { kind: "code", brick: make(s.content, true) };
      return {
        kind: "text",
        lines: s.content.split("\n").map((line) =>
          line
            .split(/(\s+)/)
            .filter((t) => t !== "")
            .map((t): Token => {
              if (/^\s+$/.test(t)) return { space: true };
              const bricks: Brick[] = [];
              for (let k = 0; k < t.length; ) {
                const size = 2 + Math.floor(r() * 3);
                bricks.push(make(t.slice(k, k + size)));
                k += size;
              }
              return { space: false, bricks };
            })
        ),
      };
    });

    const epicentre = Math.floor(r() * Math.max(1, all.length));
    all.forEach((b, i) => {
      const dist = Math.abs(i - epicentre);
      b.vars["--bdl"] = `${Math.round(Math.min(900, dist * 26 + r() * 110))}ms`;
      b.vars["--bx"] = `${((r() - 0.5) * (140 + dist * 6)).toFixed(0)}px`;
      b.vars["--br"] = `${((r() - 0.5) * 260).toFixed(0)}deg`;
      b.vars["--bdur"] = `${Math.round(1300 + r() * 700)}ms`;
    });

    // A jagged crack running out both ways from the epicentre.
    const ex = all.length ? (epicentre / all.length) * 100 : 50;
    const branch = (dir: 1 | -1) => {
      const pts: string[] = [];
      let x = ex;
      let y = 50;
      while (x > -2 && x < 102) {
        x += dir * (5 + r() * 7);
        y = Math.max(6, Math.min(94, y + (r() - 0.5) * 38));
        pts.push(`L${x.toFixed(1)} ${y.toFixed(1)}`);
      }
      return pts.join(" ");
    };
    const crack = `M${ex.toFixed(1)} 50 ${branch(1)} M${ex.toFixed(1)} 50 ${branch(-1)}`;

    return { blocks, crack };
  }, [id, text]);

  if (stage === "whole") {
    return <QuestionBody text={text} className={className} style={style} codeStyle={codeStyle} />;
  }

  if (stage === "ghost") {
    return (
      <div className="crumble-ghost">
        <QuestionBody text={text} className={className} style={style} codeStyle={codeStyle} />
      </div>
    );
  }

  return (
    <div
      className={`brick-wall ${stage === "crack" ? "is-cracking" : "is-falling"} ${className}`}
      style={style}
      aria-label={text}
    >
      {plan.blocks.map((block, bi) =>
        block.kind === "code" ? (
          <pre
            key={bi}
            className="code-block brick brick-block"
            style={{ ...codeStyle, ...(block.brick.vars as CSSProperties) }}
          >
            <code>{block.brick.text}</code>
          </pre>
        ) : (
          <p key={bi}>
            {block.lines.map((line, li) => (
              <Fragment key={li}>
                {li > 0 && <br />}
                {line.map((token, ti) =>
                  token.space ? (
                    <Fragment key={ti}> </Fragment>
                  ) : (
                    <span key={ti} className="whitespace-nowrap">
                      {token.bricks.map((b, k) => (
                        <span key={k} className="brick" style={b.vars as CSSProperties}>
                          {b.text}
                        </span>
                      ))}
                    </span>
                  )
                )}
              </Fragment>
            ))}
          </p>
        )
      )}

      <svg className="crack" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <path d={plan.crack} pathLength={1} vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}
