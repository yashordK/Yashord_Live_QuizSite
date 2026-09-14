"use client";

import { useId } from "react";

/**
 * Bolt — the quiz's robot engineer. His mood is the result.
 *
 * Inline SVG animated with CSS (see globals.css, `.bolt-*`), so there are
 * no image assets to load on 200 phones and he stays crisp at any size.
 */

export type BoltMood = "happy" | "sad" | "missed" | "idle";

const ARM = "#7c3aed";
const HAND = "#c084fc";

export function Bolt({
  mood,
  size = 110,
  className = "",
}: {
  mood: BoltMood;
  size?: number;
  className?: string;
}) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const body = `bolt-body-${uid}`;
  const screen = `bolt-screen-${uid}`;

  return (
    <svg
      className={`bolt bolt-${mood} ${className}`}
      viewBox="-12 -50 184 226"
      width={size}
      height={Math.round((size * 226) / 184)}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={body} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#c084fc" />
          <stop offset="1" stopColor="#6d28d9" />
        </linearGradient>
        <linearGradient id={screen} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1e1036" />
          <stop offset="1" stopColor="#0a0614" />
        </linearGradient>
      </defs>

      {mood === "happy" &&
        [
          [4, 4, "#f472b6"],
          [156, 14, "#fbbf24"],
          [-2, 100, "#fbbf24"],
          [162, 94, "#f472b6"],
          [80, -40, "#86efac"],
        ].map(([x, y, fill], i) => (
          <g key={i} transform={`translate(${x} ${y})`}>
            <path
              className="spark"
              d="M0 -9 L2.2 -2.2 L9 0 L2.2 2.2 L0 9 L-2.2 2.2 L-9 0 L-2.2 -2.2 Z"
              fill={fill as string}
              style={{ animationDelay: `${i * 0.19}s` }}
            />
          </g>
        ))}

      {mood === "sad" && (
        <g className="cloud">
          <circle cx="64" cy="-28" r="12" fill="#64748b" />
          <circle cx="84" cy="-34" r="15" fill="#64748b" />
          <circle cx="104" cy="-26" r="11" fill="#64748b" />
          <rect x="54" y="-28" width="62" height="16" rx="8" fill="#64748b" />
          {[62, 76, 90, 104].map((x, i) => (
            <line
              key={x}
              className="drop"
              x1={x}
              y1="-8"
              x2={x - 2}
              y2="-1"
              stroke="#93c5fd"
              strokeWidth="3"
              strokeLinecap="round"
              style={{ animationDelay: `${i * 0.22}s` }}
            />
          ))}
        </g>
      )}

      <g className="rig">
        {/* antenna */}
        <line x1="80" y1="30" x2="80" y2="15" stroke="#c4b5fd" strokeWidth="4" strokeLinecap="round" />
        <circle
          className="bulb"
          cx="80"
          cy="11"
          r="6"
          fill={mood === "happy" ? "#22c55e" : mood === "sad" ? "#60a5fa" : "#ec4899"}
        />

        {/* ears */}
        <rect x="16" y="54" width="14" height="28" rx="6" fill="#5b21b6" />
        <rect x="130" y="54" width="14" height="28" rx="6" fill="#5b21b6" />

        {/* head + screen */}
        <rect x="26" y="28" width="108" height="82" rx="24" fill={`url(#${body})`} />
        <rect x="38" y="40" width="84" height="58" rx="15" fill={`url(#${screen})`} />

        {mood === "happy" && (
          <g fill="none" stroke="#86efac" strokeWidth="5" strokeLinecap="round">
            <path d="M50 72 Q59 60 68 72" />
            <path d="M92 72 Q101 60 110 72" />
            <path d="M62 81 Q80 96 98 81" />
            <circle cx="47" cy="84" r="4" fill="#f472b6" stroke="none" opacity="0.7" />
            <circle cx="113" cy="84" r="4" fill="#f472b6" stroke="none" opacity="0.7" />
          </g>
        )}

        {mood === "sad" && (
          <>
            <g fill="none" stroke="#93c5fd" strokeLinecap="round">
              <path d="M48 55 L66 60" strokeWidth="3" />
              <path d="M112 55 L94 60" strokeWidth="3" />
              <path d="M50 66 Q59 74 68 66" strokeWidth="5" />
              <path d="M92 66 Q101 74 110 66" strokeWidth="5" />
              <path d="M64 91 Q80 79 96 91" strokeWidth="5" />
            </g>
            <path className="tear" d="M59 76 q-4 7 0 10 q4 -3 0 -10 z" fill="#60a5fa" />
            <path
              className="tear"
              d="M101 76 q-4 7 0 10 q4 -3 0 -10 z"
              fill="#60a5fa"
              style={{ animationDelay: "0.75s" }}
            />
          </>
        )}

        {mood === "missed" && (
          <>
            <g fill="none" stroke="#fde68a" strokeLinecap="round" strokeWidth="4">
              <circle cx="59" cy="66" r="6" />
              <circle cx="101" cy="66" r="6" />
              <path d="M64 87 Q70 82 76 87 T88 87 T100 87" />
            </g>
            <path className="sweat" d="M124 36 q-5 8 0 12 q5 -4 0 -12 z" fill="#93c5fd" />
            <text className="qmark" x="138" y="22" fontSize="30" fontWeight="800" fill="#fbbf24">
              ?
            </text>
          </>
        )}

        {mood === "idle" && (
          <g className="eyes">
            <rect x="52" y="58" width="14" height="18" rx="5" fill="#a5b4fc" />
            <rect x="94" y="58" width="14" height="18" rx="5" fill="#a5b4fc" />
            <path d="M68 86 Q80 92 92 86" fill="none" stroke="#a5b4fc" strokeWidth="4" strokeLinecap="round" />
          </g>
        )}

        {/* torso + power core */}
        <rect x="52" y="112" width="56" height="40" rx="13" fill={`url(#${body})`} />
        <circle className="core" cx="80" cy="132" r="7" fill="#fbbf24" />

        {/* arms */}
        {mood === "happy" ? (
          <>
            <g className="arm arm-l">
              <line x1="52" y1="120" x2="26" y2="92" stroke={ARM} strokeWidth="9" strokeLinecap="round" />
              <circle cx="24" cy="89" r="8" fill={HAND} />
            </g>
            <g className="arm arm-r">
              <line x1="108" y1="120" x2="134" y2="92" stroke={ARM} strokeWidth="9" strokeLinecap="round" />
              <circle cx="136" cy="89" r="8" fill={HAND} />
            </g>
          </>
        ) : mood === "missed" ? (
          <>
            <g className="arm arm-l">
              <line x1="52" y1="122" x2="40" y2="150" stroke={ARM} strokeWidth="9" strokeLinecap="round" />
              <circle cx="38" cy="153" r="8" fill={HAND} />
            </g>
            <g className="arm arm-r">
              <line x1="108" y1="120" x2="128" y2="82" stroke={ARM} strokeWidth="9" strokeLinecap="round" />
              <circle cx="129" cy="77" r="8" fill={HAND} />
            </g>
          </>
        ) : (
          <>
            <g className="arm arm-l">
              <line
                x1="52"
                y1="122"
                x2={mood === "sad" ? 40 : 36}
                y2={mood === "sad" ? 150 : 140}
                stroke={ARM}
                strokeWidth="9"
                strokeLinecap="round"
              />
              <circle cx={mood === "sad" ? 38 : 34} cy={mood === "sad" ? 153 : 143} r="8" fill={HAND} />
            </g>
            <g className="arm arm-r">
              <line
                x1="108"
                y1="122"
                x2={mood === "sad" ? 120 : 124}
                y2={mood === "sad" ? 150 : 140}
                stroke={ARM}
                strokeWidth="9"
                strokeLinecap="round"
              />
              <circle cx={mood === "sad" ? 122 : 126} cy={mood === "sad" ? 153 : 143} r="8" fill={HAND} />
            </g>
          </>
        )}

        {/* legs */}
        <rect x="59" y="150" width="14" height="17" rx="5" fill="#5b21b6" />
        <rect x="87" y="150" width="14" height="17" rx="5" fill="#5b21b6" />
      </g>
    </svg>
  );
}
