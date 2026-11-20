-- FORM cloud backup schema. Run in the project's SQL editor or apply through
-- a reviewed migration. No service-role key is required by the browser app.
-- The owning account is always derived from the verified Auth JWT.

create schema if not exists form_private;
revoke all on schema form_private from public, anon;
grant usage on schema form_private to authenticated;

create table if not exists public.workout_states (
  user_id uuid primary key references auth.users (id) on delete cascade,
  revision bigint not null check (revision between 1 and 9007199254740991),
  state jsonb not null check (
    jsonb_typeof(state) = 'object'
    and state ->> 'schemaVersion' = '1'
    and jsonb_typeof(state -> 'settings') = 'object'
    and state -> 'settings' ->> 'unit' in ('kg', 'lb')
    and jsonb_typeof(state -> 'routines') = 'array'
    and jsonb_typeof(state -> 'sessions') = 'array'
    and state ? 'activeSession'
    and jsonb_typeof(state -> 'activeSession') in ('object', 'null')
    and octet_length(state::text) <= 20971520
  ),
  updated_at timestamptz not null default now()
);

alter table public.workout_states enable row level security;
revoke all on table public.workout_states from public, anon, authenticated;
grant select on table public.workout_states to authenticated;

drop policy if exists "Read own workout state" on public.workout_states;
create policy "Read own workout state"
  on public.workout_states for select to authenticated
  using ((select auth.uid()) = user_id);

-- The privileged operation is kept out of exposed schemas. The public wrapper
-- below is SECURITY INVOKER. Direct table writes remain unavailable to clients.
create or replace function form_private.save_workout_state(
  p_expected_revision bigint,
  p_state jsonb
)
returns table (revision bigint, state jsonb)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'Sign-in required' using errcode = '42501';
  end if;
  if p_expected_revision is null or p_expected_revision < 0 or p_expected_revision >= 9007199254740991 then
    raise exception 'Invalid cloud revision' using errcode = '22023';
  end if;
  if p_state is null or jsonb_typeof(p_state) <> 'object'
    or p_state ->> 'schemaVersion' is distinct from '1'
    or jsonb_typeof(p_state -> 'settings') is distinct from 'object'
    or p_state -> 'settings' ->> 'unit' is null
    or p_state -> 'settings' ->> 'unit' not in ('kg', 'lb')
    or jsonb_typeof(p_state -> 'routines') is distinct from 'array'
    or jsonb_typeof(p_state -> 'sessions') is distinct from 'array'
    or not (p_state ? 'activeSession')
    or jsonb_typeof(p_state -> 'activeSession') not in ('object', 'null')
    or octet_length(p_state::text) > 20971520 then
    raise exception 'Invalid workout backup' using errcode = '22023';
  end if;

  if p_expected_revision = 0 then
    -- Exactly one device can create the initial cloud record. A competing
    -- device receives zero rows and must fetch/merge before trying again.
    return query
      insert into public.workout_states as target (user_id, revision, state)
      values (v_user_id, 1, p_state)
      on conflict (user_id) do nothing
      returning target.revision, target.state;
  else
    return query
      update public.workout_states as target
      set state = p_state, revision = target.revision + 1, updated_at = now()
      where target.user_id = v_user_id and target.revision = p_expected_revision
      returning target.revision, target.state;
  end if;
end;
$function$;

revoke all on function form_private.save_workout_state(bigint, jsonb) from public, anon, authenticated;
grant execute on function form_private.save_workout_state(bigint, jsonb) to authenticated;

create or replace function public.save_workout_state(
  p_expected_revision bigint,
  p_state jsonb
)
returns table (revision bigint, state jsonb)
language sql
security invoker
set search_path = ''
as $function$
  select saved.revision, saved.state
  from form_private.save_workout_state(p_expected_revision, p_state) as saved;
$function$;

revoke all on function public.save_workout_state(bigint, jsonb) from public, anon, authenticated;
grant execute on function public.save_workout_state(bigint, jsonb) to authenticated;

comment on table public.workout_states is 'Private per-user FORM workout backup, protected by RLS and optimistic cloud revisions.';
comment on function public.save_workout_state(bigint, jsonb) is 'Compare-and-swap save for the authenticated user. Zero rows means stale revision; fetch and merge before retrying.';
