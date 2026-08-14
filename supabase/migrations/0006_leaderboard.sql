-- =====================================================================
-- get_leaderboard: rank in SQL, return only what's displayed.
--
-- Why this exists: at every reveal, ~185 clients pull the leaderboard
-- within a second or two of each other, and that happens once per
-- question. The original implementation fetched every participant's
-- aggregated score over the wire and ranked them in JavaScript, which
-- measured ~950ms p50 under load — by far the heaviest repeated
-- operation in the quiz.
--
-- Ranking with a window function lets the database do the sort once and
-- return ~10 rows instead of ~200, while still computing the caller's
-- own rank against the FULL field (which is why we can't just LIMIT the
-- underlying query).
--
-- Ties share a rank: standard competition ranking, 1, 2, 2, 4.
-- =====================================================================

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
