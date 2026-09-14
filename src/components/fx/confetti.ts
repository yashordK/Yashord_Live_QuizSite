"use client";

import { prefersReducedMotion } from "./core";

/**
 * One shared full-screen canvas for every burst, cannon and rain in the
 * app: a single rAF loop regardless of how many effects overlap, which
 * stops itself the moment the last particle is gone.
 *
 * Motion is delta-time based, so a 120Hz phone doesn't play confetti at
 * double speed. Particle counts scale down on low-core and small screens —
 * budget Android phones in a lecture hall are the target hardware.
 */

export const PALETTE = ["#a855f7", "#ec4899", "#22c55e", "#fbbf24", "#f5f3ff", "#60a5fa"];
export const GOLD = ["#fde68a", "#fbbf24", "#f59e0b", "#fef3c7", "#ec4899", "#a855f7"];

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  w: number;
  h: number;
  rot: number;
  vr: number;
  wob: number;
  vw: number;
  color: string;
  /** 0 paper, 1 disc, 2 streamer */
  shape: 0 | 1 | 2;
  g: number;
  drag: number;
  life: number;
  max: number;
}

export interface BurstOptions {
  x: number;
  y: number;
  count?: number;
  /** Degrees. -90 is straight up. */
  angle?: number;
  spread?: number;
  power?: number;
  gravity?: number;
  colors?: string[];
  scalar?: number;
}

const MAX_PARTICLES = 900;

let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let W = 0;
let H = 0;
let parts: Particle[] = [];
let raf = 0;
let last = 0;
let rainUntil = 0;
let rainColors: string[] = GOLD;
let rainCarry = 0;

function resize() {
  if (!canvas || !ctx) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function ensure(): boolean {
  if (typeof document === "undefined") return false;
  if (canvas && ctx && document.body.contains(canvas)) return true;

  canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  Object.assign(canvas.style, {
    position: "fixed",
    inset: "0",
    width: "100vw",
    height: "100vh",
    pointerEvents: "none",
    zIndex: "80",
  });
  document.body.appendChild(canvas);
  ctx = canvas.getContext("2d");
  if (!ctx) return false;
  resize();
  window.addEventListener("resize", resize);
  return true;
}

function budget(n: number): number {
  const cores =
    typeof navigator !== "undefined" ? navigator.hardwareConcurrency ?? 8 : 8;
  let f = 1;
  if (cores <= 4) f *= 0.6;
  if (W < 640) f *= 0.75;
  return Math.max(8, Math.round(n * f));
}

function spawn(o: BurstOptions, count: number) {
  const colors = o.colors ?? PALETTE;
  const scalar = o.scalar ?? 1;
  for (let i = 0; i < count; i++) {
    const a = ((o.angle ?? -90) + (Math.random() - 0.5) * (o.spread ?? 70)) * (Math.PI / 180);
    const speed = (o.power ?? 13) * (0.45 + Math.random() * 0.75);
    const roll = Math.random();
    parts.push({
      x: o.x,
      y: o.y,
      vx: Math.cos(a) * speed,
      vy: Math.sin(a) * speed,
      w: (7 + Math.random() * 6) * scalar,
      h: (4 + Math.random() * 5) * scalar,
      rot: Math.random() * Math.PI * 2,
      vr: (Math.random() - 0.5) * 0.3,
      wob: Math.random() * Math.PI * 2,
      vw: 0.07 + Math.random() * 0.12,
      color: colors[(Math.random() * colors.length) | 0],
      shape: roll < 0.16 ? 1 : roll < 0.3 ? 2 : 0,
      g: o.gravity ?? 0.3,
      drag: 0.982 + Math.random() * 0.01,
      life: 0,
      max: 160 + Math.random() * 120,
    });
  }
  if (parts.length > MAX_PARTICLES) parts.splice(0, parts.length - MAX_PARTICLES);
}

function frame(now: number) {
  if (!ctx) {
    raf = 0;
    return;
  }
  const dt = last ? Math.min(3, (now - last) / 16.667) : 1;
  last = now;
  ctx.clearRect(0, 0, W, H);

  if (now < rainUntil && parts.length < MAX_PARTICLES) {
    rainCarry += 1.1 * dt * Math.max(0.5, W / 900);
    while (rainCarry >= 1) {
      rainCarry -= 1;
      parts.push({
        x: Math.random() * W,
        y: -12,
        vx: (Math.random() - 0.5) * 1.5,
        vy: 2 + Math.random() * 2.5,
        w: 6 + Math.random() * 6,
        h: 4 + Math.random() * 4,
        rot: Math.random() * Math.PI * 2,
        vr: (Math.random() - 0.5) * 0.2,
        wob: Math.random() * Math.PI * 2,
        vw: 0.06 + Math.random() * 0.08,
        color: rainColors[(Math.random() * rainColors.length) | 0],
        shape: Math.random() < 0.2 ? 1 : 0,
        g: 0.05,
        drag: 0.995,
        life: 0,
        max: 600,
      });
    }
  }

  const alive: Particle[] = [];
  for (const p of parts) {
    p.life += dt;
    p.vx *= Math.pow(p.drag, dt);
    p.vy = p.vy * Math.pow(p.drag, dt) + p.g * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.rot += p.vr * dt;
    p.wob += p.vw * dt;

    if (p.y > H + 30 || p.life > p.max || p.x < -80 || p.x > W + 80) continue;
    alive.push(p);

    ctx.globalAlpha = p.life > p.max - 30 ? Math.max(0, (p.max - p.life) / 30) : 1;
    ctx.fillStyle = p.color;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    if (p.shape === 1) {
      ctx.beginPath();
      ctx.arc(0, 0, p.h * 0.55, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // Flutter: squash one axis, like paper turning over as it falls.
      ctx.scale(1, Math.cos(p.wob));
      if (p.shape === 2) ctx.fillRect(-p.w * 0.18, -p.h * 1.2, p.w * 0.36, p.h * 2.4);
      else ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
    }
    ctx.restore();
  }
  ctx.globalAlpha = 1;
  parts = alive;

  if (parts.length || now < rainUntil) {
    raf = requestAnimationFrame(frame);
  } else {
    raf = 0;
    last = 0;
    ctx.clearRect(0, 0, W, H);
  }
}

function run() {
  if (raf) return;
  last = 0;
  raf = requestAnimationFrame(frame);
}

export function burst(o: BurstOptions) {
  if (prefersReducedMotion() || !ensure()) return;
  spawn(o, budget(o.count ?? 90));
  run();
}

/** Twin cannons from the bottom corners, aimed to cross mid-screen. */
export function cannons(scale = 1, colors: string[] = GOLD) {
  if (prefersReducedMotion() || !ensure()) return;
  const power = Math.sqrt(0.6 * H) * 1.25;
  const count = Math.round(110 * scale);
  burst({ x: -10, y: H + 10, angle: -60, spread: 30, power, count, colors });
  burst({ x: W + 10, y: H + 10, angle: -120, spread: 30, power, count, colors });
}

export function rain(ms: number, colors: string[] = GOLD) {
  if (prefersReducedMotion() || !ensure()) return;
  rainColors = colors;
  rainUntil = performance.now() + ms;
  run();
}

export function stopRain() {
  rainUntil = 0;
}
