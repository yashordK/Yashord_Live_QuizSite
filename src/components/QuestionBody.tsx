"use client";

/**
 * Renders question text that may contain fenced code blocks.
 *
 * Roughly a quarter of this quiz is "what does this print", and a C
 * snippet mashed into a proportional font with its newlines collapsed is
 * genuinely hard to read — especially from the back of a lecture hall.
 * So question_text may contain ``` fences, which is also exactly how the
 * questions were written in the first place:
 *
 *     What will be the output?
 *     ```
 *     int a = 5, b = 2;
 *     printf("%d", a + b * 3);
 *     ```
 *
 * Prose segments keep their newlines (whitespace-pre-line); code segments
 * get a monospace block. No parser beyond splitting on the fence — the
 * content is ours, not user input.
 */

interface Segment {
  kind: "text" | "code";
  content: string;
}

export function parseQuestionText(raw: string): Segment[] {
  if (!raw.includes("```")) {
    return [{ kind: "text", content: raw }];
  }

  const parts = raw.split(/```[a-zA-Z]*\n?/);
  const segments: Segment[] = [];

  parts.forEach((part, i) => {
    // Odd indices sit between fences, so they're the code blocks.
    const kind: Segment["kind"] = i % 2 === 1 ? "code" : "text";
    const content = kind === "code" ? part.replace(/\n$/, "") : part.trim();
    if (content !== "") segments.push({ kind, content });
  });

  return segments;
}

export function QuestionBody({
  text,
  className = "",
  style,
  codeStyle,
}: {
  text: string;
  className?: string;
  style?: React.CSSProperties;
  /** Projector needs a viewport-relative size; phone uses the default. */
  codeStyle?: React.CSSProperties;
}) {
  const segments = parseQuestionText(text);

  return (
    <div className={className} style={style}>
      {segments.map((seg, i) =>
        seg.kind === "code" ? (
          <pre key={i} className="code-block" style={codeStyle}>
            <code>{seg.content}</code>
          </pre>
        ) : (
          <p key={i} className="whitespace-pre-line">
            {seg.content}
          </p>
        )
      )}
    </div>
  );
}
