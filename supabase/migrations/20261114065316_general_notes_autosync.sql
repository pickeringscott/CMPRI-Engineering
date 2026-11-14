begin;
set local lock_timeout='5s';
create table public.cmpri_general_notes (
 hotel_id uuid not null references public.hotels(id),
 user_id uuid not null references public.profiles(id) on delete cascade,
 id uuid not null,
 document jsonb,
 title text generated always as (document->>'title') stored,
 revision bigint not null check(revision>0),
 change_id uuid not null,
 updated_at timestamptz not null default clock_timestamp(),
 deleted_at timestamptz,
 primary key(hotel_id,user_id,id),
 check ((document is null)=(deleted_at is not null)),
 check (document is null or coalesce((jsonb_typeof(document)='object' and octet_length(document::text)<=2097152
   and length(btrim(document->>'title')) between 1 and 120
   and jsonb_typeof(document->'text')='string' and length(document->>'text')<=100000
   and jsonb_typeof(document->'strokes')='array' and jsonb_array_length(document->'strokes')<=5000
   and (document->>'fontSize')::integer in(8,10,12,14,16,18,20,22,24)),false))
);
create index cmpri_general_notes_owner_recent on public.cmpri_general_notes(user_id,hotel_id,updated_at desc);
alter table public.cmpri_general_notes enable row level security;
revoke all on public.cmpri_general_notes from public,anon,authenticated;
grant select on public.cmpri_general_notes to authenticated;
grant all on public.cmpri_general_notes to service_role;
create policy own_general_notes_read on public.cmpri_general_notes for select to authenticated
 using(user_id=(select auth.uid()) and cmpri_private.active_signal_member(hotel_id));
-- All mutations go through a service-only, revision-checked function. Authentication
-- supplies both owner fields; ordinary clients cannot impersonate p_actor.
create function public.cmpri_save_general_note(p_hotel uuid,p_actor uuid,p_id uuid,p_expected bigint,p_change uuid,p_document jsonb)
returns public.cmpri_general_notes language plpgsql security invoker set search_path='' as $$
declare previous public.cmpri_general_notes;result public.cmpri_general_notes;
begin
 if not exists(select 1 from public.profiles p join public.hotel_members m on m.user_id=p.id
   where p.id=p_actor and p.active and m.hotel_id=p_hotel and m.active) then raise exception 'Inactive member' using errcode='42501';end if;
 -- Serialize this owner's creates as well as updates; bound active notes to 500.
 perform pg_advisory_xact_lock(hashtextextended(p_hotel::text||p_actor::text,0));
 select * into previous from public.cmpri_general_notes where hotel_id=p_hotel and user_id=p_actor and id=p_id for update;
 if found then
   if previous.change_id=p_change then
     if previous.document is distinct from p_document then raise exception 'Mutation identity reused' using errcode='22023';end if;
     return previous;
   end if;
   if p_expected is distinct from previous.revision or previous.deleted_at is not null then raise exception 'Note changed elsewhere' using errcode='40001';end if;
   -- Unchanged content does not generate a revision, write, or realtime event.
   if previous.document is not distinct from p_document then return previous;end if;
   update public.cmpri_general_notes set document=p_document,revision=previous.revision+1,change_id=p_change,
     updated_at=clock_timestamp(),deleted_at=case when p_document is null then clock_timestamp() else null end
     where hotel_id=p_hotel and user_id=p_actor and id=p_id returning * into result;
 else
   if p_expected is not null or p_document is null then raise exception 'Note changed elsewhere' using errcode='40001';end if;
   if (select count(*) from public.cmpri_general_notes where hotel_id=p_hotel and user_id=p_actor and deleted_at is null)>=500 then raise exception 'Notebook is full' using errcode='54000';end if;
   insert into public.cmpri_general_notes(hotel_id,user_id,id,document,revision,change_id)
     values(p_hotel,p_actor,p_id,p_document,1,p_change) returning * into result;
 end if;
 return result;
end $$;
revoke all on function public.cmpri_save_general_note(uuid,uuid,uuid,bigint,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.cmpri_save_general_note(uuid,uuid,uuid,bigint,uuid,jsonb) to service_role;
-- Tombstones use UPDATE, so private deletion events retain filterable owner fields.
do $$begin
 if exists(select 1 from pg_publication where pubname='supabase_realtime') then
   alter publication supabase_realtime add table public.cmpri_general_notes;
 end if;
end $$;
notify pgrst,'reload schema';
commit;
