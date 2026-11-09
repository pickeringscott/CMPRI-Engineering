-- Folder-scoped event intake. No public/client grants.
create table public.cmpri_drive_po_state (
 folder_id text primary key check(folder_id='18V2KjCHw2o0uQCVFzu2GGxJ9PghGS7AD'),
 enabled boolean not null default false,
 lease_owner uuid, lease_until timestamptz,
 last_run_at timestamptz, last_result jsonb, last_error text
);
insert into public.cmpri_drive_po_state(folder_id) values('18V2KjCHw2o0uQCVFzu2GGxJ9PghGS7AD');
create table public.cmpri_drive_po_channels (
 id uuid primary key, folder_id text not null references public.cmpri_drive_po_state,
 resource_id text, expires_at timestamptz not null,
 status text not null check(status in ('pending','active','failed','stopped')),
 sync_received_at timestamptz, created_at timestamptz not null default now()
);
create table public.cmpri_drive_po_events (
 channel_id uuid not null references public.cmpri_drive_po_channels,
 message_number text not null check(message_number ~ '^[0-9]{1,20}$'),
 state text not null, received_at timestamptz not null default now(), processed_at timestamptz,
 primary key(channel_id,message_number)
);
create index cmpri_drive_po_pending on public.cmpri_drive_po_events(received_at) where processed_at is null;
create table public.cmpri_drive_po_files (
 file_id text primary key, folder_id text not null references public.cmpri_drive_po_state,
 version text not null, document_sha256 text, metadata jsonb not null,
 document jsonb, external_po text, reason text, updated_at timestamptz not null default now()
);
alter table public.cmpri_drive_po_state enable row level security;
alter table public.cmpri_drive_po_channels enable row level security;
alter table public.cmpri_drive_po_events enable row level security;
alter table public.cmpri_drive_po_files enable row level security;
revoke all on public.cmpri_drive_po_state,public.cmpri_drive_po_channels,public.cmpri_drive_po_events,public.cmpri_drive_po_files from public,anon,authenticated;
grant select,insert,update on public.cmpri_drive_po_state,public.cmpri_drive_po_channels,public.cmpri_drive_po_events,public.cmpri_drive_po_files to service_role;
create function public.cmpri_claim_drive_po(p_owner uuid) returns boolean
language plpgsql security invoker set search_path=public,pg_temp as $$
begin
 update public.cmpri_drive_po_state set lease_owner=p_owner,lease_until=now()+interval '6 minutes'
 where folder_id='18V2KjCHw2o0uQCVFzu2GGxJ9PghGS7AD' and enabled and (lease_until is null or lease_until<now());
 return found;
end $$;
revoke all on function public.cmpri_claim_drive_po(uuid) from public,anon,authenticated;
grant execute on function public.cmpri_claim_drive_po(uuid) to service_role;

-- Recovery of existing iBuy orders only. No header, receipt, stock or mapping updates.
create or replace function public.cmpri_recover_drive_po_lines(p_hotel uuid,p_actor uuid,p_document jsonb)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare o public.cmpri_po_orders; oldline public.cmpri_po_lines; ln jsonb;
 doc_order jsonb:=p_document->'order'; source_key text; prior public.cmpri_po_sources;
 added integer:=0; oldcount integer; total numeric;
begin
 if p_hotel is null or p_actor is null or coalesce(p_document->>'account','')='' or coalesce(p_document->>'sourceMessageId','')='' or
 coalesce(p_document->>'documentSha256','')!~'^[a-f0-9]{64}$' or coalesce(p_document->>'sourceUrlSha256','')!~'^[a-f0-9]{64}$' or
 p_hotel is distinct from 'c81ad01a-7a9f-4880-ac1c-5e849f30bad6'::uuid or p_actor is distinct from '750f77bf-7d5d-4ca6-8421-e025edea87ba'::uuid or p_document->>'account' is distinct from 'maint.cmpri@hawkeyehotels.com' or p_document->>'folderId' is distinct from '18V2KjCHw2o0uQCVFzu2GGxJ9PghGS7AD' or coalesce(p_document->>'fileId','')!~'^[A-Za-z0-9_-]+$' or p_document->>'sourceUrl' is distinct from ('https://drive.google.com/file/d/'||(p_document->>'fileId')||'/view') or
 coalesce(doc_order->>'externalPo','')!~'^[0-9]+$' or jsonb_typeof(doc_order->'lines') is distinct from 'array'
 then raise exception 'Invalid bound recovery document'; end if;
 if jsonb_array_length(doc_order->'lines')=0 or jsonb_array_length(doc_order->'lines')>1000 or
 jsonb_array_length(doc_order->'lines')<>(select count(distinct l->>'sku') from jsonb_array_elements(doc_order->'lines') l)
 then raise exception 'Complete distinct document lines required'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_hotel::text||':'||(doc_order->>'externalPo'),0));
 if (select count(*) from public.cmpri_po_orders where hotel_id=p_hotel and origin='ibuy' and external_reference=doc_order->>'externalPo')<>1 then raise exception 'Existing exact iBuy PO required'; end if;
 select * into o from public.cmpri_po_orders where hotel_id=p_hotel and origin='ibuy' and external_reference=doc_order->>'externalPo' for update;
 if not found then raise exception 'Existing exact iBuy PO required'; end if;
 if o.supplier not in ('Supplier unresolved','OFFLINE SUPPLIER') and o.supplier is distinct from doc_order->>'supplier' then raise exception 'Supplier conflict'; end if;
 source_key='drive-pdf:'||(p_document->>'fileId')||':'||(p_document->>'documentSha256');
 perform pg_advisory_xact_lock(hashtextextended(p_hotel::text||':'||(p_document->>'account')||':'||source_key,1));
 select * into prior from public.cmpri_po_sources where hotel_id=p_hotel and account=p_document->>'account' and message_id=source_key;
 if found and (prior.order_id is distinct from o.id or prior.document_sha256 is distinct from p_document->>'documentSha256' or
 (prior.source_note::jsonb)->'document' is distinct from p_document) then raise exception 'Recovery source identity conflict'; end if;
 if (select count(*)<>count(distinct sku) from public.cmpri_po_lines where hotel_id=p_hotel and order_id=o.id) then raise exception 'Existing duplicate item identity requires review'; end if;
 -- The PDF must include every existing line unchanged, even for partial records.
 for oldline in select * from public.cmpri_po_lines where hotel_id=p_hotel and order_id=o.id for update loop
  select value into ln from jsonb_array_elements(doc_order->'lines') where value->>'sku'=oldline.sku;
  if not found or oldline.description is distinct from ln->>'description' or oldline.uom is distinct from ln->>'uom' or
  oldline.ordered is distinct from (ln->>'quantity')::numeric or oldline.purchase_unit_price_cents is distinct from (ln->>'unitPriceCents')::bigint
  then raise exception 'Existing line differs from document'; end if;
 end loop;
 total=0;
 for ln in select value from jsonb_array_elements(doc_order->'lines') loop
  if coalesce(trim(ln->>'sku'),'')='' or coalesce(trim(ln->>'description'),'')='' or coalesce(trim(ln->>'uom'),'')='' or
  coalesce(ln->>'quantity','')!~'^[0-9]+([.][0-9]{1,3})?$' or (ln->>'quantity')::numeric<=0 or
  coalesce(ln->>'unitPriceCents','')!~'^[0-9]+$' then raise exception 'Invalid recovery line'; end if;
  total=total+round((ln->>'quantity')::numeric*(ln->>'unitPriceCents')::numeric);
 end loop;
 if total is distinct from (doc_order->>'subtotalCents')::numeric then raise exception 'Document subtotal conflict'; end if;
 select count(*) into oldcount from public.cmpri_po_lines where hotel_id=p_hotel and order_id=o.id;
 for ln in select value from jsonb_array_elements(doc_order->'lines') loop
  if not exists(select 1 from public.cmpri_po_lines where hotel_id=p_hotel and order_id=o.id and sku=ln->>'sku') then
   insert into public.cmpri_po_lines(hotel_id,order_id,description,sku,ordered,uom,purchase_unit_price_cents)
   values(p_hotel,o.id,ln->>'description',ln->>'sku',(ln->>'quantity')::numeric,ln->>'uom',(ln->>'unitPriceCents')::bigint);
   added=added+1;
  end if;
 end loop;
 insert into public.cmpri_po_sources(hotel_id,order_id,account,message_id,kind,document_sha256,source_note,review_status)
 values(p_hotel,o.id,p_document->>'account',source_key,'drive-pdf-recovery',p_document->>'documentSha256',
 jsonb_build_object('document',p_document,'recoveredBy',p_actor)::text,'verified-extraction')
 on conflict(hotel_id,account,message_id) do nothing;
 return jsonb_build_object('orderId',o.id,'insertedLines',added,'existingLines',oldcount,'inventoryChanged',false,'receiptsCreated',0);
end $$;
revoke all on function public.cmpri_recover_drive_po_lines(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.cmpri_recover_drive_po_lines(uuid,uuid,jsonb) to service_role;
