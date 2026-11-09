-- No existing assets, verification markers, or files are changed by this migration.
create table public.cmpri_equipment_document_revisions (
 id uuid primary key default gen_random_uuid(),
 hotel_id uuid not null,
 asset_id uuid not null references public.assets(id),
 actor_id uuid not null references public.profiles(id),
 reason text not null check (char_length(trim(reason)) between 5 and 2000),
 prior_asset jsonb not null,
 prior_documents jsonb not null,
 opened_at timestamptz not null default clock_timestamp(),
 closed_at timestamptz,
 verified_asset jsonb
);
create unique index cmpri_equipment_one_open_revision on public.cmpri_equipment_document_revisions(asset_id) where closed_at is null;
alter table public.cmpri_equipment_document_revisions enable row level security;
revoke all on public.cmpri_equipment_document_revisions from public, anon, authenticated, service_role;
grant select on public.cmpri_equipment_document_revisions to service_role;
alter table public.assets add column documentation_revision_id uuid references public.cmpri_equipment_document_revisions(id);

create or replace function public.cmpri_protect_verified_asset()
returns trigger language plpgsql set search_path = '' as $$
begin
 if old.documentation_verified_at is not null then
  -- Only the atomic revision procedure can transition a locked snapshot to review.
  if current_user = 'postgres' and new.documentation_verified_at is null
     and new.documentation_verified_by is null and new.documentation_revision_id is not null
     and (to_jsonb(new) - array['updated_at','documentation_verified_at','documentation_verified_by','documentation_revision_id'])
       = (to_jsonb(old) - array['updated_at','documentation_verified_at','documentation_verified_by','documentation_revision_id'])
     and exists(select 1 from public.cmpri_equipment_document_revisions r
       where r.id=new.documentation_revision_id and r.asset_id=old.id and r.hotel_id=old.hotel_id
       and r.closed_at is null and r.prior_asset=to_jsonb(old)) then return new; end if;
  if (to_jsonb(new)-'updated_at') is distinct from (to_jsonb(old)-'updated_at') then
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

create function public.cmpri_begin_equipment_revision(p_asset_id uuid,p_hotel_id uuid,p_expected_updated_at timestamptz,p_actor_id uuid,p_reason text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare a public.assets; revision_id uuid; documents jsonb;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
 if p_expected_updated_at is null or p_reason is null or char_length(trim(p_reason)) not between 5 and 2000 then raise exception 'A current record and revision reason are required'; end if;
 if not exists(select 1 from public.profiles p join public.hotel_members m on m.user_id=p.id
   where p.id=p_actor_id and p.active and m.hotel_id=p_hotel_id and m.active
   and regexp_replace(lower(p.role::text),'[^a-z]','','g') in
    ('engineer','engineers','engineering','chiefengineer','engineeringmanager','regionalmaintenance','regionalengineer','systemadmin','sysadmin','systemadministrator','administrator','admin')) then
  raise exception 'Active equipment editor required';
 end if;
 select * into a from public.assets where id=p_asset_id and hotel_id=p_hotel_id for update;
 if not found or a.updated_at is distinct from p_expected_updated_at or a.documentation_verified_at is null or a.documentation_revision_id is not null then
  raise exception 'Verified equipment changed; reload before revising';
 end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',o.id,'name',o.name,'metadata',o.metadata,'created_at',o.created_at)), '[]'::jsonb)
 into documents from storage.objects o where o.bucket_id='asset-documentation' and o.name like p_hotel_id::text||'/'||p_asset_id::text||'/%';
 insert into public.cmpri_equipment_document_revisions(hotel_id,asset_id,actor_id,reason,prior_asset,prior_documents)
 values(p_hotel_id,p_asset_id,p_actor_id,trim(p_reason),to_jsonb(a),documents) returning id into revision_id;
 update public.assets set documentation_verified_at=null,documentation_verified_by=null,documentation_revision_id=revision_id
 where id=p_asset_id and hotel_id=p_hotel_id;
 return revision_id;
end;
$$;
revoke all on function public.cmpri_begin_equipment_revision(uuid,uuid,timestamptz,uuid,text) from public,anon,authenticated;
grant execute on function public.cmpri_begin_equipment_revision(uuid,uuid,timestamptz,uuid,text) to service_role;

create or replace function public.cmpri_verify_asset_documentation(p_asset_id uuid,p_hotel_id uuid,p_expected_updated_at timestamptz,p_actor_id uuid)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare a public.assets; verified_at timestamptz;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
 if p_asset_id is null or p_hotel_id is null or p_expected_updated_at is null or p_actor_id is null then raise exception 'Complete equipment verification details are required'; end if;
 select * into a from public.assets where id=p_asset_id and hotel_id=p_hotel_id for update;
 if not found then raise exception 'Equipment not found'; end if;
 if a.documentation_verified_at is not null then return a.documentation_verified_at; end if;
 if a.updated_at is distinct from p_expected_updated_at then raise exception 'Equipment changed during documentation verification'; end if;
 update public.assets set documentation_verified_at=clock_timestamp(), documentation_verified_by=p_actor_id,documentation_revision_id=null
 where id=p_asset_id and hotel_id=p_hotel_id returning documentation_verified_at into verified_at;
 if a.documentation_revision_id is not null then
  update public.cmpri_equipment_document_revisions set closed_at=verified_at,
   verified_asset=(select to_jsonb(current_asset) from public.assets current_asset where id=p_asset_id)
  where id=a.documentation_revision_id and closed_at is null;
 end if;
 return verified_at;
end;
$$;

revoke all on function public.cmpri_verify_asset_documentation(uuid,uuid,timestamptz,uuid) from public,anon,authenticated;
grant execute on function public.cmpri_verify_asset_documentation(uuid,uuid,timestamptz,uuid) to service_role;
