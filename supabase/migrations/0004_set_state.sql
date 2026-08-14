-- =====================================================================
-- Atomic state transition.
--
-- One statement writes the new phase, the new current question, the new
-- timer origin and the incremented version together. Clients discard any
-- polled payload whose state_version is older than what they already
-- have, so a slow response arriving out of order can never drag a screen
-- backwards into a previous phase.
--
-- phase_started_at is set from now() here, on the DATABASE clock. Neither
-- the browser's clock nor the serverless function's clock is trusted, so
-- every client in the room counts down against the same origin.
-- =====================================================================

create or replace function public.set_session_state(
  p_session_id              uuid,
  p_phase                   text,
  p_status                  text,
  p_current_question_id     uuid,
  p_duration_sec            int,
  p_leaderboard_shown_after int
)
returns table (
  state_version    bigint,
  phase_started_at timestamptz
)
language plpgsql
as $$
begin
  return query
  update public.sessions s
     set phase                   = p_phase,
         status                  = p_status,
         current_question_id     = p_current_question_id,
         phase_duration_sec      = p_duration_sec,
         phase_started_at        = now(),
         leaderboard_shown_after = p_leaderboard_shown_after,
         state_version           = s.state_version + 1
   where s.id = p_session_id
  returning s.state_version, s.phase_started_at;
end;
$$;

-- Revoke from PUBLIC, then grant back to service_role explicitly —
-- otherwise our own API routes lose EXECUTE along with everyone else.
revoke all on function public.set_session_state(uuid, text, text, uuid, int, int)
  from public, anon, authenticated;
grant execute on function public.set_session_state(uuid, text, text, uuid, int, int)
  to service_role;

-- ---------------------------------------------------------------------
-- Live timer edit. Changes how long the CURRENT phase runs without
-- restarting it, so the host can extend a countdown mid-question without
-- handing everyone a fresh full timer (and a fresh full speed bonus).
-- ---------------------------------------------------------------------
create or replace function public.set_phase_duration(
  p_session_id uuid,
  p_duration_sec int
)
returns bigint
language plpgsql
as $$
declare
  v_version bigint;
begin
  update public.sessions s
     set phase_duration_sec = p_duration_sec,
         state_version      = s.state_version + 1
   where s.id = p_session_id
  returning s.state_version into v_version;

  return v_version;
end;
$$;

revoke all on function public.set_phase_duration(uuid, int)
  from public, anon, authenticated;
grant execute on function public.set_phase_duration(uuid, int) to service_role;

-- ---------------------------------------------------------------------
-- Answer distribution for the current question, for the host's live bar.
-- Returned even while answers are open — the host is the only caller.
-- ---------------------------------------------------------------------
create or replace function public.answer_distribution(p_question_id uuid)
returns table (selected_option text, n bigint)
language sql
stable
as $$
  select a.selected_option, count(*) as n
  from public.answers a
  where a.question_id = p_question_id
  group by a.selected_option
  order by a.selected_option;
$$;

revoke all on function public.answer_distribution(uuid)
  from public, anon, authenticated;
grant execute on function public.answer_distribution(uuid) to service_role;
