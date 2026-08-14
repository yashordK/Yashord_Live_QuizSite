-- =====================================================================
-- Optional roll-number prefix picker.
--
-- When this list is non-empty, the join screen offers the prefixes as
-- buttons and asks only for the digits — so a student taps "22CS" and
-- types "101" instead of typing "22CS101" and possibly fumbling the
-- prefix. It removes prefix variance at the source rather than
-- normalising it afterwards.
--
-- Empty list (the default) = free-text roll entry, exactly as before.
--
-- This is a CONVENIENCE, never a gate. The join screen always keeps a
-- "my roll looks different" fallback to free text, because a student
-- whose prefix isn't on the list must still be able to get in — being
-- locked out is strictly worse than a typo.
--
-- Identity is unaffected: the server composes prefix + digits and then
-- runs the same normalizeRoll() it runs on free text, so both paths
-- resolve to the same canonical roll and the same participant row.
-- =====================================================================

alter table public.sessions
  add column if not exists roll_prefixes jsonb not null default '[]'::jsonb;

comment on column public.sessions.roll_prefixes is
  'Optional list of roll prefixes offered on the join screen, e.g. ["22CS","22IT"]. Empty = free-text entry. Never used to reject a roll.';
