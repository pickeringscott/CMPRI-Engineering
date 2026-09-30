-- Notification details for work-order history: the claimer's role (for "Claimed by Engineer"),
-- whether an assignment follows a close, and engineers taking over an assigned ticket count as a claim.

create or replace function public.cmpri_log_work_order_history()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid();
  v_hint text := nullif(current_setting('cmpri.history_actor', true), '');
  v_profile_name text;
  v_actor_name text;
  v_source text := nullif(current_setting('cmpri.history_source', true), '');
  v_old_tech text;
  v_new_tech text;
  v_actor_role text;
  v_after_close boolean;
  v_snapshot jsonb := jsonb_build_object(
    'display_id', new.display_id,
    'technician_name', new.technician_name,
    'status', new.status::text
  );
begin
  if v_actor is null and v_hint ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_actor := v_hint::uuid;
  end if;
  v_source := coalesce(v_source, case when auth.uid() is not null then 'CMPRI app' when TG_OP = 'INSERT' then 'CMPRI server' else 'Direct database change' end);
  if v_actor is null and TG_OP = 'INSERT' then
    v_actor := coalesce(new.created_by, new.submitted_by_user_id);
  end if;
  if v_actor is not null then
    select nullif(btrim(p.full_name), ''), p.role::text into v_profile_name, v_actor_role from public.profiles p where p.id = v_actor;
    if not exists (select 1 from auth.users u where u.id = v_actor) then
      v_actor := null;
    end if;
  end if;
  v_actor_name := coalesce(
    v_profile_name,
    case when TG_OP = 'INSERT' then nullif(btrim(new.creator_name), '') end,
    'System'
  );

  if TG_OP = 'INSERT' then
    insert into public.cmpri_work_order_history
      (hotel_id, work_order_id, actor_user_id, actor_name, event_type, old_status, new_status, changed_fields, snapshot, source)
    values
      (new.hotel_id, new.id, v_actor, v_actor_name, 'created', null, new.status::text, '{}'::jsonb, v_snapshot, v_source);
    return new;
  end if;

  v_old_tech := btrim(coalesce(old.technician_name, ''));
  v_new_tech := btrim(coalesce(new.technician_name, ''));
  if v_old_tech is distinct from v_new_tech then
    -- Reassigned after a close: the same save reopens it, or the last assignment/close event was a reopen.
    v_after_close := old.status::text = 'Closed' or coalesce((
      select h.event_type = 'reopened' from public.cmpri_work_order_history h
       where h.work_order_id = new.id and h.event_type in ('closed', 'reopened', 'claimed', 'assigned', 'unassigned')
       order by h.recorded_at desc limit 1
    ), false);
    insert into public.cmpri_work_order_history
      (hotel_id, work_order_id, actor_user_id, actor_name, event_type, old_status, new_status, changed_fields, snapshot, source)
    values (
      new.hotel_id, new.id, v_actor, v_actor_name,
      case
        when v_new_tech = '' then 'unassigned'
        when v_profile_name is not null and lower(v_new_tech) = lower(v_profile_name) then 'claimed'
        else 'assigned'
      end,
      new.status::text, new.status::text,
      jsonb_build_object('technician_name', v_new_tech, 'previous_technician_name', v_old_tech, 'actor_role', coalesce(v_actor_role, ''), 'after_close', v_after_close),
      v_snapshot, v_source
    );
  end if;

  if old.status is distinct from new.status then
    insert into public.cmpri_work_order_history
      (hotel_id, work_order_id, actor_user_id, actor_name, event_type, old_status, new_status, changed_fields, snapshot, source)
    values (
      new.hotel_id, new.id, v_actor, v_actor_name,
      case
        when old.status::text = 'Closed' then 'reopened'
        when new.status::text = 'Closed' then 'closed'
        else 'status_changed'
      end,
      old.status::text, new.status::text,
      jsonb_build_object('status', new.status::text),
      v_snapshot, v_source
    );
  end if;
  return new;
end;
$$;

revoke all on function public.cmpri_log_work_order_history() from public, anon, authenticated;
