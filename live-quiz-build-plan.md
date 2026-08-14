# Live Quiz Platform — Build Plan & Spec

**Target:** Single live session, ~200 students, host-controlled, zero cost.
**Stack:** Next.js (App Router, TypeScript, Tailwind) on Vercel + Supabase (Postgres + Realtime).

---

## 1. Core decisions (locked)

| Decision | Choice | Why |
|---|---|---|
| Frontend | Next.js 14+ App Router, TS, Tailwind | Free on Vercel, fast, easy deploy |
| DB | Supabase Postgres | SQL leaderboards are trivial |
| Sync | Supabase Realtime broadcast + 5s polling fallback | Snappy reveals, survives dropped sockets |
| Join cap | **185** (not 200) | Headroom for host, reconnects, duplicate tabs |
| Identity | Name + Roll Number (roll = primary key for rejoin) | Meets the resume requirement |
| Host auth | Env-var secret + server-side verified session cookie | Nobody can spoof host controls |
| Scoring | Correct = 100 + speed bonus up to 50 | Rewards speed without letting it dominate correctness |
| Negative marking | None | Encourages attempting every question |
| Roll validation | Prefix + numeric range pattern | No roster needed; blocks typos and outsiders |
| Leaderboard | Name + roll + total score | Clear identification, avoids name collisions |
| Leaderboard cadence | Every 5 questions + final, plus host override button | Keeps momentum without eating session time |
| Question count | ~20-25 | ≈20-30 min of quiz time |

**Non-negotiable:** the 185 cap and the polling fallback. Everything else is negotiable.

---

## 2. Question lifecycle (the state machine)

This is the heart of the app. One session row holds the current state; every client renders purely from it.

```
IDLE
 └─(host: Start / Next Question)→ QUESTION_ONLY      # text visible, options hidden
     └─(host: Show Options, or auto after reading timer)→ ACCEPTING_ANSWERS
         └─(host: Lock, or auto after answer timer)→ LOCKED   # no more submissions
             └─(host: Reveal Answer)→ REVEALED       # correct option highlighted
                 └─(host: Show Solution)→ SOLUTION   # explanation text visible
                     └─(host: Next Question)→ QUESTION_ONLY (next index)
                     └─(host: Show Leaderboard)→ LEADERBOARD
END  ← host ends session
```

**Key rule:** answers are accepted **only** in `ACCEPTING_ANSWERS`, enforced server-side, not just in the UI. A student with devtools open must not be able to answer during `REVEALED`.

**Timers:** run server-authoritative. Store `phase_started_at` (server timestamp) and `phase_duration_sec` on the session row. Clients compute remaining time as `duration - (now - phase_started_at)`. Never trust client clocks — otherwise a student with a skewed clock gets more time.

Host can always override a timer manually (skip ahead / extend). Auto-advance should be a toggle, defaulting to **off** for the reading phase so you control pacing while presenting.

---

## 3. Database schema

```sql
-- SESSION (single row per quiz event)
sessions
  id                uuid pk
  code              text unique          -- 6-char join code
  title             text
  status            text                 -- 'lobby' | 'live' | 'ended'
  current_question_id uuid null
  phase             text                 -- IDLE|QUESTION_ONLY|ACCEPTING_ANSWERS|LOCKED|REVEALED|SOLUTION|LEADERBOARD
  phase_started_at  timestamptz
  phase_duration_sec int null
  join_cap          int default 185
  joining_locked    bool default false   -- host can freeze new joins mid-quiz
  created_at        timestamptz

questions
  id                uuid pk
  session_id        uuid fk
  order_index       int
  question_text     text
  image_url         text null            -- optional, for diagram questions
  options           jsonb                -- [{key:'A', text:'...'}, ...]
  correct_option    text                 -- 'A'
  solution_text     text null            -- shown in SOLUTION phase
  reading_time_sec  int default 5
  answer_time_sec   int default 20
  points            int default 100

participants
  id                uuid pk
  session_id        uuid fk
  roll_number       text                 -- IDENTITY KEY
  name              text
  joined_at         timestamptz
  last_seen_at      timestamptz          -- heartbeat, for "who's online"
  is_online         bool
  device_token      text null            -- anti-impersonation, see §5
  UNIQUE (session_id, roll_number)       -- ← this makes rejoin work

answers
  id                uuid pk
  question_id       uuid fk
  participant_id    uuid fk
  selected_option   text
  is_correct        bool
  points_earned     int
  answered_at       timestamptz
  UNIQUE (question_id, participant_id)   -- ← prevents double-answering
```

**The two UNIQUE constraints are load-bearing.** `(session_id, roll_number)` is what makes rejoin work — logging back in finds the existing row instead of creating a duplicate. `(question_id, participant_id)` makes double-submission structurally impossible, even under a race condition from double-tapping.

**Score is never stored as a mutable column.** It's always `SELECT SUM(points_earned)` from `answers`. This means rejoining users automatically keep their score with zero extra logic — their answer rows never went anywhere.

---

## 4. Rejoin / resume behaviour (your specific requirement)

When someone enters name + roll number:

1. Look up `participants` by `(session_id, roll_number)`.
2. **If not found:** check join cap → create participant → issue session token → drop them into current phase.
3. **If found (rejoin):** do NOT create a new row. Reuse the existing participant id, mark `is_online = true`, issue a fresh token.
4. Client renders whatever the **current session phase** is — they land wherever the class currently is, not where they left.
5. Their score is intact automatically (it's derived from `answers`).
6. If they already answered the current question (row exists in `answers`), show them their locked-in choice rather than a fresh answerable question.

**Edge case to handle:** person rejoins *during* `ACCEPTING_ANSWERS` for a question they missed entirely. Decision: **let them answer** if the phase is still open — they get whatever time remains. They simply score 0 on questions that fully passed while they were gone. This is the fair and simple rule; document it so you can state it aloud if asked.

---

## 5. Anti-abuse (things Comet didn't mention, and you'll want)

Roll numbers are guessable — that's the whole risk of using them as identity.

- **Device binding:** on first join, generate a `device_token`, store in `localStorage` and on the participant row. On rejoin, if the token mismatches, still allow it (real rejoins happen) but **flag it in the host dashboard** as a possible duplicate login. Don't hard-block — you'll create a support queue mid-presentation.
- **Optional roster pre-load:** if you have the class list, seed `participants` (or a separate `allowed_rolls` table) beforehand and reject unknown roll numbers. This is the single strongest anti-abuse measure and costs you nothing. **Recommended if you have the list.**
- **Answer timing sanity:** reject submissions where the server-side elapsed time exceeds the phase duration.
- **Rate limit** the join endpoint (e.g. 5 attempts per IP per minute) so nobody scripts 200 fake joins and eats your cap.
- **`joining_locked` flag:** once your quiz is underway and everyone's in, flip it. Stops late randoms consuming connection slots.

---

## 6. Host authentication

Keep it simple but real:

- `HOST_PASSWORD` and `HOST_SESSION_SECRET` as Vercel env vars (never in client code).
- `POST /api/host/login` → compares password → sets **httpOnly, secure, sameSite** cookie containing a signed token.
- **Every** `/api/host/*` route verifies that cookie server-side before doing anything.
- The `/host` page must not render controls based on a client-side boolean — the API layer is the actual security boundary.

Do not use a hardcoded password in the frontend, and do not rely on "the URL is secret." 200 students will find and share the URL.

---

## 7. Pages / routes

**Student — `/` (join) and `/play`**
- Join form: Name + Roll Number, clear validation, "quiz is full" and "joining closed" states.
- Play screen renders by phase:
  - `QUESTION_ONLY`: big question text + reading countdown, no options.
  - `ACCEPTING_ANSWERS`: options as large tap targets + countdown. On tap: submit, lock UI, show confirmation.
  - `LOCKED`: "answers locked, waiting for host."
  - `REVEALED`: correct option highlighted green, their wrong pick red, points earned this question.
  - `SOLUTION`: explanation text.
  - `LEADERBOARD`: top 10 + "your rank: #N".
- Persistent header: their name, roll, current total score, connection status dot.

**Host — `/host/login`, `/host/control`**
- **Control panel (primary screen, the one you drive):**
  - Current question preview *with the correct answer visible to you*
  - Big phase buttons: `Show Question` / `Show Options` / `Lock Answers` / `Reveal Answer` / `Show Solution` / `Next Question`
  - Per-question timer inputs (reading sec, answer sec) editable live
  - Live counters: `X / 185 joined`, `Y answered this question`, and an answer distribution bar (how many picked A/B/C/D) — **very useful to discuss live before revealing**
  - Toggle: lock joining
  - Emergency: re-broadcast current state (fixes any stuck client instantly)
- **Participants tab:** full table — name, roll, online status, total score, per-question correctness. Sortable. CSV export.
- **Leaderboard tab:** overall + last-question breakdown.

**Projector — `/present` (the thing Comet missed entirely)**
You said you'll be presenting. You need a **separate, clean, huge-text view for the projector** that shows only the current question/options/reveal/leaderboard — no host controls, no answer key visible. Otherwise you'll be projecting your own control panel with the correct answers showing.

Run `/present` on the projector, `/host/control` on your laptop screen or phone. This is the single most important addition to your original list.

---

## 8. Realtime + fallback

- One shared channel: `session:{code}`. **Not one channel per student.**
- Host state change → write to `sessions` row → broadcast a small payload `{phase, question_id, phase_started_at, duration}`.
- **Every client also polls `GET /api/state` every 5s** as a safety net. If polled state ≠ local state, snap to polled state. This silently rescues anyone whose socket died.
- Heartbeat: client pings `POST /api/heartbeat` every 20-30s → updates `last_seen_at`, drives the online/offline indicator on your dashboard.
- Leaderboard is **pull, not push** — fetch it when phase becomes `REVEALED` or `LEADERBOARD`. Never subscribe 200 clients to live leaderboard updates; that's a message-count explosion for no benefit.

---

## 9. Failure modes & mitigations

| Risk | Mitigation |
|---|---|
| Supabase project auto-paused | Unpause 2 days before; make a real request daily leading up |
| Venue wifi collapses | Have questions in a PDF/slides as offline backup; quiz is a bonus, not the whole session |
| Connection cap hit | 185 cap + lock joining once started |
| A student's screen stuck | "Re-broadcast state" button + 5s polling fallback |
| Host laptop dies | Host login works from any device — log in on phone and continue |
| Wrong answer key entered | Preview panel shows correct answer before you reveal; also allow host to void a question (nulls its points for everyone) |
| Duplicate roll numbers | Flagged in dashboard; pre-loaded roster prevents entirely |
| Data lost after event | **Export CSV immediately after**, before anything pauses |

---

## 10. Pre-event checklist

**T-5 days:** Deploy to Vercel, Supabase project live, schema applied.
**T-3 days:** Full dry run with 5-10 friends on their own phones, on mobile data *and* wifi. Test rejoin explicitly — have someone force-close and come back.
**T-2 days:** **Load test with 200+ simulated clients** (k6 or a Node script opening realtime connections + firing answer submissions). Not 50. The whole point is to exceed your expected load. Confirm you see graceful "full" behaviour above the cap, not crashes.
**T-1 day:** Unpause/ping Supabase. Seed real questions. Verify answer keys twice. Print the join URL + code large for the projector.
**T-0, 30 min before:** Open `/host/control`, confirm state is `IDLE`, do a self-join test, then delete that test participant.

---

## 11. Build order

1. Schema + RLS policies in Supabase
2. Join flow + rejoin logic (test this hard — it's the trickiest requirement)
3. Session state machine + host control endpoints
4. Student play screen, all phases
5. Answer submission + server-side validation
6. Scoring + leaderboard queries
7. Host dashboard (participants, distribution, export)
8. `/present` projector view
9. Realtime wiring + polling fallback + heartbeat
10. Load test, fix, dry run

---

## 12. v0 vs Claude Code

**Use Claude Code.** Reasoning:

- This is a **multi-file stateful app** with a server-authoritative state machine, auth, RLS policies, race conditions on answer submission, and rejoin logic. v0 is optimised for generating good-looking React components from a prompt — it's excellent at UI, weak at cross-file backend correctness and DB policy.
- Claude Code can run migrations, execute your load test script, read errors, and iterate against the actual repo. That iteration loop is where this project's difficulty actually lives.
- The hard parts here (unique constraints preventing double-submit, server-side timer authority, host auth boundary) are exactly what a UI generator won't get right unprompted.

**Practical hybrid:** build everything in Claude Code. If you later want the student-facing screens to look sharper, generate a couple of components in v0 and paste them in as pure presentational components. Don't let v0 own state or data fetching.

---

## 13. Locked settings

### Scoring formula

```
if wrong or unanswered:  points_earned = 0        (no negative marking)
if correct:              points_earned = 100 + round(50 * time_remaining / answer_time_sec)
```

- Fast correct answer ≈ **150**, correct at the buzzer ≈ **100**, wrong = **0**.
- `time_remaining` is computed **server-side** from `phase_started_at`, never from a client-reported timestamp.
- Clamp the bonus to `[0, 50]` — a late-arriving request must never produce negative or inflated bonus.
- Correctness dominates speed by design: a slow correct answer still beats a fast wrong one by 100 points.

### Roll number validation (replaces the roster idea)

Rolls follow `PREFIX + sequential number`, so validate by **pattern and range**, no lookup table needed.

Env vars:
```
ROLL_PREFIX=[TO CONFIRM]        # e.g. 22CS
ROLL_MIN=[TO CONFIRM]           # e.g. 1
ROLL_MAX=[TO CONFIRM]           # e.g. 240
ROLL_PAD_LENGTH=[TO CONFIRM]    # e.g. 3 → 001, 002 ... or 0 if unpadded
```

**Normalization is mandatory and must happen server-side before validation AND before the uniqueness lookup:**
1. Trim whitespace
2. Uppercase
3. Strip spaces, hyphens, underscores
4. Zero-pad the numeric part to `ROLL_PAD_LENGTH`

So `22cs 101`, `22CS-101`, `22CS101` all normalize to one canonical `22CS101`. **Without this, a student who rejoins with different casing gets a fresh participant row and loses their entire score.** This is the most likely real-world bug in the whole app.

Store the canonical form in `participants.roll_number`; optionally keep the raw input in a separate column for debugging.

Reject out-of-range or malformed rolls at join with a clear message ("That doesn't look like a valid roll number for this class — check and try again"), not a generic error.

### Leaderboard

- Displays: **rank, name, roll number, total score**
- Auto-shows after questions **5, 10, 15, 20, 25** and at the end
- Host also has a manual "Show Leaderboard" button available at any point
- `/present` shows **top 10 only** (readable from the back of the room)
- Student play screen shows top 10 + "Your rank: #N of M" so everyone sees their own standing
- Host dashboard shows the **full sortable list** of all participants

### Session shape
- ~20-25 questions
- Estimated runtime: 20-30 min, budget 40 min if discussing answers
- Host needs a **"Skip Question"** control to drop questions live if running long
