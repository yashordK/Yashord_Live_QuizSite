-- =====================================================================
-- PODIUM phase: the top-three reveal on the projector.
--
-- A real phase rather than a client-side toggle, so the reveal is timed
-- from phase_started_at on the server. The projector's choreography
-- (drumroll, crown drop) and the moment phones stop hiding the names are
-- derived from that one timestamp, and a refreshed projector jumps to the
-- right point in the sequence instead of restarting it.
-- =====================================================================

do $$
declare c record;
begin
  -- The original CHECK was declared inline, so its generated name isn't
  -- guaranteed. Drop whichever check constraint governs `phase`.
  for c in
    select conname
    from pg_constraint
    where conrelid = 'public.sessions'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%phase%'
  loop
    execute format('alter table public.sessions drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.sessions
  add constraint sessions_phase_check
  check (phase in (
    'IDLE', 'QUESTION_ONLY', 'ACCEPTING_ANSWERS', 'LOCKED',
    'REVEALED', 'SOLUTION', 'LEADERBOARD', 'PODIUM'
  ));
