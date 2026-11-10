-- Notify the Chief Engineer, technicians, and General Manager roles only when
-- Room Ranker changes a ticket from its base priority to automatic Urgent.
create function cmpri_private.notify_room_ranker_urgent() returns trigger
language plpgsql security definer set search_path='' as $$
declare
  event_id uuid := gen_random_uuid();
  room_label text;
  ticket_label text;
  message text;
begin
  if old.ranker_auto_urgent is true or new.ranker_auto_urgent is not true or new.priority is distinct from 'Urgent' then
    return new;
  end if;

  select coalesce(nullif(btrim(l.room_number),''), nullif(btrim(l.name),''))
    into room_label
    from public.locations l
   where l.hotel_id=new.hotel_id and l.id=new.location_id;
  room_label := coalesce(nullif(btrim(new.room),''), room_label, 'Unknown room');
  ticket_label := coalesce(nullif(btrim(new.display_id),''), 'Work order');
  message := left('Room '||room_label||' · '||ticket_label||' was escalated to Urgent by Room Ranker.'
    ||case when nullif(btrim(new.issue),'') is not null then ' '||btrim(new.issue) else '' end, 500);

  insert into public.cmpri_dashboard_notifications
    (hotel_id,recipient_user_id,notification_key,target_path,message,recorded_at,push_requested)
  select distinct new.hotel_id,p.id,'room-rank-urgent:'||event_id::text,
    '/engineering/room-ranking',message,clock_timestamp(),true
    from public.profiles p
    join public.hotel_members m on m.user_id=p.id and m.hotel_id=new.hotel_id
   where p.active and m.active
     and exists (
       select 1
         from unnest(array[p.role::text]||coalesce(p.secondary_roles,array[]::text[])) assigned(role_name)
         cross join lateral regexp_split_to_table(assigned.role_name,'\\s*(/|\\+|,|&|\\mand\\M)\\s*','i') part(role_name)
        where regexp_replace(lower(part.role_name),'[^a-z0-9]','','g') = any(array[
          'engineer','engineers','engineering','chiefengineer','engineeringmanager','regionalmaintenance','regionalengineer',
          'systemadmin','sysadmin','systemadministrator','administrator','admin',
          'technician','maintenancetechnician',
          'manager','generalmanager','gm'
        ]::text[])
     )
  on conflict (hotel_id,recipient_user_id,notification_key) do nothing;

  return new;
end $$;
revoke all on function cmpri_private.notify_room_ranker_urgent() from public,anon,authenticated;

create trigger room_ranker_urgent_notifications
after update of priority,ranker_auto_urgent on public.work_orders
for each row
when (old.ranker_auto_urgent is distinct from new.ranker_auto_urgent and new.ranker_auto_urgent is true)
execute function cmpri_private.notify_room_ranker_urgent();
