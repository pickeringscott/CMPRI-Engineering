-- Service-only commit of a validated ticket update and its explicit mention alerts.
-- No historical notification backfill and no changes to Staff Notes.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create function public.cmpri_save_mentioned_work_order(
  p_hotel uuid, p_id uuid, p_actor uuid, p_revision integer,
  p_update jsonb, p_recipients uuid[], p_open_only boolean default false
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_before public.work_orders;
  v_next public.work_orders;
  v_saved public.work_orders;
  v_author text;
  v_label text;
  v_assignments text;
  v_affected bigint;
begin
  if jsonb_typeof(p_update) is distinct from 'object'
    or not (p_update ? 'notes')
    or p_update->>'history_actor_user_id' is distinct from p_actor::text
    or exists (select 1 from jsonb_object_keys(p_update) k where k not in (
      'issue','location_id','room','asset_id','asset_name','category','priority','technician_name','status','notes',
      'action_root_cause','parts','cost','hours','due_by','history_actor_user_id','history_source'
    )) then raise exception 'Invalid mentioned work-order update'; end if;
  select split_part(btrim(p.full_name), ' ', 1) into v_author
    from public.profiles p join public.hotel_members m on m.user_id=p.id
    where p.id=p_actor and p.active and m.hotel_id=p_hotel and m.active;
  if not found then raise exception 'Active hotel membership is required'; end if;
  select * into v_before from public.work_orders
    where hotel_id=p_hotel and id=p_id for update;
  if not found or v_before.revision <> p_revision
    or (p_open_only and v_before.status not in ('Open','In Progress')) then return null; end if;
  select * into v_next from jsonb_populate_record(v_before, p_update);
  select string_agg(format('%I = ($1).%I', k, k), ', ') into v_assignments
    from jsonb_object_keys(p_update) k;
  execute format('update public.work_orders set %s where hotel_id=$2 and id=$3 and revision=$4 returning *', v_assignments)
    into v_saved using v_next, p_hotel, p_id, p_revision;
  get diagnostics v_affected = row_count;
  if v_affected <> 1 then return null; end if;
  v_label := regexp_replace(coalesce(v_saved.display_id,''), '^@?(workorder_|WO[[:space:]]*[#-]?[[:space:]]*)', '', 'i');
  v_label := case when v_label ~ '^[0-9]+$' then 'WO#'||v_label else coalesce(nullif(v_saved.display_id,''),'Work order') end;
  insert into public.cmpri_dashboard_notifications
    (hotel_id,recipient_user_id,notification_key,work_order_id,target_path,message,recorded_at,push_requested)
    select distinct p_hotel,p.id,'work-order-mention:'||p_id::text||':'||v_saved.revision::text,
      p_id,null,
      coalesce(nullif(v_author,''),'A staff member')||' mentioned you in '||v_label||' notes.',
      clock_timestamp(),true
    from public.profiles p join public.hotel_members m on m.user_id=p.id and m.hotel_id=p_hotel
    where p.id=any(p_recipients) and p.id<>p_actor and p.active and m.active
      and coalesce(p.preferences->'notifications'->>'mentions','true') <> 'false'
    on conflict(hotel_id,recipient_user_id,notification_key) do nothing;
  return to_jsonb(v_saved);
end;
$$;
revoke all on function public.cmpri_save_mentioned_work_order(uuid,uuid,uuid,integer,jsonb,uuid[],boolean) from public,anon,authenticated;
grant execute on function public.cmpri_save_mentioned_work_order(uuid,uuid,uuid,integer,jsonb,uuid[],boolean) to service_role;
commit;
