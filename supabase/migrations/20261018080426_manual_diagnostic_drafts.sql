-- Approved combined PO/manual diagnostics release.
-- Server routes enforce property, ticket-read, assignment and capability checks.
create table public.cmpri_manual_procedures (
 hotel_id uuid not null, asset_id uuid not null, id uuid primary key,
 source_sha256 text not null check(source_sha256 ~ '^[a-f0-9]{64}$'),
 storage_path text not null, procedure jsonb not null,
 reviewed_by uuid not null, reviewed_at timestamptz not null default now(),
 check(procedure->>'sourceSha256'=source_sha256),
 check(procedure->'review'->>'status'='approved')
);
create table public.cmpri_manual_drafts (
 hotel_id uuid not null, ticket_id uuid not null, procedure_id uuid not null references public.cmpri_manual_procedures(id),
 revision integer not null check(revision>0), draft jsonb not null,
 updated_by uuid not null, updated_at timestamptz not null default now(),
 primary key(hotel_id,ticket_id,procedure_id)
);
create table public.cmpri_manual_draft_history (
 hotel_id uuid not null, ticket_id uuid not null, procedure_id uuid not null,
 revision integer not null, draft jsonb not null, actor_id uuid not null,
 recorded_at timestamptz not null default now(),
 primary key(hotel_id,ticket_id,procedure_id,revision)
);
alter table public.cmpri_manual_procedures enable row level security;
alter table public.cmpri_manual_drafts enable row level security;
alter table public.cmpri_manual_draft_history enable row level security;
revoke all on public.cmpri_manual_procedures,public.cmpri_manual_drafts,public.cmpri_manual_draft_history from public,anon,authenticated;
grant select,insert on public.cmpri_manual_procedures to service_role;
grant select,insert,update on public.cmpri_manual_drafts to service_role;
grant select,insert on public.cmpri_manual_draft_history to service_role;
create function public.cmpri_save_manual_draft(p_hotel uuid,p_ticket uuid,p_procedure uuid,p_expected integer,p_actor uuid,p_draft jsonb)
returns integer language plpgsql security invoker set search_path=public,pg_temp as $$
declare prior public.cmpri_manual_drafts; next_revision integer;
begin
 if p_actor is null or p_expected is null or p_expected<0 or jsonb_typeof(p_draft) is distinct from 'object' then raise exception 'Invalid draft'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_hotel::text||p_ticket::text||p_procedure::text,0));
 select * into prior from cmpri_manual_drafts where hotel_id=p_hotel and ticket_id=p_ticket and procedure_id=p_procedure;
 if coalesce(prior.revision,0)<>p_expected then raise exception 'Draft changed; reload before saving'; end if;
 if prior.draft->>'status'='submitted' then raise exception 'Submitted findings are immutable'; end if;
 next_revision=p_expected+1;
 if p_draft->>'ticketId' is distinct from p_ticket::text or p_draft->>'procedureId' is distinct from p_procedure::text or (p_draft->>'revision')::integer is distinct from next_revision then raise exception 'Draft identity differs'; end if;
 if p_draft->>'status' not in ('draft','reviewed','submitted') or jsonb_typeof(p_draft->'entries') is distinct from 'array' then raise exception 'Invalid draft state'; end if;
 if p_draft->>'status'='submitted' and coalesce(prior.draft->>'status','')<>'reviewed' then raise exception 'Review findings before submission'; end if;
 if not exists(select 1 from cmpri_manual_procedures where id=p_procedure and hotel_id=p_hotel and source_sha256=p_draft->>'sourceSha256') then raise exception 'Reviewed procedure differs'; end if;
 insert into cmpri_manual_drafts values(p_hotel,p_ticket,p_procedure,next_revision,p_draft,p_actor,now())
 on conflict(hotel_id,ticket_id,procedure_id) do update set revision=excluded.revision,draft=excluded.draft,updated_by=excluded.updated_by,updated_at=excluded.updated_at;
 insert into cmpri_manual_draft_history values(p_hotel,p_ticket,p_procedure,next_revision,p_draft,p_actor,now());
 return next_revision;
end $$;
revoke all on function public.cmpri_save_manual_draft(uuid,uuid,uuid,integer,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.cmpri_save_manual_draft(uuid,uuid,uuid,integer,uuid,jsonb) to service_role;


