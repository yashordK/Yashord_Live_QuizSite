-- =====================================================================
-- get_state: the whole polled payload in ONE round trip.
--
-- Every client polls this every 5 seconds as the fallback that rescues
-- anyone whose websocket died. At ~200 clients that is ~40 requests a
-- second; assembling the payload from six separate queries would put
-- ~240 queries/sec on a free-tier database for no reason. One function,
-- one round trip.
--
-- NOTE: this returns the RAW question row, correct_option included. The
-- phase-based stripping happens in TypeScript (toPublicQuestion) so that
-- the "when is the answer key public" rule lives in exactly one place
-- instead of being duplicated here and drifting. The raw row never
-- leaves the server — the route strips it before responding.
-- =====================================================================

create or replace function public.get_state(
  p_code           text,
  p_participant_id uuid default null
)
returns jsonb
language plpgsql
stable
as $$
declare
  v_session   public.sessions%rowtype;
  v_question  public.questions%rowtype;
  v_joined    int;
  v_q_number  int;
  v_q_total   int;
  v_me        jsonb := null;
begin
  select * into v_session
  from public.sessions
  where code = upper(p_code);

  if not found then
    return jsonb_build_object('not_found', true);
  end if;

  select count(*) into v_joined
  from public.participants
  where session_id = v_session.id;

  -- Skipped questions are excluded from the numbering students see, so
  -- "Question 7 of 22" stays honest after the host trims one live.
  select count(*) into v_q_total
  from public.questions
  where session_id = v_session.id and skipped = false;

  if v_session.current_question_id is not null then
    select * into v_question
    from public.questions
    where id = v_session.current_question_id;

    if found then
      select count(*) into v_q_number
      from public.questions
      where session_id = v_session.id
        and skipped = false
        and order_index <= v_question.order_index;
    end if;
  end if;

  if p_participant_id is not null then
    select jsonb_build_object(
             'participant_id', p.id,
             'name',           p.name,
             'roll_number',    p.roll_number,
             'total_score',    coalesce(ps.total_score, 0),
             'my_answer',
               case when v_question.id is null then null else (
                 select jsonb_build_object(
                          'selected_option', a.selected_option,
                          'is_correct',      a.is_correct,
                          'points_earned',   a.points_earned
                        )
                 from public.answers a
                 where a.participant_id = p.id
                   and a.question_id    = v_question.id
               ) end
           )
      into v_me
    from public.participants p
    left join public.participant_scores ps on ps.participant_id = p.id
    where p.id = p_participant_id
      and p.session_id = v_session.id;
  end if;

  return jsonb_build_object(
    'server_now',      now(),
    'session',         to_jsonb(v_session),
    'question',        case when v_question.id is null then null else to_jsonb(v_question) end,
    'joined_count',    v_joined,
    'question_number', v_q_number,
    'question_total',  v_q_total,
    'me',              v_me
  );
end;
$$;

-- Revoke from PUBLIC first, then grant back explicitly: service_role
-- holds EXECUTE via PUBLIC by default, so the revoke alone would lock
-- our own API routes out of this function.
revoke all on function public.get_state(text, uuid) from public, anon, authenticated;
grant execute on function public.get_state(text, uuid) to service_role;
