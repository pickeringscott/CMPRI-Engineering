-- Allow the installed location to change without unlocking verified specifications.
create or replace function public.cmpri_protect_verified_asset()
returns trigger language plpgsql set search_path = '' as $$
begin
 if old.documentation_verified_at is not null then
  if current_user = 'postgres' and new.documentation_verified_at is null
     and new.documentation_verified_by is null and new.documentation_revision_id is not null
     and (to_jsonb(new) - array['updated_at','documentation_verified_at','documentation_verified_by','documentation_revision_id'])
       = (to_jsonb(old) - array['updated_at','documentation_verified_at','documentation_verified_by','documentation_revision_id'])
     and exists(select 1 from public.cmpri_equipment_document_revisions r
       where r.id=new.documentation_revision_id and r.asset_id=old.id and r.hotel_id=old.hotel_id
       and r.closed_at is null and r.prior_asset=to_jsonb(old)) then return new; end if;
  if (to_jsonb(new)-array['updated_at','location_id']) is distinct from (to_jsonb(old)-array['updated_at','location_id']) then
   raise exception 'Verified equipment is locked against changes';
  end if;
 elsif (new.documentation_verified_at is distinct from old.documentation_verified_at
    or new.documentation_verified_by is distinct from old.documentation_verified_by
    or new.documentation_revision_id is distinct from old.documentation_revision_id) and current_user <> 'postgres' then
  raise exception 'Equipment verification must use the verification procedure';
 end if;
 return new;
end;
$$;

-- Service-only operation: lock and check both records before making either change.
create function public.cmpri_move_asset_with_order(p_hotel uuid,p_asset uuid,p_destination uuid,p_expected_asset_updated_at timestamptz,p_order uuid,p_expected_order_revision bigint,p_actor uuid,p_note text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare a public.assets; w public.work_orders; destination_name text;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
 if not exists(select 1 from public.profiles p join public.hotel_members m on m.user_id=p.id
   where p.id=p_actor and p.active and m.hotel_id=p_hotel and m.active
   and regexp_replace(lower(p.role::text),'[^a-z]','','g') in ('engineer','engineers','engineering','chiefengineer','engineeringmanager','regionalmaintenance','regionalengineer','systemadmin','sysadmin','systemadministrator','administrator','admin')) then raise exception 'Active equipment editor required'; end if;
 select * into a from public.assets where id=p_asset and hotel_id=p_hotel for update;
 if not found or p_expected_asset_updated_at is null or a.updated_at is distinct from p_expected_asset_updated_at then raise exception 'Asset changed. Reload before moving.'; end if;
 select name into destination_name from public.locations where id=p_destination and hotel_id=p_hotel and active=true;
 if destination_name is null then raise exception 'Select an active destination.'; end if;
 if a.location_id is not distinct from p_destination then raise exception 'Asset is already at that location.'; end if;
 if p_order is not null then
  select * into w from public.work_orders where id=p_order and hotel_id=p_hotel for update;
  if not found or w.asset_id is distinct from p_asset then raise exception 'The work order is not linked to this asset.'; end if;
  if p_expected_order_revision is null or w.revision is distinct from p_expected_order_revision then raise exception 'Work order changed. Reload before moving.'; end if;
  if p_note is null or length(p_note) > 4000 or length(p_note) = 0 then raise exception 'Move note is required.'; end if;
 end if;
 update public.assets set location_id=p_destination where id=p_asset and hotel_id=p_hotel;
 if p_order is not null then
  update public.work_orders set location_id=p_destination,room=destination_name,
   notes=concat_ws(E'\n', nullif(notes,''), p_note),history_actor_user_id=p_actor,history_source='CMPRI app'
   where id=p_order and hotel_id=p_hotel;
 end if;
 return jsonb_build_object('asset_id',p_asset,'location_id',p_destination,'work_order_id',p_order);
end;
$$;
revoke all on function public.cmpri_move_asset_with_order(uuid,uuid,uuid,timestamptz,uuid,bigint,uuid,text) from public,anon,authenticated;
grant execute on function public.cmpri_move_asset_with_order(uuid,uuid,uuid,timestamptz,uuid,bigint,uuid,text) to service_role;
