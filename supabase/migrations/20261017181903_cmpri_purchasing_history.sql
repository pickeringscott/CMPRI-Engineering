-- Historical observations never write to inventory, active POs, or physical receipts.
create table public.cmpri_purchasing_history_sources (
 hotel_id uuid not null, account text not null, message_id text not null,
 payload jsonb not null check(jsonb_typeof(payload)='object'),
 primary key(hotel_id,account,message_id)
);
create table public.cmpri_purchasing_history_records (
 hotel_id uuid not null, account text not null, record_key text not null,
 kind text not null, title text not null, supplier text, reference text, status text not null,
 ordered_quantity numeric, uom text,
 current_on_hand numeric check(current_on_hand is null),
 payload jsonb not null check(jsonb_typeof(payload)='object'),
 record jsonb not null check(jsonb_typeof(record)='object'),
 primary key(hotel_id,account,record_key), check(ordered_quantity is null or ordered_quantity>=0)
);
create table public.cmpri_purchasing_history_links (
 hotel_id uuid not null, account text not null, record_key text not null, message_id text not null,
 primary key(hotel_id,account,record_key,message_id),
 foreign key(hotel_id,account,record_key) references public.cmpri_purchasing_history_records,
 foreign key(hotel_id,account,message_id) references public.cmpri_purchasing_history_sources
);
create table public.cmpri_purchasing_history_batches (
 hotel_id uuid not null, account text not null, digest text not null check(digest ~ '^[a-f0-9]{64}$'),
 actor_id uuid not null, imported_at timestamptz not null default now(),
 source_count integer not null, record_count integer not null,
 primary key(hotel_id,account,digest)
);
alter table public.cmpri_purchasing_history_sources enable row level security;
alter table public.cmpri_purchasing_history_records enable row level security;
alter table public.cmpri_purchasing_history_links enable row level security;
alter table public.cmpri_purchasing_history_batches enable row level security;
revoke all on public.cmpri_purchasing_history_sources,public.cmpri_purchasing_history_records,public.cmpri_purchasing_history_links,public.cmpri_purchasing_history_batches from public,anon,authenticated;
grant select,insert on public.cmpri_purchasing_history_sources,public.cmpri_purchasing_history_records,public.cmpri_purchasing_history_links,public.cmpri_purchasing_history_batches to service_role;
grant update(payload) on public.cmpri_purchasing_history_sources to service_role;
create index cmpri_purchasing_history_kind on public.cmpri_purchasing_history_records(hotel_id,account,kind,record_key);
create function public.cmpri_import_purchasing_history(p_hotel uuid,p_actor uuid,p_account text,p_digest text,p_plan jsonb)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare s jsonb; r jsonb; prior jsonb; source_id text; n_sources integer; n_records integer;
begin
 if p_hotel is null or p_actor is null or coalesce(trim(p_account),'')='' or p_digest is null or p_digest !~ '^[a-f0-9]{64}$' or p_plan->>'version' is distinct from '1'
 or jsonb_typeof(p_plan->'sources') is distinct from 'array' or jsonb_typeof(p_plan->'records') is distinct from 'array' then raise exception 'Invalid history plan'; end if;
 n_sources=jsonb_array_length(p_plan->'sources');n_records=jsonb_array_length(p_plan->'records');
 if n_sources>25000 or n_records>50000 then raise exception 'History plan too large'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_hotel::text||p_account,0));
 for s in select value from jsonb_array_elements(p_plan->'sources') loop
  source_id=s->>'gmail_message_id';
  if source_id is null or source_id !~ '^[a-f0-9]{16}$' then raise exception 'Invalid source identity'; end if;
  select payload into prior from public.cmpri_purchasing_history_sources where hotel_id=p_hotel and account=p_account and message_id=source_id;
  if found and prior is distinct from s then
   if prior @> s then null; -- A minimal mailbox observation cannot erase richer metadata.
   elsif s @> prior then
    update public.cmpri_purchasing_history_sources set payload=s where hotel_id=p_hotel and account=p_account and message_id=source_id;
   else raise exception 'Changed source requires reconciliation: %',source_id;
   end if;
  end if;
  insert into public.cmpri_purchasing_history_sources values(p_hotel,p_account,source_id,s) on conflict do nothing;
 end loop;
 for r in select value from jsonb_array_elements(p_plan->'records') loop
  if coalesce(r->>'key','')='' or r->'currentOnHand' is distinct from 'null'::jsonb or jsonb_typeof(r->'sourceIds') is distinct from 'array' then raise exception 'Invalid historical record or stock inference'; end if;
  select record into prior from public.cmpri_purchasing_history_records where hotel_id=p_hotel and account=p_account and record_key=r->>'key';
  if found and prior is distinct from r then raise exception 'Changed historical record requires reconciliation: %',r->>'key'; end if;
  insert into public.cmpri_purchasing_history_records values(p_hotel,p_account,r->>'key',r->>'kind',r->>'title',r->>'supplier',r->>'reference',r->>'status',(r->>'orderedQuantity')::numeric,r->>'uom',null,r->'payload',r) on conflict do nothing;
  for source_id in select jsonb_array_elements_text(r->'sourceIds') loop
   insert into public.cmpri_purchasing_history_links values(p_hotel,p_account,r->>'key',source_id) on conflict do nothing;
  end loop;
 end loop;
 insert into public.cmpri_purchasing_history_batches values(p_hotel,p_account,p_digest,p_actor,now(),n_sources,n_records) on conflict do nothing;
 return jsonb_build_object('sourceCount',n_sources,'recordCount',n_records,'inventoryChanged',false,'receiptsCreated',0);
end $$;
revoke all on function public.cmpri_import_purchasing_history(uuid,uuid,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.cmpri_import_purchasing_history(uuid,uuid,text,text,jsonb) to service_role;
