# The Yashord Quiz

A host-driven live quiz for ~200 students joining on their phones during a lecture.
Next.js 14+ (App Router, TypeScript, Tailwind) on Vercel, Supabase Postgres + Realtime.
No paid services.

Three surfaces:

| Surface | Route | Runs on |
|---|---|---|
| Student | `/` → `/play` | their phones |
| Host control | `/host/login` → `/host/control` | your laptop or phone |
| Projector | `/present` | the screen at the front |

---

## The five things that keep this correct

Worth knowing before you change anything, because each of these is load-bearing.

**1. The server owns the state.** Every client renders purely from the `sessions`
row. Clients never decide what phase they're in; they ask. Phase changes go through
one endpoint (`/api/host/action`) which takes an *action*, not a target phase, so a
replayed request can't drop the room into an arbitrary state.

**2. Timers are server-authoritative.** `phase_started_at` is written from the
*database* clock. Clients compute remaining time from that, correcting for their own
clock skew using the `server_now` field in every response. A phone with a wrong clock
sees the same countdown as everyone else, and can't buy itself extra time.

**3. The canonical roll number is the identity.** `normalizeRoll()` (trim → uppercase
→ strip spaces/dashes/underscores → zero-pad the trailing digits) runs server-side
before validation and before the uniqueness lookup, every time. `22cs 101`,
`22CS-101`, `22CS_101` and `22CS1` all resolve to `22CS101`. Combined with
`UNIQUE (session_id, roll_number)`, rejoining finds the existing row instead of
creating a duplicate. **This is the bug that silently destroys scores**, so it has its
own test file — see `src/lib/roll.test.ts`.

**4. Scores are derived, never stored.** Always `SUM(points_earned)` over `answers`
(via the `participant_scores` view). There is no mutable score column to drift, which
is exactly why a rejoining student keeps their points with zero restoration logic.

**5. Answers are gated in four independent places.** The route checks the phase; the
route checks server-measured elapsed time; `UNIQUE (question_id, participant_id)`
makes a double-tap structurally unable to write twice; and a `BEFORE INSERT` trigger
re-checks the phase *in the database*. The trigger matters because the service role
bypasses RLS — a policy alone wouldn't protect against a bug in our own route.

---

## Setup

### 1. Supabase

Create a free project, then in the SQL editor run these **in order**:

```
supabase/migrations/0001_init.sql
supabase/migrations/0002_rls.sql
supabase/migrations/0003_join_function.sql
supabase/migrations/0004_set_state.sql
supabase/migrations/0005_get_state.sql
supabase/migrations/0006_leaderboard.sql
supabase/seed.sql
```

Then paste `supabase/verify.sql` in and run it — read-only, returns one table where
every row should say PASS. It checks RLS is on with **zero** policies, both UNIQUE
constraints exist, the trigger is installed, `service_role` can execute every RPC,
`anon` has no table privileges, and every answer key matches one of its options.

Row 2 is the one to watch. If you ever click "Enable RLS" in the Supabase dashboard,
that flow can offer to add a starter policy like *"Enable read access for all users"* —
which would hand every student's browser read access to `questions`, answer keys
included. Deny-all means RLS on and **no policies at all**.

`seed.sql` creates the session row and six demo questions. **Edit the join code at
the top of it** so it matches the `SESSION_CODE` you're going to use.

### 2. Environment

```bash
cp .env.example .env.local
```

Fill in:

| Variable | Where it comes from |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | same page. Public by design; RLS is deny-all so it can't touch any row |
| `SUPABASE_SERVICE_ROLE_KEY` | same page. **Server only** — never prefix with `NEXT_PUBLIC_` |
| `HOST_PASSWORD` | you choose. Make it long |
| `HOST_SESSION_SECRET` | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `SESSION_CODE` | must match `seed.sql` |
| `JOIN_CAP` | 185 |
| `ROLL_PAD_LENGTH` | 3 unless your rolls use a different width |

Roll validation is deliberately **lenient** — normalize, sanity-check the shape,
accept. Your three batches don't share one prefix, and locking students out over an
unexpected prefix mid-lecture is worse than letting a stray roll through. Normalization
still runs unconditionally; that's the part that protects scores.

### 3. Run

```bash
npm install
npm run dev
```

- Students: http://localhost:3000
- Host: http://localhost:3000/host/login
- Projector: http://localhost:3000/present
- **Health check: http://localhost:3000/api/health**

Hit `/api/health` first. It tells you exactly which env var is missing, whether the
migrations ran, whether questions are loaded, and whether a secret has accidentally
been exposed to the browser — without ever echoing a value. It's also the daily
"keep Supabase awake" ping in the run-up to the event.

### 4. Load your questions

CSV or JSON. See `data/questions.example.csv` for the format.

```bash
npm run questions:load -- --file data/questions.csv --dry-run
```

Dry run first — it validates that **every `correct_option` actually exists in that
row's options** and refuses to write anything if not. Then:

```bash
npm run questions:load -- --file data/questions.csv --replace
```

`--replace` clears existing questions first (and cascade-deletes their answers, which
is why it's opt-in).

---

## Deploy to Vercel

1. Push to a Git repo, import it in Vercel.
2. Add every variable from `.env.example` under Settings → Environment Variables,
   for **Production**. Double-check `SUPABASE_SERVICE_ROLE_KEY` has no
   `NEXT_PUBLIC_` prefix.
3. Deploy. No build config needed.

The join URL is public. `/host/control` is protected by a signed httpOnly cookie
verified server-side on **every** `/api/host/*` request — hiding the buttons is a
convenience, the API is the boundary. Don't rely on the URL being secret; 200
students will have it within minutes of it appearing on a projector.

---

## Load test

Run this before the event, with **more** clients than you expect.

```bash
node loadtest/run.mjs --n 220 --drive
```

`--drive` logs in as host and runs the phases itself, so you can run it alone. It:

- fires 220 joins inside a 2-second window (the projector-code stampede)
- **re-joins 20 students with reformatted roll numbers** and fails loudly if any of
  them creates a new participant instead of matching the existing one
- keeps every client polling `/api/state` every 5s and heart-beating every 25s
- has everyone answer at random points in the window, with 15% double-tapping
- submits one answer *after* the lock and asserts it's refused with a 409
- reports p50/p95/p99 per endpoint and flags any 5xx

Against a deployed URL:

```bash
node loadtest/run.mjs --n 220 --drive --url https://your-app.vercel.app
```

Clean up the fake participants afterwards:

```bash
node loadtest/run.mjs --cleanup
```

**Reading the output:** `full` counts above the cap are the graceful path working,
not a failure. `unexpected failures` and any 5xx are real.

### Measured, 220 clients against a production build

Run on a Windows laptop against Supabase over the public internet — Vercel should be
at least this good.

| endpoint | p50 | p95 | p99 |
|---|---|---|---|
| `/api/state` (polled by every client every 5s) | 112ms | 381ms | 647ms |
| `/api/answer` | 207ms | 290ms | 552ms |
| `/api/heartbeat` | 103ms | 214ms | 595ms |
| `/api/join` (220 joins inside 2s) | 1522ms | 2040ms | 2248ms |
| `/api/leaderboard` | 951ms → see below | | |

`created=185` exactly, `full=35`, zero unexpected failures, zero 5xx. The cap held
precisely under the stampede — that's the advisory lock in `join_participant` doing
its job.

The leaderboard originally measured ~950ms because it pulled every participant's
score over the wire and ranked them in JavaScript, once per client, at every reveal.
`0006_leaderboard.sql` moved the ranking into a SQL window function that returns ~10
rows instead of ~200. **Do not revert that to the JS version** — it is the heaviest
repeated operation in the quiz.

> Measure against `next build && next start`, never `next dev`. In dev the same run
> showed `/api/state` p50 at 1927ms purely from on-demand compilation. Those numbers
> mean nothing.

---

## Manual test plan

Work through these in order. Each one covers something that's expensive to discover live.

### A. Schema
1. Run all five migrations, then `seed.sql`. The final `SELECT` in `seed.sql` must
   return **zero rows** — any row is a question whose answer key isn't one of its options.
2. In the Supabase table editor, confirm `participants` has a unique index on
   `(session_id, roll_number)` and `answers` on `(question_id, participant_id)`.

### B. Rejoin — the important one
1. Join as `Yash` / `22CS101`. Answer a question, get some points.
2. Force-close the browser. Reopen, join as `22cs-101` (different case, with a dash).
3. **Your score must still be there and the host's joined count must not increase.**
   If a second row appears, stop and fix normalization before anything else.
4. Rejoin mid-`ACCEPTING_ANSWERS` for a question you already answered — you should
   see your locked-in choice, not a fresh answerable question.
5. Rejoin during a question you missed entirely — you *can* answer, with whatever
   time remains. Questions that fully passed while you were gone score 0. That's the
   documented rule; say it aloud if anyone asks.

### C. Answer integrity
1. During `ACCEPTING_ANSWERS`, open devtools → Network. Confirm the `/api/state`
   response contains **no `correct_option`**.
2. Double-tap an option fast. One answer recorded, no error shown.
3. After the host hits Lock, replay the `/api/answer` request from devtools. Must
   come back **409**, not 200.
4. Let a timer run out without answering, then submit. Must be refused.

### D. Host boundary
1. Log out. `curl -X POST .../api/host/action -d '{"action":"REVEAL"}'` → **401**.
2. Log in on a second device (your phone). Both control panels should work — this is
   your recovery path if the laptop dies.

### E. Timers and scoring
1. Answer instantly → ~150 points. Answer at the buzzer → ~100. Wrong → 0.
2. Change your device clock by an hour. The countdown must be unaffected.
3. While a question is open, change the answer timer in the host panel. The running
   countdown extends — it does **not** restart.

### F. Projector
1. Open `/present` on a second screen. Confirm no controls and no answer key before
   `REVEALED`.
2. Stand at the back of the room and read it. Adjust `text-present` in
   `tailwind.config.ts` if it's not big enough.

### G. Recovery
1. Turn wifi off on a phone mid-question, back on 20s later. It should snap to the
   current phase within ~5 seconds without a refresh.
2. Press **Re-broadcast state** with a client stuck. It should catch up immediately.

---

## Pre-event checklist

**T-5 days** — Deployed to Vercel. Supabase live, all migrations applied. Walk the
whole quiz once end to end.

**T-3 days** — Dry run with 5–10 friends on their own phones, on mobile data *and*
wifi. Test rejoin explicitly: have someone force-close and come back.

**T-2 days** — Load test with 220+ clients. Confirm graceful "Quiz is full" above the
cap, not crashes.

**Daily in the run-up** — Open `/api/health` once a day. It's a real query, so it
keeps the free-tier project from auto-pausing, and it verifies config at the same time.

**T-1 day** — Ping Supabase so it doesn't auto-pause. Load the real questions.
**Verify the answer keys twice** — `/host/control` → Questions tab shows every key in
one list. Print the join URL and code large for the projector.

**T-0, 30 min before** — Open `/host/control`, confirm phase is `IDLE`, self-join as a
test, then remove that test participant. Open `/present` on the projector. Have the
questions in a PDF as an offline backup.

**Immediately after** — **Export the CSV.** Before anything pauses, before you close
the laptop. `/host/control` → Export CSV.

---

## Host controls

| Control | What it does |
|---|---|
| Start / Next Question | advances; auto-inserts the leaderboard after every 5th question |
| Show Options | opens the answer window (the only phase that accepts answers) |
| Lock Answers | closes it |
| Reveal Answer | publishes the key — **cannot be undone back into answering** |
| Show Solution | shows the explanation |
| Show Leaderboard | available at any point |
| ← Previous / Skip Question | navigate; Skip drops a question live and renumbers |
| Reading / Answer seconds | editable live; extends a running countdown, doesn't restart it |
| Lock joining | stops new joins; **existing students can always still rejoin** |
| Auto-advance | fires transitions when a countdown hits zero. Off by default. Needs the host page open |
| Void this question | zeroes its points for everyone, reversibly. Use it if an answer key was wrong |
| Re-broadcast state | nudges every client to refetch. Fixes a stuck screen instantly |
| Export CSV | full results, one row per student, one column group per question |

The answer distribution bar is visible to you at every phase — including *before* you
reveal, which is the point. Students never see it.

---

## Scoring

```
wrong or unanswered  →  0                                    (no negative marking)
correct              →  100 + round(50 × time_remaining / answer_time_sec)
```

Bonus clamped to `[0, 50]`. `time_remaining` is computed server-side from
`phase_started_at`, so a late request can produce neither a negative nor an inflated
bonus. Fast correct ≈ 150, correct at the buzzer ≈ 100. Correctness dominates speed by
design: a slow correct answer beats a fast wrong one by 100 points.

Ties share a rank (1, 2, 2, 4).

---

## Known limits

Being explicit about these rather than letting you find them at 2am:

- **Auto-advance needs the host page open.** Vercel's free tier has no
  second-granularity scheduler, so the countdown transitions fire from the host
  browser. It defaults to off. Manual advancing has no such dependency.
- **The join rate limit is per-instance.** On Vercel with several warm lambdas the
  effective limit is a multiple of the configured one. It's there to stop casual
  scripting, not a determined attacker. Nothing security-critical depends on it.

- **The per-IP join limit must stay generous.** Every student on campus wifi shares
  one NAT'd public IP. The first version of this used 8/min per IP, and the load test
  caught it immediately: 8 students in, everyone else told "too many attempts". It is
  now 240/min per IP as a flood guard, with the tight limit on the *roll number*
  axis (6/min) where it bounds one student retrying without touching the other 199.
  **If you ever lower `JOIN_RATE_LIMIT_PER_MIN`, you will lock out your class.**
- **Device-token duplicate detection flags, never blocks.** Two people sharing a roll
  number will share a participant row and a score. The flag surfaces it on the
  dashboard; deciding what to do is yours. Blocking would create a support queue
  mid-presentation.
- **Realtime broadcast is unauthenticated.** Anyone with the public anon key can send
  on the channel, so clients treat a broadcast purely as a "refetch now" nudge and
  never render its payload. Worst case: someone makes everyone reload the true state.

---

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` / `build` / `start` | the usual |
| `npm test` | 61 unit tests (roll normalization, scoring, state machine) |
| `npm run probe` | fires the **public anon key** at the database the way a student with devtools would. Every probe must be blocked. Run after any change in the Supabase dashboard |
| `npm run questions:load -- --file data/questions.json --replace` | bulk-load questions; validates every answer key first |
| `node scripts/set-title.mjs "New Title"` | change the quiz title. Lives on the session row, so **no redeploy needed** |
| `node loadtest/run.mjs --n 220 --drive` | the load test |
| `node loadtest/run.mjs --cleanup` | delete the fake load-test participants |
| `node scripts/fix-encoding.mjs <files>` | repair CP1252-mangled UTF-8 (see Windows notes) |

## Content

The 24 real questions live in `data/questions.json` and are already loaded. Edit that
file and re-run `questions:load --replace` to change them.

Question text may contain **fenced code blocks**, which is how the C snippets are
written:

    What will be the output?
    ```
    int a = 5, b = 2;
    printf("%d", a + b * 3);
    ```

`QuestionBody` splits on the fences and renders code in a monospace block on all
three surfaces. About a quarter of this quiz is "what does this print", and a
snippet mashed into a proportional font with its newlines collapsed is genuinely
hard to read from the back of a hall.

## Windows notes

Three things that cost time on this machine, so they're written down:

- **Don't edit UTF-8 files with PowerShell 5.1.** `Set-Content -Encoding utf8` writes
  a BOM and `Get-Content` decodes as the ANSI codepage, so every em-dash and arrow in
  a file gets mangled. `node scripts/fix-encoding.mjs <files>` repairs it — note it
  needs a real CP1252 reverse map, not a Latin-1 round-trip, because bytes 0x80-0x9F
  differ between the two.
- **Don't use a `VAR=x npx next start` env prefix in Git Bash.** It breaks Next's
  project resolution and every route 404s with a confusing Pages Router error. Use
  `env VAR=x npx next start` instead.
- **`pkill` doesn't kill Windows node processes.** A "stale build" that survives a
  rebuild is almost always the old server still holding the port. Kill by port:
  `Get-NetTCPConnection -LocalPort 3000 -State Listen | %{ Stop-Process -Id $_.OwningProcess -Force }`
- **Never run `next build` while `next dev` is live** on the same checkout — it
  clobbers `.next` and the dev server starts throwing "Cannot find module './xxx.js'".
  Fix with `rm -rf .next`.

## Tests

```bash
npm test
```

61 unit tests covering roll normalization (including unicode dashes, zero-width
spaces and pad-up-only behaviour), the scoring clamp, and every state-machine
transition guard. `npm run typecheck` and `npm run build` should both be clean.
