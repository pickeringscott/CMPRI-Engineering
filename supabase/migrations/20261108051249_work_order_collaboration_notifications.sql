begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Abort rather than replace an independently changed notification policy.
do $preflight$ begin
 if (select md5(btrim(replace(prosrc,E'\r',''),E' \n\t')) from pg_catalog.pg_proc
     where oid=to_regprocedure('cmpri_private.materialize_work_notification()'))
    is distinct from '243648ca0417c7cf389376bead766852' then
   raise exception 'Work-order notification policy changed; review before applying this migration';
 end if;
end $preflight$;


-- Prospective events only. Existing inbox rows, explicit mentions, assignments,
-- technician views, other event types, phone schedules and subscriptions stay intact.
create function cmpri_private.work_order_notification_label(display_id text) returns text
language sql immutable set search_path='' as $$
 select case when value ~ '^[0-9]+$' then 'WO#'||value
   else coalesce(nullif(btrim(display_id),''),'Work order') end
 from (select regexp_replace(coalesce(display_id,''),
   '^@?(workorder_|WO[[:space:]]*[#-]?[[:space:]]*)','','i') as value) label
$$;
revoke all on function cmpri_private.work_order_notification_label(text) from public,anon,authenticated;

-- This private function runs under the existing trigger owner's privileges.
-- Distinct recipients prevent duplicates when one person fills multiple roles.
create function cmpri_private.notify_work_order_collaborators(
 p_hotel uuid,p_order uuid,p_key text,p_message text,p_recorded timestamptz
) returns void language sql security invoker set search_path='' as $$
 insert into public.cmpri_dashboard_notifications
   (hotel_id,recipient_user_id,notification_key,work_order_id,message,recorded_at,push_requested)
 select distinct p_hotel,p.id,p_key,p_order,left(p_message,500),p_recorded,true
 from public.work_orders w
 join public.hotel_members m on m.hotel_id=w.hotel_id and m.active
 join public.profiles p on p.id=m.user_id and p.active
 where w.hotel_id=p_hotel and w.id=p_order and (
   cmpri_private.notification_roles(p.role::text,p.secondary_roles)
     && array['chiefengineer','systemadmin','sysadmin','systemadministrator','administrator','admin']
   or p.id=coalesce(w.source_draft_created_by,w.created_by,w.submitted_by_user_id)
   or (nullif(btrim(w.technician_name),'') is not null
     and lower(btrim(p.full_name))=lower(btrim(w.technician_name)))
 )
 on conflict(hotel_id,recipient_user_id,notification_key) do nothing
$$;
revoke all on function cmpri_private.notify_work_order_collaborators(uuid,uuid,text,text,timestamptz) from public,anon,authenticated;

-- INSERT never runs this trigger: notes submitted with a new ticket are part
-- of its single creation notification, not a separate note event.
create function cmpri_private.notify_added_work_order_notes() returns trigger
language plpgsql security definer set search_path='' as $$
declare added bigint; author_name text; actor text; message text;
begin
 select count(*) into added from (
   select line from regexp_split_to_table(coalesce(new.notes,''),E'\n') line
   except all
   select line from regexp_split_to_table(coalesce(old.notes,''),E'\n') line
 ) lines where btrim(line)<>''
   and btrim(line) !~ '^CMPRI2\|[^|]*\|[^|]*\|[^|]*\|(change|system)\|'
   and btrim(line) !~ '^CMPRI\|[^|]*\|[^|]*\|(change|system)\|';
 if added=0 then return null; end if;
 actor=coalesce(nullif(current_setting('cmpri.history_actor',true),''),auth.uid()::text);
 if actor ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
   select nullif(split_part(btrim(p.full_name),' ',1),'') into author_name
   from public.profiles p join public.hotel_members m on m.user_id=p.id
   where p.id=actor::uuid and p.active and m.hotel_id=new.hotel_id and m.active;
 end if;
 message=case when added=1 then 'New note on ' else added::text||' new notes on ' end
   ||cmpri_private.work_order_notification_label(new.display_id)
   ||' ('||coalesce(nullif(btrim(new.room),''),'No location')||') by '
   ||coalesce(author_name,'a staff member')||'.';
 perform cmpri_private.notify_work_order_collaborators(new.hotel_id,new.id,
   'work-order-note:'||new.id::text||':'||new.revision::text,message,clock_timestamp());
 return null;
end $$;
revoke all on function cmpri_private.notify_added_work_order_notes() from public,anon,authenticated;
create trigger event_work_notes after update of notes on public.work_orders
for each row when(old.notes is distinct from new.notes)
execute function cmpri_private.notify_added_work_order_notes();

create or replace function cmpri_private.materialize_work_notification() returns trigger
language plpgsql security definer set search_path='' as $$
declare e jsonb=to_jsonb(new); p record; roles text[]; chief boolean; tech boolean;
 key text; message text; wid uuid; recorded timestamptz; label text; actor_role text; technician text; creator_role text; creator_name text; creator_roles text[]; creation_message text;
begin
 wid=case when tg_table_name='work_orders' then (e->>'id')::uuid else (e->>'work_order_id')::uuid end;
 recorded=coalesce((e->>'recorded_at')::timestamptz,(e->>'viewed_at')::timestamptz,(e->>'created_at')::timestamptz,now());
 -- A creation history row never creates another creation/status notification.
 if tg_table_name='cmpri_work_order_history' and e->>'event_type'='created' then return null; end if;
 if tg_table_name='cmpri_work_order_history' and e->>'event_type' in ('status_changed','closed','reopened') then
  if e->>'old_status' is not distinct from e->>'new_status' then return null; end if;
  message=cmpri_private.work_order_notification_label(e#>>'{snapshot,display_id}')
   ||' ('||coalesce(nullif(trim(e#>>'{snapshot,room}'),''),'No location')||') status changed: '
   ||coalesce(nullif(e->>'old_status',''),'—')||' → '||coalesce(nullif(e->>'new_status',''),'—')
   ||' by '||coalesce(nullif(trim(e->>'actor_name'),''),'System')||'.'
   ||case when nullif(trim(e#>>'{snapshot,issue}'),'') is not null
     then ' — '||left(trim(e#>>'{snapshot,issue}'),240) else '' end;
  perform cmpri_private.notify_work_order_collaborators((e->>'hotel_id')::uuid,wid,
   'work-order-status:'||(e->>'id'),message,recorded);
  return null;
 end if;
 if tg_table_name='work_orders' then
  label=cmpri_private.work_order_notification_label(e->>'display_id');
  if e->>'status'='Pending Verification' then
   creation_message='New '||label||' needs approval';
  elsif e->>'status'='Open' then
   select pr.role::text,pr.full_name,cmpri_private.notification_roles(pr.role::text,pr.secondary_roles)
    into creator_role,creator_name,creator_roles
    from public.profiles pr join public.hotel_members m on m.user_id=pr.id
    where pr.id=coalesce(nullif(e->>'submitted_by_user_id',''),nullif(e->>'created_by',''))::uuid
     and pr.active and m.active and m.hotel_id=(e->>'hotel_id')::uuid limit 1;
   creation_message='New '||label||' created open by '
    ||case when creator_roles && array['manager','generalmanager','gm','assistantmanager','assistantgeneralmanager','assistantgm','frontdeskmanager']
       then 'manager ' else '' end
    ||coalesce(nullif(trim(creator_name),''),nullif(trim(e->>'creator_name'),''),'a staff member');
  else
   creation_message='New '||label||' · '||coalesce(e->>'status','Created');
  end if;
  creation_message=creation_message||': '||coalesce(nullif(trim(e->>'room'),''),'No location')
   ||case when nullif(trim(e->>'issue'),'') is not null then ' — '||trim(e->>'issue') else '' end||'.';
 end if;
 for p in select distinct pr.* from public.profiles pr join public.hotel_members m on m.user_id=pr.id
 where pr.active and m.active and m.hotel_id=(e->>'hotel_id')::uuid loop
  roles=cmpri_private.notification_roles(p.role,p.secondary_roles);
  chief=roles && array['chiefengineer','systemadmin','sysadmin','systemadministrator','administrator','admin'];
  tech=not chief and roles && array['technician','maintenancetechnician'];
  if not chief and not tech then continue; end if;
  message=null; key=null;
  if tg_table_name='work_orders' then
   key='new-order:'||wid::text;
   message=creation_message;
  elsif tg_table_name='cmpri_work_order_technician_views' and chief then
   key='technician-view:'||(e->>'id');
   message=coalesce(nullif(trim(e->>'work_order_display_id'),''),'Work order')||' viewed awaiting satisfying.';
  elsif tg_table_name='cmpri_work_order_history' and (e->>'actor_user_id') is distinct from p.id::text then
   actor_role=regexp_replace(lower(coalesce(e#>>'{changed_fields,actor_role}','')),'[^a-z]','','g');
   technician=trim(coalesce(e#>>'{changed_fields,technician_name}',''));
   label=coalesce(nullif(trim(e#>>'{snapshot,display_id}'),''),'Work order');
   if chief and actor_role in ('technician','maintenancetechnician') then
    key='history:'||(e->>'id');
    if e->>'event_type' in ('status_changed','closed','reopened') and nullif(e->>'new_status','') is not null then
     message=label||' ('||coalesce(nullif(trim(e#>>'{snapshot,room}'),''),'No location')||' — '||coalesce(nullif(trim(e#>>'{snapshot,issue}'),''),'No issue details')||') status changed: '||coalesce(nullif(e->>'old_status',''),'—')||' → '||(e->>'new_status')||' by '||coalesce(nullif(trim(e->>'actor_name'),''),'System')||'.';
    elsif e->>'event_type'='claimed' then message=label||' was claimed by '||coalesce(nullif(technician,''),nullif(trim(e->>'actor_name'),''),'System')||'.'; end if;
   elsif tech then
    key=e->>'id';
    if e->>'event_type' in ('assigned','claimed') and technician<>'' and lower(technician)=lower(trim(p.full_name)) then
     message=label||case when e#>>'{changed_fields,after_close}'='true' then ' was reopened and reassigned to you.' else ' was assigned to you.' end;
    elsif e->>'event_type'='claimed' and actor_role in ('engineer','chiefengineer','systemadmin','systemadministrator','administrator','admin') then
     message=label||': Claimed by Engineer';
    end if;
   end if;
  end if;
  if message is not null then
   insert into public.cmpri_dashboard_notifications(hotel_id,recipient_user_id,notification_key,work_order_id,message,recorded_at,push_requested)
   values((e->>'hotel_id')::uuid,p.id,key,wid,left(message,500),recorded,true)
   on conflict(hotel_id,recipient_user_id,notification_key) do nothing;
  end if;
 end loop;
 return null;
end $$;

revoke all on function cmpri_private.materialize_work_notification() from public,anon,authenticated;
commit;
