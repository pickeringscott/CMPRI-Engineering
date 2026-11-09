begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- This helper is only called from the existing private notification trigger.
-- Keep note recipients unchanged: status events have their own audience.
create function cmpri_private.notify_work_order_status_team(
 p_hotel uuid,p_order uuid,p_key text,p_message text,p_recorded timestamptz
) returns void language sql security invoker set search_path='' as $$
 insert into public.cmpri_dashboard_notifications
   (hotel_id,recipient_user_id,notification_key,work_order_id,message,recorded_at,push_requested)
 select distinct p_hotel,p.id,p_key,p_order,left(p_message,500),p_recorded,true
 from public.hotel_members m join public.profiles p on p.id=m.user_id
 where m.hotel_id=p_hotel and m.active and p.active
   and cmpri_private.notification_roles(p.role::text,p.secondary_roles)
     && array['chiefengineer','technician','maintenancetechnician']
 on conflict(hotel_id,recipient_user_id,notification_key) do nothing
$$;
revoke all on function cmpri_private.notify_work_order_status_team(uuid,uuid,text,text,timestamptz) from public,anon,authenticated;

-- Change only the status branch, and refuse to replace independent policy edits.
do $patch$
declare definition text; source_hash text;
 marker text := 'perform cmpri_private.notify_work_order_collaborators((e->>''hotel_id'')::uuid,wid,' || E'\n' ||
               '   ''work-order-status:''||(e->>''id''),message,recorded);';
 replacement text := 'perform cmpri_private.notify_work_order_status_team((e->>''hotel_id'')::uuid,wid,' || E'\n' ||
                    '   ''work-order-status:''||(e->>''id''),message,recorded);';
begin
 select md5(btrim(replace(p.prosrc,E'\r',''),E' \n\t')),pg_get_functiondef(p.oid)
 into source_hash,definition from pg_catalog.pg_proc p
 where p.oid=to_regprocedure('cmpri_private.materialize_work_notification()');
 if source_hash is distinct from '38482eb457ed2d6137be05c1c3cad604' or position(marker in definition)=0 then
   raise exception 'Work-order notification policy changed; review before applying status recipient migration';
 end if;
 execute replace(definition,marker,replacement);
end $patch$;
commit;
