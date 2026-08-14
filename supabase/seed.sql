-- =====================================================================
-- Live Quiz — seed
--
-- Creates the single session row and a handful of demo questions so you
-- can click through every phase before your real questions exist.
--
-- Run AFTER 0001_init.sql and 0002_rls.sql.
--
-- IMPORTANT: change 'QUIZ01' to match SESSION_CODE in your environment.
-- The app looks the session up by code, so a mismatch means "session not
-- found" on the join screen.
--
-- Load your real questions with:
--     npm run questions:load -- --file data/questions.csv --replace
-- which is safer than editing SQL by hand and validates the answer keys.
-- =====================================================================

insert into public.sessions (code, title, status, phase, join_cap, leaderboard_interval)
values ('QUIZ01', 'The Yashord Quiz', 'lobby', 'IDLE', 185, 5)
on conflict (code) do update
  set title                = excluded.title,
      join_cap             = excluded.join_cap,
      leaderboard_interval = excluded.leaderboard_interval;

-- ---------------------------------------------------------------------
-- Demo questions. Safe to delete once your real set is loaded:
--     delete from public.questions where session_id =
--       (select id from public.sessions where code = 'QUIZ01');
-- ---------------------------------------------------------------------
with s as (select id from public.sessions where code = 'QUIZ01')
insert into public.questions
  (session_id, order_index, question_text, options, correct_option,
   solution_text, reading_time_sec, answer_time_sec, points)
select s.id, v.order_index, v.question_text, v.options::jsonb, v.correct_option,
       v.solution_text, v.reading_time_sec, v.answer_time_sec, 100
from s, (values
  (1,
   'Which data structure gives O(1) average-case lookup by key?',
   '[{"key":"A","text":"Linked list"},{"key":"B","text":"Hash table"},{"key":"C","text":"Binary search tree"},{"key":"D","text":"Array"}]',
   'B',
   'A hash table computes the bucket directly from the key, so an average lookup costs constant time. A balanced BST is O(log n); a linked list and an unsorted array are O(n).',
   5, 20),
  (2,
   'What is the time complexity of binary search on a sorted array of n elements?',
   '[{"key":"A","text":"O(1)"},{"key":"B","text":"O(log n)"},{"key":"C","text":"O(n)"},{"key":"D","text":"O(n log n)"}]',
   'B',
   'Each comparison halves the remaining search space, so the number of steps is log base 2 of n.',
   5, 20),
  (3,
   'In SQL, which clause filters rows AFTER aggregation?',
   '[{"key":"A","text":"WHERE"},{"key":"B","text":"GROUP BY"},{"key":"C","text":"HAVING"},{"key":"D","text":"ORDER BY"}]',
   'C',
   'WHERE filters individual rows before grouping. HAVING filters the grouped results, so it is the one that can reference aggregate functions such as COUNT or SUM.',
   5, 20),
  (4,
   'Which HTTP status code means "the request was understood but the server refuses to fulfil it"?',
   '[{"key":"A","text":"401 Unauthorized"},{"key":"B","text":"403 Forbidden"},{"key":"C","text":"404 Not Found"},{"key":"D","text":"500 Internal Server Error"}]',
   'B',
   '401 means you have not authenticated. 403 means the server knows who you are and is still saying no.',
   5, 20),
  (5,
   'A process is in deadlock. Which condition is NOT required for deadlock to occur?',
   '[{"key":"A","text":"Mutual exclusion"},{"key":"B","text":"Hold and wait"},{"key":"C","text":"Preemption"},{"key":"D","text":"Circular wait"}]',
   'C',
   'The four Coffman conditions are mutual exclusion, hold and wait, NO preemption, and circular wait. Preemption being possible actually breaks deadlock rather than causing it.',
   5, 25),
  (6,
   'Which normal form eliminates transitive dependencies on the primary key?',
   '[{"key":"A","text":"1NF"},{"key":"B","text":"2NF"},{"key":"C","text":"3NF"},{"key":"D","text":"BCNF"}]',
   'C',
   '1NF removes repeating groups, 2NF removes partial dependencies on a composite key, and 3NF removes transitive dependencies.',
   5, 20)
) as v(order_index, question_text, options, correct_option, solution_text,
       reading_time_sec, answer_time_sec)
on conflict (session_id, order_index) do update
  set question_text    = excluded.question_text,
      options          = excluded.options,
      correct_option   = excluded.correct_option,
      solution_text    = excluded.solution_text,
      reading_time_sec = excluded.reading_time_sec,
      answer_time_sec  = excluded.answer_time_sec;

-- Sanity check: every question's correct_option must exist in its options.
-- This should return zero rows. If it doesn't, you have a bad answer key.
select q.order_index, q.correct_option
from public.questions q
where not exists (
  select 1 from jsonb_array_elements(q.options) o
  where o->>'key' = q.correct_option
);
