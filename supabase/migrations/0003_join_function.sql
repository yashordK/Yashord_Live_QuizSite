-- =====================================================================
-- Atomic join / rejoin.
--
-- Why a database function instead of doing this in the API route:
--
-- The route would have to SELECT the participant, then COUNT for the cap,
-- then INSERT. With ~200 phones hitting "Join" the moment the code goes
-- up on the projector, those three statements interleave badly:
--
--   * two requests for the SAME roll both miss the SELECT, both INSERT,
--     one hits the unique constraint and errors out — a real student
--     seeing a failure on a legitimate double-tap;
--   * N requests all COUNT 184 and all INSERT, blowing straight past the
--     cap that exists to protect the connection budget.
--
-- An advisory lock keyed on the session makes check-and-insert atomic, so
-- the cap is exact and a rejoin is always a rejoin.
-- =====================================================================

create or replace function public.join_participant(
  p_session_id   uuid,
  p_roll         text,
  p_raw_roll     text,
  p_name         text,
  p_device_token text
)
returns table (
  participant_id  uuid,
  outcome         text,   -- 'created' | 'rejoined' | 'full' | 'locked'
  device_mismatch boolean
)
language plpgsql
as $$
declare
  v_existing  public.participants%rowtype;
  v_locked    boolean;
  v_cap       int;
  v_count     int;
  v_mismatch  boolean := false;
  v_new_id    uuid;
begin
  -- Serialize all joins for this one session. Released automatically at
  -- transaction end. Different sessions never block each other.
  perform pg_advisory_xact_lock(hashtextextended(p_session_id::text, 0));

  select s.joining_locked, s.join_cap
    into v_locked, v_cap
  from public.sessions s
  where s.id = p_session_id;

  if not found then
    raise exception 'SESSION_NOT_FOUND';
  end if;

  select *
    into v_existing
  from public.participants p
  where p.session_id = p_session_id
    and p.roll_number = p_roll;

  -- ---- REJOIN -------------------------------------------------------
  -- Note this happens BEFORE the cap and lock checks, deliberately. A
  -- student who is already in must always be able to get back in, even
  -- once the session is full and joining is locked. They occupy no new
  -- seat, and their score (derived from `answers`) is untouched.
  if found then
    if v_existing.device_token is not null
       and p_device_token is not null
       and v_existing.device_token <> p_device_token then
      v_mismatch := true;
    end if;

    update public.participants p
       set name              = p_name,
           raw_roll_number   = coalesce(p_raw_roll, p.raw_roll_number),
           last_seen_at      = now(),
           is_online         = true,
           device_token      = coalesce(p_device_token, p.device_token),
           device_mismatches = p.device_mismatches + (case when v_mismatch then 1 else 0 end),
           flagged_duplicate = p.flagged_duplicate or v_mismatch
     where p.id = v_existing.id;

    return query select v_existing.id, 'rejoined'::text, v_mismatch;
    return;
  end if;

  -- ---- NEW JOINER ---------------------------------------------------
  if v_locked then
    return query select null::uuid, 'locked'::text, false;
    return;
  end if;

  select count(*) into v_count
  from public.participants p
  where p.session_id = p_session_id;

  if v_count >= v_cap then
    return query select null::uuid, 'full'::text, false;
    return;
  end if;

  insert into public.participants
    (session_id, roll_number, raw_roll_number, name, device_token)
  values
    (p_session_id, p_roll, p_raw_roll, p_name, p_device_token)
  returning id into v_new_id;

  return query select v_new_id, 'created'::text, false;
end;
$$;

-- Only the service role (which calls this from our API routes) may run it.
--
-- Order matters: revoking from PUBLIC strips EXECUTE from every role that
-- only held it via PUBLIC, service_role included. The explicit grant
-- afterwards is what keeps our own API routes working.
revoke all on function public.join_participant(uuid, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.join_participant(uuid, text, text, text, text)
  to service_role;
