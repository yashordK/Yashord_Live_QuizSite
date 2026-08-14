-- =====================================================================
-- Live Quiz — Row Level Security + database-level phase enforcement
--
-- Security model
-- --------------
-- The browser NEVER holds a write-capable Postgres key. Every read and
-- write goes through a Next.js route handler using SUPABASE_SERVICE_ROLE_KEY,
-- which runs server-side only. RLS here is deny-all for `anon` and
-- `authenticated`: even if the anon key leaks (it is, by design, public),
-- it cannot read or write a single row.
--
-- Realtime is used for BROADCAST ONLY (a "something changed" nudge). The
-- payload is never trusted — clients refetch /api/state on receipt. So a
-- student holding the anon key can at worst send a nudge that causes
-- everyone to refetch the true state from the server.
-- =====================================================================

alter table public.sessions     enable row level security;
alter table public.questions    enable row level security;
alter table public.participants enable row level security;
alter table public.answers      enable row level security;

-- Force RLS even for the table owner, so nothing but the service role
-- (which bypasses RLS by design) can reach these tables.
alter table public.sessions     force row level security;
alter table public.questions    force row level security;
alter table public.participants force row level security;
alter table public.answers      force row level security;

-- Deliberately NO policies are created for anon/authenticated.
-- In Postgres, RLS enabled + zero applicable policies = deny everything.
-- Dropping any policy a previous migration or the dashboard may have added:
drop policy if exists "public read sessions"     on public.sessions;
drop policy if exists "public read questions"    on public.questions;
drop policy if exists "public read participants" on public.participants;
drop policy if exists "public read answers"      on public.answers;

-- Belt and braces: remove the default PostgREST grants as well, so these
-- tables fail at the privilege layer before RLS is even consulted.
revoke all on public.sessions           from anon, authenticated;
revoke all on public.questions          from anon, authenticated;
revoke all on public.participants       from anon, authenticated;
revoke all on public.answers            from anon, authenticated;
revoke all on public.participant_scores from anon, authenticated;

-- The service role must keep its access — it is how every API route
-- reads and writes. It has BYPASSRLS, so the policies above don't apply
-- to it, but it still needs the table privileges.
grant select, insert, update, delete
  on public.sessions, public.questions, public.participants, public.answers
  to service_role;
grant select on public.participant_scores to service_role;

-- =====================================================================
-- Database-level enforcement of "answers only during ACCEPTING_ANSWERS".
--
-- This is intentionally stricter than an RLS policy: it applies to the
-- SERVICE ROLE too. RLS is bypassed by the service role, so a policy
-- alone would not protect against a bug in our own API route. This
-- trigger is the last line of defence — an answer physically cannot be
-- recorded for a question that is not currently open, no matter who is
-- asking or what the application layer believes.
-- =====================================================================
create or replace function public.enforce_answer_phase()
returns trigger
language plpgsql
as $$
declare
  s_phase      text;
  s_current_q  uuid;
  q_voided     bool;
  q_skipped    bool;
begin
  select s.phase, s.current_question_id, q.voided, q.skipped
    into s_phase, s_current_q, q_voided, q_skipped
  from public.questions q
  join public.sessions  s on s.id = q.session_id
  where q.id = new.question_id;

  if not found then
    raise exception 'ANSWER_REJECTED_UNKNOWN_QUESTION'
      using errcode = 'check_violation';
  end if;

  if s_phase is distinct from 'ACCEPTING_ANSWERS' then
    raise exception 'ANSWER_REJECTED_PHASE_%', s_phase
      using errcode = 'check_violation';
  end if;

  if s_current_q is distinct from new.question_id then
    raise exception 'ANSWER_REJECTED_NOT_CURRENT_QUESTION'
      using errcode = 'check_violation';
  end if;

  if q_voided or q_skipped then
    raise exception 'ANSWER_REJECTED_QUESTION_CLOSED'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists answers_enforce_phase on public.answers;
create trigger answers_enforce_phase
  before insert on public.answers
  for each row execute function public.enforce_answer_phase();

-- Answers are immutable once written. Nothing in the app updates them;
-- "void this question" flips questions.voided instead, which keeps the
-- operation reversible and the audit trail intact.
create or replace function public.block_answer_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'ANSWERS_ARE_IMMUTABLE' using errcode = 'check_violation';
end;
$$;

drop trigger if exists answers_block_update on public.answers;
create trigger answers_block_update
  before update on public.answers
  for each row execute function public.block_answer_mutation();
