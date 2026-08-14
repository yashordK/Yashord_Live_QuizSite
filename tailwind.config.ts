import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Near-black with a violet cast, purple primary, pink secondary.
        // Contrast is checked against the darkest surface (`ink`) because
        // a washed-out projector and a phone at arm's length in a bright
        // lecture hall are both unforgiving.
        ink: "#07050c",
        panel: "#120e1d",
        panelHi: "#181227",
        edge: "#2c2145",
        edgeHi: "#3d2e60",

        accent: "#a855f7", // purple — primary actions, timers, selection
        accent2: "#ec4899", // pink — gradient partner, accents only
        glow: "#7c3aed",

        // Correct stays unmistakably green: on a reveal, hue is doing the
        // work, and a purple/pink "correct" would read as just another
        // brand colour rather than a verdict.
        good: "#22c55e",
        bad: "#fb3b6c",
        warn: "#fbbf24",
      },
      fontFamily: {
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Consolas",
          "Liberation Mono",
          "monospace",
        ],
      },
      fontSize: {
        // /present needs type readable from the back of a large room.
        present: ["4.5rem", { lineHeight: "1.1", letterSpacing: "-0.02em" }],
        presentsm: ["2.75rem", { lineHeight: "1.15" }],
      },
    },
  },
  plugins: [],
};

export default config;
