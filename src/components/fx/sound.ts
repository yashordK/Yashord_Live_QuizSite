"use client";

import { useEffect, useState } from "react";

/**
 * Sound effects.
 *
 * Browsers refuse to play audio until the person has interacted with the
 * page. So one AudioContext is started (and each sound fetched) on the
 * page's first tap, click or key press, and every later play goes through
 * that already-running context — which, once running, is allowed to play
 * without a fresh gesture on iOS and Android alike.
 *
 * On a student's phone the unlock is free: answering is a tap, so anyone
 * who can receive a result has already unlocked sound. The projector is
 * never tapped, which is why /present shows an "enable sound" button.
 *
 * Everything here fails silent. A blocked or failed sound must never
 * throw into, or delay, the quiz.
 */

export type SoundName = "correct" | "wrong" | "cheer";

const SRC: Record<SoundName, string> = {
  correct: "/sounds/correct.mp3",
  wrong: "/sounds/wrong.mp3",
  cheer: "/sounds/podium-cheer.mp3",
};

let ctx: AudioContext | null = null;
const buffers = new Map<SoundName, AudioBuffer>();
const pending = new Map<SoundName, Promise<AudioBuffer | null>>();

function context(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (ctx) return ctx;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  ctx = new Ctor();
  return ctx;
}

function load(name: SoundName): Promise<AudioBuffer | null> {
  const ready = buffers.get(name);
  if (ready) return Promise.resolve(ready);
  const inflight = pending.get(name);
  if (inflight) return inflight;

  const c = context();
  if (!c) return Promise.resolve(null);

  const request = fetch(SRC[name])
    .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))))
    // Callback form: the promise form isn't available on older Safari.
    .then((data) => new Promise<AudioBuffer>((resolve, reject) => c.decodeAudioData(data, resolve, reject)))
    .then((buffer) => {
      buffers.set(name, buffer);
      return buffer;
    })
    .catch(() => {
      pending.delete(name); // allow a retry on the next gesture
      return null;
    });

  pending.set(name, request);
  return request;
}

/** Call from inside a user gesture: starts audio and preloads `names`. */
export function unlockAudio(names: SoundName[]): void {
  // iPhones mute web audio while the ringer switch is on silent, and many
  // students keep it there. Declaring this page's audio as media playback
  // (Safari's Audio Session API) lets the bell and drums through anyway.
  try {
    const session = (navigator as unknown as { audioSession?: { type: string } }).audioSession;
    if (session) session.type = "playback";
  } catch {
    /* not supported: nothing to do */
  }

  const c = context();
  if (!c) return;
  if (c.state === "suspended") void c.resume().catch(() => {});

  // Older iOS only fully unlocks once something actually plays inside the
  // gesture, so play one silent sample.
  try {
    const src = c.createBufferSource();
    src.buffer = c.createBuffer(1, 1, 22050);
    src.connect(c.destination);
    src.start(0);
  } catch {
    /* ignore */
  }

  names.forEach((n) => void load(n));
}

export function audioReady(): boolean {
  return ctx?.state === "running";
}

/**
 * Play a sound. Resolves to a function that fades it out and stops it, or
 * null if nothing played (not unlocked, failed to load).
 */
export async function playSound(name: SoundName, volume = 1): Promise<(() => void) | null> {
  try {
    const c = ctx;
    if (!c) return null; // never unlocked on this page: stay silent
    if (c.state !== "running") await c.resume();
    if (c.state !== "running") return null;

    const buffer = await load(name);
    if (!buffer) return null;

    const src = c.createBufferSource();
    src.buffer = buffer;
    const gain = c.createGain();
    gain.gain.value = volume;
    src.connect(gain).connect(c.destination);
    src.start(0);

    return () => {
      try {
        gain.gain.setTargetAtTime(0, c.currentTime, 0.15);
        src.stop(c.currentTime + 0.6);
      } catch {
        /* already stopped */
      }
    };
  } catch {
    /* sound is decoration; never let it break the quiz */
    return null;
  }
}

/**
 * Unlock audio on the page's first tap, click or key press. Returns
 * whether sound is currently able to play.
 */
export function useAudioUnlock(names: SoundName[]): boolean {
  const [ready, setReady] = useState(false);
  const key = names.join(",");

  useEffect(() => {
    const list = key.split(",") as SoundName[];
    const onGesture = () => {
      unlockAudio(list);
      // resume() settles asynchronously.
      window.setTimeout(() => setReady(audioReady()), 200);
    };
    const opts: AddEventListenerOptions = { capture: true, passive: true };
    window.addEventListener("pointerdown", onGesture, opts);
    window.addEventListener("touchend", onGesture, opts);
    window.addEventListener("keydown", onGesture, opts);
    setReady(audioReady());

    return () => {
      window.removeEventListener("pointerdown", onGesture, opts);
      window.removeEventListener("touchend", onGesture, opts);
      window.removeEventListener("keydown", onGesture, opts);
    };
  }, [key]);

  return ready;
}
