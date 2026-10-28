-- Immutable source evidence only: no completion, response, template or work-order writes.
create table public.cmpri_pm_source_evidence (
  hotel_id uuid not null, source_id text not null, source_name text not null,
  page_count integer not null check(page_count between 1 and 1000),
  pages jsonb not null check(jsonb_typeof(pages)='array'),
  import_digest text not null, confirmed_by uuid not null,
  confirmed_by_name text not null, confirmed_at timestamptz not null default now(),
  primary key(hotel_id, source_id),
  check(jsonb_array_length(pages)=page_count)
);
alter table public.cmpri_pm_source_evidence enable row level security;
revoke all on public.cmpri_pm_source_evidence from public, anon, authenticated;
grant select, insert on public.cmpri_pm_source_evidence to service_role;

create function public.cmpri_import_pm_source_evidence(
 p_hotel uuid,p_actor uuid,p_actor_name text,p_input jsonb,p_digest text,p_apply boolean,p_expected text default null
) returns jsonb language plpgsql security invoker set search_path=public as $$
declare h public.cmpri_pm_source_evidence%rowtype; action text := 'insert'; token text; total integer; r jsonb;
begin
 if p_hotel is null or p_actor is null or p_actor_name is null or p_apply is null
 or p_digest is null or p_digest !~ '^[a-f0-9]{64}$'
 or coalesce(length(trim(p_input->>'sourceId')),0) not between 1 and 160
 or coalesce(length(trim(p_input->>'sourceName')),0) not between 1 and 300
 or jsonb_typeof(p_input->'pages') is distinct from 'array' then raise exception 'Invalid PM source'; end if;
 total := (p_input->>'pageCount')::integer;
 if total is null or total not between 1 and 1000 or jsonb_array_length(p_input->'pages')<>total then raise exception 'Account for every source page'; end if;
 if (select count(distinct (x->>'page')::integer) from jsonb_array_elements(p_input->'pages') x where (x->>'page')::integer between 1 and total)<>total then raise exception 'Duplicate or missing source pages'; end if;
 for r in select value from jsonb_array_elements(p_input->'pages') loop
  if r ?| array['isComplete','completedOn','responses','createWorkOrder'] then raise exception 'Source evidence cannot change completion or checklist answers'; end if;
  if coalesce(r->>'kind','') not in ('blank-template','observations','room-history-reference') then raise exception 'Invalid source classification'; end if;
 end loop;
 perform pg_advisory_xact_lock(hashtextextended('pm-source:'||p_hotel::text||':'||(p_input->>'sourceId'),0));
 select * into h from public.cmpri_pm_source_evidence where hotel_id=p_hotel and source_id=p_input->>'sourceId';
 if found then
  if h.pages=p_input->'pages' and h.source_name=p_input->>'sourceName' and h.page_count=total then action:='skip'; else action:='conflict'; end if;
 end if;
 token:=md5(p_digest||action);
 if p_apply then
  if action='conflict' then raise exception 'Existing source evidence differs; nothing overwritten'; end if;
  if action='insert' and p_expected is distinct from token then raise exception 'Source changed; preview again'; end if;
  if action='insert' then
   insert into public.cmpri_pm_source_evidence(hotel_id,source_id,source_name,page_count,pages,import_digest,confirmed_by,confirmed_by_name)
   values(p_hotel,p_input->>'sourceId',p_input->>'sourceName',total,p_input->'pages',p_digest,p_actor,p_actor_name);
  end if;
 end if;
 return jsonb_build_object('action',action,'pageCount',total,'previewDigest',token,'applied',p_apply,'inserted',case when p_apply and action='insert' then total else 0 end,'skipped',case when action='skip' then total else 0 end);
end;
$$;
revoke all on function public.cmpri_import_pm_source_evidence(uuid,uuid,text,jsonb,text,boolean,text) from public,anon,authenticated;
grant execute on function public.cmpri_import_pm_source_evidence(uuid,uuid,text,jsonb,text,boolean,text) to service_role;
