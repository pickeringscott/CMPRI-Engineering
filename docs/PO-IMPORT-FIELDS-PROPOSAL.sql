-- REVIEW ONLY. Not applied. No historical UPDATE/backfill.
-- Legacy sku remains the exact source identity for replay; supplier_sku is the semantic identifier.
-- Raw source columns and source_note document remain unchanged.
alter table public.cmpri_po_lines add column if not exists source_item_number text;
alter table public.cmpri_po_lines add column if not exists source_description text;
alter table public.cmpri_po_lines add column if not exists product_url text;
alter table public.cmpri_po_lines add column if not exists supplier_sku text;
-- Recovery of existing iBuy orders only. No header, receipt, stock or mapping updates.
create or replace function public.cmpri_recover_offline_po_lines_v2(p_hotel uuid,p_actor uuid,p_document jsonb)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare o public.cmpri_po_orders; oldline public.cmpri_po_lines; ln jsonb;
 doc_order jsonb:=p_document->'order'; source_key text; prior public.cmpri_po_sources;
 added integer:=0; oldcount integer; total numeric;
begin
 if p_hotel is null or p_actor is null or coalesce(p_document->>'account','')='' or coalesce(p_document->>'sourceMessageId','')='' or
 coalesce(p_document->>'documentSha256','')!~'^[a-f0-9]{64}$' or coalesce(p_document->>'sourceUrlSha256','')!~'^[a-f0-9]{64}$' or
 coalesce(p_document->>'sourceUrl','')!~'^https://www[.]ibuyefficient[.]com/webhook/getemailpotransmission[?]' or
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
 source_key=(p_document->>'sourceMessageId')||':offline-pdf:'||(p_document->>'sourceUrlSha256');
 perform pg_advisory_xact_lock(hashtextextended(p_hotel::text||':'||(p_document->>'account')||':'||source_key,1));
 select * into prior from public.cmpri_po_sources where hotel_id=p_hotel and account=p_document->>'account' and message_id=source_key;
 if found and (prior.order_id is distinct from o.id or prior.document_sha256 is distinct from p_document->>'documentSha256' or
 (prior.source_note::jsonb)->'document' is distinct from p_document) then raise exception 'Recovery source identity conflict'; end if;
 if (select count(*)<>count(distinct sku) from public.cmpri_po_lines where hotel_id=p_hotel and order_id=o.id) then raise exception 'Existing duplicate item identity requires review'; end if;
 -- The PDF must include every existing line unchanged, even for partial records.
 for oldline in select * from public.cmpri_po_lines where hotel_id=p_hotel and order_id=o.id for update loop
  select value into ln from jsonb_array_elements(doc_order->'lines') where value->>'sku'=oldline.sku;
  if not found or coalesce(oldline.source_description,oldline.description) is distinct from ln->>'description' or oldline.uom is distinct from ln->>'uom' or
  oldline.ordered is distinct from (ln->>'quantity')::numeric or oldline.purchase_unit_price_cents is distinct from (ln->>'unitPriceCents')::bigint
  then raise exception 'Existing line differs from document'; end if;
 end loop;
 total=0;
 for ln in select value from jsonb_array_elements(doc_order->'lines') loop
  if coalesce(trim(ln->>'sku'),'')='' or coalesce(trim(ln->>'description'),'')='' or coalesce(trim(ln->>'uom'),'')='' or
  coalesce(ln->>'quantity','')!~'^[0-9]+([.][0-9]{1,3})?$' or (ln->>'quantity')::numeric<=0 or
  coalesce(ln->>'unitPriceCents','')!~'^[0-9]+$' then raise exception 'Invalid recovery line'; end if;
  if ln->>'description' ~* '^https?://' and (ln->>'description' !~ '^https://[^/@:[:space:]]+([/?#][^[:space:]]*)?$' or ln->>'sku' !~ '[[:alpha:]]{2}' or ln->>'sku' !~ '[[:space:]]') then raise exception 'Product name or URL requires source review'; end if;
  if trim(ln->>'sku') ~* '^https?://' then raise exception 'Source item identifier contains a URL; source review required'; end if;
  total=total+round((ln->>'quantity')::numeric*(ln->>'unitPriceCents')::numeric);
 end loop;
 if total is distinct from (doc_order->>'subtotalCents')::numeric then raise exception 'Document subtotal conflict'; end if;
 select count(*) into oldcount from public.cmpri_po_lines where hotel_id=p_hotel and order_id=o.id;
 for ln in select value from jsonb_array_elements(doc_order->'lines') loop
  if not exists(select 1 from public.cmpri_po_lines where hotel_id=p_hotel and order_id=o.id and sku=ln->>'sku') then
   insert into public.cmpri_po_lines(hotel_id,order_id,description,sku,ordered,uom,purchase_unit_price_cents,source_item_number,source_description,product_url,supplier_sku)
   values(p_hotel,o.id,case when ln->>'description' ~* '^https?://' then ln->>'sku' else ln->>'description' end,ln->>'sku',(ln->>'quantity')::numeric,ln->>'uom',(ln->>'unitPriceCents')::bigint,ln->>'sku',ln->>'description',case when ln->>'description' ~* '^https?://' then ln->>'description' end,case when ln->>'description' !~* '^https?://' then ln->>'sku' end);
   added=added+1;
  end if;
 end loop;
 insert into public.cmpri_po_sources(hotel_id,order_id,account,message_id,kind,document_sha256,source_note,review_status)
 values(p_hotel,o.id,p_document->>'account',source_key,'offline-pdf-recovery',p_document->>'documentSha256',
 jsonb_build_object('document',p_document,'recoveredBy',p_actor)::text,'verified-extraction')
 on conflict(hotel_id,account,message_id) do nothing;
 return jsonb_build_object('orderId',o.id,'insertedLines',added,'existingLines',oldcount,'inventoryChanged',false,'receiptsCreated',0);
end $$;
revoke all on function public.cmpri_recover_offline_po_lines_v2(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.cmpri_recover_offline_po_lines_v2(uuid,uuid,jsonb) to service_role;
