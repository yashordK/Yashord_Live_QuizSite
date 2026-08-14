-- =====================================================================
-- How many places the leaderboard shows.
--
-- For this event the top 24 qualify for the next game, so the number
-- displayed is not cosmetic — it IS the cut line, and everyone in the
-- room will be counting rows. Kept on the session row rather than in an
-- env var so it can be changed live without a redeploy.
--
-- Also returns whether the score at the cut line is TIED with the next
-- place down. That is the situation that starts an argument in front of
-- 200 people: if #24 and #25 have identical scores, showing exactly 24
-- rows cuts someone on an arbitrary alphabetical tiebreak. The host
-- panel surfaces this so you can decide deliberately rather than
-- discover it on the projector.
-- =====================================================================

alter table public.sessions
  add column if not exists leaderboard_top int not null default 10;

comment on column public.sessions.leaderboard_top is
  'Places shown on /present and the student leaderboard. For this event, the qualifying cut for the next game.';

create or replace function public.get_leaderboard(
  p_session_id     uuid,
  p_limit          int  default 10,
  p_participant_id uuid default null
)
returns jsonb
language sql
stable
as $$
  with ranked as (
    select
      ps.participant_id,
      ps.name,
      ps.roll_number,
      ps.total_score,
      rank() over (order by ps.total_score desc) as rnk,
      -- Deterministic display order within a tie, so the list doesn't
      -- reshuffle between two clients rendering the same moment.
      row_number() over (
        order by ps.total_score desc, ps.name asc, ps.roll_number asc
      ) as position
    from public.participant_scores ps
    where ps.session_id = p_session_id
  )
  select jsonb_build_object(
    'entries', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'rank',        r.rnk,
                 'name',        r.name,
                 'roll_number', r.roll_number,
                 'total_score', r.total_score
               ) order by r.position
             )
      from ranked r
      where r.position <= greatest(p_limit, 0)
    ), '[]'::jsonb),

    'total_participants', (select count(*) from ranked),

    -- True when the last shown place and the first hidden place have the
    -- same score, i.e. the cut splits a tie.
    'cutoff_tied', coalesce((
      select (select total_score from ranked where position = p_limit)
           = (select total_score from ranked where position = p_limit + 1)
    ), false),

    'cutoff_score', (select total_score from ranked where position = p_limit),

    'me', (
      select jsonb_build_object('rank', r.rnk, 'total_score', r.total_score)
      from ranked r
      where p_participant_id is not null
        and r.participant_id = p_participant_id
    )
  );
$$;

revoke all on function public.get_leaderboard(uuid, int, uuid)
  from public, anon, authenticated;
grant execute on function public.get_leaderboard(uuid, int, uuid) to service_role;

-- Set the cut for this event.
update public.sessions set leaderboard_top = 24;
