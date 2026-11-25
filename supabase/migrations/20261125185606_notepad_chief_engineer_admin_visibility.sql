create or replace function cmpri_private.notepad_can_read(p_hotel uuid,p_actor uuid,p_owner uuid,p_document jsonb) returns boolean
language sql stable security invoker set search_path='' as $$
 select exists(select 1 from public.profiles p join public.hotel_members m on m.user_id=p.id
 where p.id=p_actor and p.active and m.hotel_id=p_hotel and m.active and
 (p_actor=p_owner or p_document->'audience'->'all'='true'::jsonb
 or (p_document->'audience'->'people') ? p_actor::text
 or exists(select 1 from unnest(cmpri_private.notepad_role_keys(p.role::text,p.secondary_roles)) r where (p_document->'audience'->'roles') ? r
   or (r = 'system_admin' and (p_document->'audience'->'roles') ? 'engineer'))));
$$;
revoke all on function cmpri_private.notepad_can_read(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function cmpri_private.notepad_can_read(uuid,uuid,uuid,jsonb) to service_role;
