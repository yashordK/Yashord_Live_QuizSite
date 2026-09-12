-- =====================================================================
-- Post-migration verification.
--
-- Paste the whole thing into the Supabase SQL editor and run it. You get
-- one table back: every row should say PASS.
--
-- Read-only — it changes nothing. Safe to run any time, including 30
-- minutes before the event.
-- =====================================================================

with checks as (

  -- 1 ------------------------------------------------------------------
  select 1 as ord,
         'RLS enabled AND forced on all 4 tables'::text as check_name,
         case when count(*) filter (where relrowsecurity and relforcerowsecurity) = 4
              then 'PASS' else 'FAIL' end::text as status,
         coalesce(string_agg(
           relname || ' rls=' || relrowsecurity::text || ' forced=' || relforcerowsecurity::text,
           ', ' order by relname), 'no tables found')::text as detail
  from pg_class
  where relnamespace = 'public'::regnamespace
    and relname in ('sessions', 'questions', 'participants', 'answers')

  -- 2 ------------------------------------------------------------------
  -- The important one after clicking anything labelled "Enable RLS" in
  -- the dashboard: that flow sometimes offers to add a starter policy.
  -- Our model is deny-all, so the correct number of policies is ZERO.
  union all
  select 2,
         'No RLS policies exist (deny-all is intentional)',
         case when count(*) = 0 then 'PASS'
              else 'FAIL - a policy was added; drop it, see 0002_rls.sql' end,
         coalesce(string_agg(tablename || '.' || policyname, ', '), 'none - correct')
  from pg_policies
  where schemaname = 'public'
    and tablename in ('sessions', 'questions', 'participants', 'answers')

  -- 3 ------------------------------------------------------------------
  union all
  select 3,
         'UNIQUE (session_id, roll_number) on participants',
         case when count(*) >= 1 then 'PASS' else 'FAIL - rejoin will duplicate rows' end,
         coalesce(string_agg(conname, ', '), 'MISSING')
  from pg_constraint
  where contype = 'u'
    and conrelid = 'public.participants'::regclass
    and pg_get_constraintdef(oid) ilike '%session_id%roll_number%'

  -- 4 ------------------------------------------------------------------
  union all
  select 4,
         'UNIQUE (question_id, participant_id) on answers',
         case when count(*) >= 1 then 'PASS' else 'FAIL - double-submit is possible' end,
         coalesce(string_agg(conname, ', '), 'MISSING')
  from pg_constraint
  where contype = 'u'
    and conrelid = 'public.answers'::regclass
    and pg_get_constraintdef(oid) ilike '%question_id%participant_id%'

  -- 5 ------------------------------------------------------------------
  union all
  select 5,
         'Answer-phase trigger present on answers',
         case when count(*) = 1 then 'PASS' else 'FAIL - phase is only enforced in the API' end,
         coalesce(string_agg(tgname, ', '), 'MISSING')
  from pg_trigger
  where tgrelid = 'public.answers'::regclass
    and not tgisinternal
    and tgname = 'answers_enforce_phase'

  -- 6 ------------------------------------------------------------------
  union all
  select 6,
         'All 5 RPCs exist and service_role can EXECUTE them',
         case when count(*) = 5
               and count(*) filter (where has_function_privilege('service_role', oid, 'EXECUTE')) = 5
              then 'PASS' else 'FAIL - the app will 500 on every request' end,
         coalesce(string_agg(
           proname || '=' || has_function_privilege('service_role', oid, 'EXECUTE')::text,
           ', ' order by proname), 'NONE FOUND')
  from pg_proc
  where pronamespace = 'public'::regnamespace
    and proname in ('join_participant', 'set_session_state',
                    'set_phase_duration', 'answer_distribution', 'get_state')

  -- 7 ------------------------------------------------------------------
  -- The anon key ships to every student's browser. It must be able to
  -- read and write precisely nothing.
  union all
  select 7,
         'anon / authenticated have NO table privileges',
         case when count(*) = 0 then 'PASS'
              else 'FAIL - the public key can reach the database' end,
         coalesce(string_agg(distinct grantee || ' -> ' || table_name, ', '), 'none - correct')
  from information_schema.role_table_grants
  where table_schema = 'public'
    and grantee in ('anon', 'authenticated')
    and table_name in ('sessions', 'questions', 'participants',
                       'answers', 'participant_scores')

  -- 8 ------------------------------------------------------------------
  union all
  select 8,
         'participant_scores view exists (scores are derived)',
         case when count(*) = 1 then 'PASS' else 'FAIL' end,
         coalesce(string_agg(viewname, ', '), 'MISSING')
  from pg_views
  where schemaname = 'public' and viewname = 'participant_scores'

  -- 9 ------------------------------------------------------------------
  union all
  select 9,
         'Session row seeded',
         case when count(*) = 1 then 'PASS'
              when count(*) = 0 then 'FAIL - run seed.sql'
              else 'WARN - more than one session row' end,
         coalesce(string_agg(
           'code=' || code || ' phase=' || phase || ' status=' || status ||
           ' cap=' || join_cap, ', '), 'no session')
  from public.sessions
 
  -- 10 -----------------------------------------------------------------
  union all
  select 10,
         'Every correct_option exists in that question''s options',
         case when count(*) = 0 then 'PASS'
              else 'FAIL - bad answer key, fix before the event' end,
         case when count(*) = 0
              then (select count(*)::text || ' questions loaded' from public.questions)
              else string_agg('Q' || order_index || ' key=' || correct_option, ', ') end
  from public.questions q
  where not exists (
    select 1 from jsonb_array_elements(q.options) o
    where o->>'key' = q.correct_option
  )
)

select check_name, status, detail
from checks
order by ord;
