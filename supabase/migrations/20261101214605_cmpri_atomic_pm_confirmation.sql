-- REVIEW DRAFT: additive RPC; apply only to isolated test storage at this stage.
-- No table/role policy changes. Existing service role remains the sole caller.
begin;
create or replace function public.cmpri_confirm_pm_work_order(p_hotel uuid, p_guard jsonb, p_order jsonb)
returns jsonb language plpgsql security invoker set search_path = ''
set lock_timeout = '2s' set statement_timeout = '5s' as $$
declare actual jsonb; props jsonb; rooms jsonb; saved public.work_orders%rowtype; input public.work_orders%rowtype;
begin
  if current_user <> 'service_role' then raise exception 'Server-only PM confirmation' using errcode='42501'; end if;
  if p_hotel is null or p_guard is null or p_order is null
    or p_order->>'hotel_id' is distinct from p_hotel::text
    or p_order->>'import_source' is distinct from 'PM Log'
    or coalesce(p_order->>'import_external_id','') = '' then
    raise exception 'Invalid PM confirmation' using errcode='22023';
  end if;
  -- Short SHARE locks prevent ordinary edits/deletes and phantom overlapping
  -- inserts, including writers that do not know about this RPC. No network work
  -- occurs inside this transaction. Consistent lock order matches history import.
  lock table public.cmpri_pm_proposals in share mode;
  lock table public.cmpri_room_pm_history in share mode;
  if p_guard->>'kind' = 'proposal' then
    select jsonb_build_object('id',id,'template_id',template_id,'period_start',period_start,
      'scope_key',scope_key,'payload',payload,'revision',revision,'status',status,'submitted_by',submitted_by)
      into actual from public.cmpri_pm_proposals where hotel_id=p_hotel and id=(p_guard->'record'->>'id')::uuid;
    if actual is distinct from p_guard->'record' then
      raise exception 'PM inspection changed; reopen and review before confirming' using errcode='40001';
    end if;
  elsif p_guard->>'kind' = 'recorded' then
    select coalesce(jsonb_agg(jsonb_build_object('id',id,'template_id',template_id,'period_start',period_start,
      'scope_key',scope_key,'payload',payload,'revision',revision,'status',status,'submitted_by',submitted_by) order by id),'[]')
      into props from public.cmpri_pm_proposals where hotel_id=p_hotel and status <> 'rejected'
      and template_id=p_guard->>'template' and period_start=(p_guard->>'period')::date and scope_key=p_guard->>'scope';
    select coalesce(jsonb_agg(jsonb_build_object('room',room,'period_start',period_start,'completed_on',completed_on,'item_answers',item_answers) order by room,period_start),'[]')
      into rooms from public.cmpri_room_pm_history where hotel_id=p_hotel and 'room:'||room=p_guard->>'scope' and period_start=(p_guard->>'period')::date;
    if props is distinct from p_guard->'proposals' or rooms is distinct from p_guard->'rooms' then
      raise exception 'Recorded PM sources changed; reload and review before confirming' using errcode='40001';
    end if;
  else raise exception 'Invalid PM source guard' using errcode='22023'; end if;
  -- Serialize same identity before checking it. The existing unique index also
  -- protects against older callers. This does not merge different issues.
  perform pg_advisory_xact_lock(hashtextextended(p_hotel::text||':pm-order:'||(p_order->>'import_external_id'),0));
  select * into saved from public.work_orders where hotel_id=p_hotel and import_source='PM Log' and import_external_id=p_order->>'import_external_id';
  if found then return jsonb_build_object('work_orders',jsonb_build_array(jsonb_build_object('id',saved.id,'display_id',saved.display_id,'status',saved.status)),'reused',true); end if;
  input := jsonb_populate_record(null::public.work_orders,p_order);
  insert into public.work_orders(hotel_id,location_id,room,asset_id,asset_name,category,issue,priority,notes,
    created_by,creator_account_user_id,creator_name,submitted_by_name,creator_source,status,submitted_by_user_id,
    technician_name,action_root_cause,parts,cost,hours,import_source,import_external_id)
  values(p_hotel,input.location_id,input.room,input.asset_id,coalesce(input.asset_name,''),coalesce(input.category,'General'),input.issue,coalesce(input.priority,'Medium'),coalesce(input.notes,''),
    input.created_by,input.creator_account_user_id,input.creator_name,input.submitted_by_name,input.creator_source,input.status,input.submitted_by_user_id,
    input.technician_name,input.action_root_cause,input.parts,input.cost,input.hours,'PM Log',input.import_external_id)
  returning * into saved;
  return jsonb_build_object('work_orders',jsonb_build_array(jsonb_build_object('id',saved.id,'display_id',saved.display_id,'status',saved.status)),'reused',false);
end $$;
revoke all on function public.cmpri_confirm_pm_work_order(uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.cmpri_confirm_pm_work_order(uuid,jsonb,jsonb) to service_role;
commit;
