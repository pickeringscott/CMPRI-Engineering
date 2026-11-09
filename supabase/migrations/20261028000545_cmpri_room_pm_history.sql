-- Additive, server-only history. No template, role, or existing record changes.
create table public.cmpri_room_pm_history (
  hotel_id uuid not null,
  room text not null check (room ~ '^[0-9]{2,4}$'),
  period_start date not null check (extract(day from period_start)=1 and extract(month from period_start) in (1,4,7,10)),
  completed_on date,
  source_id text not null,
  source_name text not null,
  source_reference text not null,
  import_digest text not null,
  confirmed_by uuid not null,
  confirmed_by_name text not null,
  confirmed_at timestamptz not null default now(),
  primary key (hotel_id, room, period_start),
  check (completed_on is null or (completed_on >= period_start and completed_on < period_start + interval '3 months'))
);
alter table public.cmpri_room_pm_history enable row level security;
revoke all on public.cmpri_room_pm_history from public, anon, authenticated;
grant select, insert on public.cmpri_room_pm_history to service_role;

create function public.cmpri_import_room_pm_history(
  p_hotel uuid, p_actor uuid, p_actor_name text, p_input jsonb,
  p_digest text, p_apply boolean, p_expected text default null
) returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  r jsonb; h public.cmpri_room_pm_history%rowtype;
  v_period date; v_date date; v_action text; v_reason text;
  v_plan jsonb := '[]'; v_token text; v_conflicts integer := 0;
  v_inserted integer := 0; v_skipped integer := 0;
begin
  if p_hotel is null or p_actor is null or p_actor_name is null or p_apply is null
    or p_digest !~ '^[a-f0-9]{64}$'
    or jsonb_typeof(p_input->'rows') is distinct from 'array'
    or jsonb_array_length(p_input->'rows') not between 1 and 2000
    or coalesce(length(trim(p_input->>'sourceId')),0) not between 1 and 160
    or coalesce(length(trim(p_input->>'sourceName')),0) not between 1 and 300 then
    raise exception 'Invalid historical PM import';
  end if;
  if exists(select 1 from jsonb_array_elements(p_input->'rows') x group by x->>'room',x->>'periodStart' having count(*)>1) then
    raise exception 'Duplicate room-quarter in import';
  end if;
  -- Serialize conflict checks with ordinary proposal writes and other imports.
  lock table public.cmpri_pm_proposals in share row exclusive mode;
  perform pg_advisory_xact_lock(hashtextextended('pm-history:' || p_hotel::text, 0));
  for r in select value from jsonb_array_elements(p_input->'rows') order by value->>'periodStart',value->>'room' loop
    if coalesce(r->>'room','') !~ '^[0-9]{2,4}$'
      or coalesce(r->>'periodStart','') !~ '^20[0-9]{2}-(01|04|07|10)-01$'
      or not (r ? 'completedOn')
      or coalesce(length(trim(r->>'sourceReference')),0) not between 1 and 1000 then
      raise exception 'Invalid historical room-quarter';
    end if;
    v_period := (r->>'periodStart')::date;
    v_date := (r->>'completedOn')::date;
    if v_date is not null and (v_date < v_period or v_date >= v_period + interval '3 months') then
      raise exception 'Completion date is outside intended quarter';
    end if;
    select * into h from public.cmpri_room_pm_history where hotel_id=p_hotel and room=r->>'room' and period_start=v_period;
    v_action := 'insert'; v_reason := '';
    if found then
      if h.completed_on is not distinct from v_date and h.source_id=p_input->>'sourceId'
        and h.source_name=p_input->>'sourceName' and h.source_reference=r->>'sourceReference' then
        v_action := 'skip'; v_skipped := v_skipped+1;
      else
        v_action := 'conflict'; v_reason := 'Historical completion already exists with different date or provenance.';
      end if;
    elsif exists(select 1 from public.cmpri_pm_proposals where hotel_id=p_hotel
      and template_id='pdf:room-pm-checklist' and scope_key='room:'||(r->>'room')
      and period_start=v_period and status <> 'rejected') then
      v_action := 'conflict'; v_reason := 'An existing PM proposal or approved record needs reconciliation.';
    end if;
    if v_action='conflict' then v_conflicts:=v_conflicts+1; end if;
    v_plan := v_plan || jsonb_build_array(r || jsonb_build_object('action',v_action,'reason',v_reason));
  end loop;
  v_token := md5(p_digest || v_plan::text);
  if p_apply then
    -- A wholly identical retry is safe even when the original preview said insert.
    if v_conflicts>0 then raise exception 'Import conflicts with existing history; nothing imported'; end if;
    if v_skipped <> jsonb_array_length(p_input->'rows') and p_expected is distinct from v_token then
      raise exception 'Import or existing records changed; preview again';
    end if;
    for r in select value from jsonb_array_elements(v_plan) where value->>'action'='insert' loop
      insert into public.cmpri_room_pm_history(hotel_id,room,period_start,completed_on,source_id,source_name,source_reference,import_digest,confirmed_by,confirmed_by_name)
      values(p_hotel,r->>'room',(r->>'periodStart')::date,(r->>'completedOn')::date,p_input->>'sourceId',p_input->>'sourceName',r->>'sourceReference',p_digest,p_actor,p_actor_name);
      v_inserted := v_inserted+1;
    end loop;
  end if;
  return jsonb_build_object('rows',v_plan,'previewDigest',v_token,'conflicts',v_conflicts,'inserted',v_inserted,'skipped',v_skipped,'applied',p_apply);
end;
$$;
revoke all on function public.cmpri_import_room_pm_history(uuid,uuid,text,jsonb,text,boolean,text) from public,anon,authenticated;
grant execute on function public.cmpri_import_room_pm_history(uuid,uuid,text,jsonb,text,boolean,text) to service_role;
