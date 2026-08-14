-- =====================================================================
-- Live Quiz — initial schema
-- Apply in the Supabase SQL editor (or `supabase db push`) BEFORE 0002.
-- =====================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------
-- sessions : exactly one row per quiz event. Holds the authoritative
-- state machine. Every client renders purely from this row.
-- ---------------------------------------------------------------------
create table if not exists public.sessions (
  id                    uuid primary key default gen_random_uuid(),
  code                  text not null unique,
  title                 text not null default 'Live Quiz',
  status                text not null default 'lobby'
                          check (status in ('lobby', 'live', 'ended')),

  current_question_id   uuid,
  phase                 text not null default 'IDLE'
                          check (phase in (
                            'IDLE','QUESTION_ONLY','ACCEPTING_ANSWERS',
                            'LOCKED','REVEALED','SOLUTION','LEADERBOARD'
                          )),

  -- Server-authoritative timer. Clients compute remaining time as
  -- phase_duration_sec - (now() - phase_started_at). Client clocks are
  -- never trusted; see /api/state, which also returns server_now.
  phase_started_at      timestamptz not null default now(),
  phase_duration_sec    int,

  join_cap              int  not null default 185,
  joining_locked        bool not null default false,
  auto_advance          bool not null default false,

  -- Auto-show the leaderboard after every Nth question.
  leaderboard_interval  int  not null default 5,
  -- order_index of the last question after which the leaderboard was
  -- auto-shown. Stops the interval leaderboard re-triggering when the
  -- host navigates back and forward across the same boundary.
  leaderboard_shown_after int not null default 0,

  -- Bumped on every host-driven state write. Clients ignore any state
  -- payload whose version is older than the one they already have, so
  -- an out-of-order poll can never drag a client backwards.
  state_version         bigint not null default 0,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- questions
-- ---------------------------------------------------------------------
create table if not exists public.questions (
  id                uuid primary key default gen_random_uuid(),
  session_id        uuid not null references public.sessions(id) on delete cascade,
  order_index       int  not null,
  question_text     text not null,
  image_url         text,
  -- [{"key":"A","text":"..."}, {"key":"B","text":"..."}, ...]
  options           jsonb not null,
  correct_option    text not null,
  solution_text     text,
  reading_time_sec  int not null default 5,
  answer_time_sec   int not null default 20,
  points            int not null default 100,

  -- Host controls. `voided` nulls this question's points for EVERYONE
  -- (used when a wrong answer key slips through) and is reversible: the
  -- answer rows are left untouched and simply excluded from scoring.
  voided            bool not null default false,
  skipped           bool not null default false,

  created_at        timestamptz not null default now(),

  unique (session_id, order_index)
);

create index if not exists questions_session_order_idx
  on public.questions (session_id, order_index);

alter table public.sessions
  drop constraint if exists sessions_current_question_fk;
alter table public.sessions
  add constraint sessions_current_question_fk
  foreign key (current_question_id) references public.questions(id) on delete set null;

-- ---------------------------------------------------------------------
-- participants
--
-- roll_number holds the CANONICAL (normalized) roll. raw_roll_number
-- keeps whatever the student actually typed, for debugging only.
-- ---------------------------------------------------------------------
create table if not exists public.participants (
  id                uuid primary key default gen_random_uuid(),
  session_id        uuid not null references public.sessions(id) on delete cascade,
  roll_number       text not null,
  raw_roll_number   text,
  name              text not null,

  joined_at         timestamptz not null default now(),
  last_seen_at      timestamptz not null default now(),
  is_online         bool not null default true,

  device_token      text,
  -- Incremented when a rejoin presents a device_token that differs from
  -- the stored one. We never block on this — real rejoins from a second
  -- device are common — we only surface it on the host dashboard.
  device_mismatches int not null default 0,
  flagged_duplicate bool not null default false,

  -- LOAD-BEARING. This is what makes rejoin work: re-entering the same
  -- roll finds the existing row instead of creating a duplicate, so the
  -- student's score (derived from `answers`) survives intact.
  unique (session_id, roll_number)
);

create index if not exists participants_session_idx
  on public.participants (session_id);

-- ---------------------------------------------------------------------
-- answers
--
-- Score is NEVER a stored mutable column on participants. It is always
-- SUM(points_earned) over these rows. That is precisely why rejoining
-- needs no score-restoration logic at all.
-- ---------------------------------------------------------------------
create table if not exists public.answers (
  id                uuid primary key default gen_random_uuid(),
  question_id       uuid not null references public.questions(id) on delete cascade,
  participant_id    uuid not null references public.participants(id) on delete cascade,
  selected_option   text not null,
  is_correct        bool not null,
  points_earned     int  not null default 0,
  -- Server-measured ms between phase_started_at and request arrival.
  -- Recorded for auditing; scoring recomputes from it, never from any
  -- client-supplied timestamp.
  server_elapsed_ms int,
  answered_at       timestamptz not null default now(),

  -- LOAD-BEARING. Makes double-submission structurally impossible even
  -- when a student double-taps and two requests race.
  unique (question_id, participant_id)
);

create index if not exists answers_question_idx    on public.answers (question_id);
create index if not exists answers_participant_idx on public.answers (participant_id);

-- ---------------------------------------------------------------------
-- participant_scores : derived scores. Voided questions are excluded
-- here, which is what makes "void this question" a one-flag operation.
-- security_invoker so the view cannot be used to sidestep RLS.
-- ---------------------------------------------------------------------
create or replace view public.participant_scores
with (security_invoker = on) as
select
  p.id                as participant_id,
  p.session_id,
  p.name,
  p.roll_number,
  p.is_online,
  p.last_seen_at,
  p.joined_at,
  p.flagged_duplicate,
  p.device_mismatches,
  coalesce(sum(a.points_earned) filter (where q.voided = false), 0)::int as total_score,
  count(a.id) filter (where q.voided = false and a.is_correct)           as correct_count,
  count(a.id) filter (where q.voided = false)                            as answered_count
from public.participants p
left join public.answers   a on a.participant_id = p.id
left join public.questions q on q.id = a.question_id
group by p.id;

-- ---------------------------------------------------------------------
-- updated_at touch trigger on sessions
-- ---------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists sessions_touch_updated_at on public.sessions;
create trigger sessions_touch_updated_at
  before update on public.sessions
  for each row execute function public.touch_updated_at();
