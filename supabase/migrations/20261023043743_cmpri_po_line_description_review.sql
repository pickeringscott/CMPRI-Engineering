-- Approved PO item correction and source-aware future offline imports; no historical backfill.
create function public.cmpri_po_edit_item(p_hotel uuid,p_actor uuid,p_id uuid,p_line uuid,p_description text,p_expected_description text,p_expected_item uuid,p_expected_factor numeric,p_item uuid,p_create boolean,p_unit text,p_factor numeric,p_expected_received numeric,p_keep boolean default false)
returns uuid language plpgsql security invoker set search_path=public,pg_temp as $$
declare l public.cmpri_po_lines; item public.cmpri_inventory_items; prior public.cmpri_po_package_operations; request_body jsonb; remap boolean; old_item public.cmpri_inventory_items; received numeric; stock numeric; receipt_ids jsonb; audit_note text;
begin
 if p_actor is null or p_id is null or nullif(btrim(p_description),'') is null or length(p_description)>1000 or p_create is null then raise exception 'Invalid item edit'; end if;
 request_body=jsonb_build_object('action','edit-item','line',p_line,'description',btrim(p_description),'expectedDescription',p_expected_description,'expectedItem',p_expected_item,'expectedFactor',p_expected_factor,'item',p_item,'create',p_create,'unit',p_unit,'factor',p_factor,'expectedReceived',p_expected_received,'keepMapping',p_keep);
 perform pg_advisory_xact_lock(hashtextextended(p_id::text,0));
 select * into prior from public.cmpri_po_package_operations where id=p_id;
 if found then
  if prior.hotel_id=p_hotel and prior.actor_id=p_actor and prior.request=request_body then return prior.line_id; end if;
  raise exception 'Item edit key already used for different details';
 end if;
 select * into l from public.cmpri_po_lines where id=p_line and hotel_id=p_hotel for update;
 if not found then raise exception 'Order line not found'; end if;
 if l.description is distinct from p_expected_description or l.inventory_item_id is distinct from p_expected_item or (not p_keep and coalesce(p_expected_received,0)=0 and l.units_per_order_unit is distinct from p_expected_factor) then raise exception using errcode='40001',message='Item changed. Reload before editing.'; end if;
 perform 1 from public.cmpri_po_orders where id=l.order_id and hotel_id=p_hotel and not cancelled for share;
 if not found then raise exception 'Active order required'; end if;
 remap:=not p_keep and (p_create or l.inventory_item_id is distinct from p_item or l.units_per_order_unit is distinct from p_factor);
 if remap then
  if p_factor is null or p_factor<=0 or p_factor>999999999 or p_factor::text in ('NaN','Infinity','-Infinity') then raise exception 'Invalid mapping factor'; end if;
  select coalesce(sum(quantity),0),coalesce(sum(stock_quantity),0),jsonb_agg(id order by id) into received,stock,receipt_ids from public.cmpri_po_receipts where hotel_id=p_hotel and line_id=p_line;
  if received is distinct from p_expected_received then raise exception using errcode='40001',message='Received quantity changed. Reload before correcting inventory.'; end if;
  perform 1 from public.cmpri_inventory_items where hotel_id=p_hotel and id in(l.inventory_item_id,p_item) order by id for update;
  if received>0 then
   select * into old_item from public.cmpri_inventory_items where id=l.inventory_item_id and hotel_id=p_hotel;
   if not found then raise exception 'Received item correction must preserve the inventory unit and conversion'; end if;
   if exists(select 1 from public.cmpri_supply_uses where hotel_id=p_hotel and inventory_item_id=old_item.id)
    or exists(select 1 from public.cmpri_inventory_movements where hotel_id=p_hotel and inventory_item_id=old_item.id and (movement_type in ('Use','Return') or (movement_type='Adjustment' and quantity_change<0))) then raise exception 'Usage or returns or prior stock adjustments exist for this inventory item. Review consumed stock before transferring; name-only editing is still available.'; end if;
   if old_item.quantity_on_hand-stock<old_item.quantity_reserved then raise exception 'Insufficient unreserved stock for the received-item correction'; end if;
  end if;
  if received=0 and p_factor<>round(p_factor,3) then raise exception 'Mapping factor supports three decimal places'; end if;
  if p_create then
   if p_item is not null or p_unit is null or p_unit not in ('EA','PKG','BOX','CS','LB','OZ','G','KG') then raise exception 'Select a valid inventory unit'; end if;
   perform pg_advisory_xact_lock(hashtextextended(p_hotel::text||lower(btrim(p_description)),1));
   if exists(select 1 from public.cmpri_inventory_items where hotel_id=p_hotel and lower(btrim(item_name))=lower(btrim(p_description))) then raise exception 'Select the existing inventory item explicitly'; end if;
   -- Supplier is intentionally not required. Catalog creation never receives stock.
   insert into public.cmpri_inventory_items(hotel_id,item_name,name,unit_of_measure,quantity_on_hand,created_by,sku)
    values(p_hotel,btrim(p_description),btrim(p_description),p_unit,0,p_actor,l.sku) returning * into item;
  else
   select * into item from public.cmpri_inventory_items where id=p_item and hotel_id=p_hotel and active for update;
   if not found then raise exception 'Select an active inventory item in this property'; end if;
  end if;
  if received>0 then
   if item.id=old_item.id then raise exception 'Received conversion cannot change'; end if;
   if item.unit_of_measure is distinct from old_item.unit_of_measure then raise exception 'Received item correction requires the same inventory unit'; end if;
   audit_note=jsonb_build_object('action','PO item correction','operation',p_id,'line',p_line,'receipts',receipt_ids,'fromItem',old_item.id,'toItem',item.id,'stockQuantity',stock,'unit',old_item.unit_of_measure,'reason','Corrected inventory attribution; original receipts and dates retained')::text;
   update public.cmpri_inventory_items set quantity_on_hand=quantity_on_hand-stock where id=old_item.id and hotel_id=p_hotel;
   update public.cmpri_inventory_items set quantity_on_hand=quantity_on_hand+stock where id=item.id and hotel_id=p_hotel;
   insert into public.cmpri_inventory_movements(id,hotel_id,inventory_item_id,movement_type,quantity_change,performed_by_user_id,notes)
    values(md5(p_id::text||':out')::uuid,p_hotel,old_item.id,'Adjustment',-stock,p_actor,audit_note),(md5(p_id::text||':in')::uuid,p_hotel,item.id,'Adjustment',stock,p_actor,audit_note);
   update public.cmpri_po_lines set inventory_item_id=item.id where id=p_line and hotel_id=p_hotel;
  else
  update public.cmpri_po_lines set inventory_item_id=item.id,units_per_order_unit=p_factor,conversion_numerator=null,conversion_denominator=null,package_size=null,content_unit=null where id=p_line and hotel_id=p_hotel;
  end if;
 end if;
 update public.cmpri_po_lines set description=btrim(p_description) where id=p_line and hotel_id=p_hotel;
 insert into public.cmpri_po_package_operations values(p_id,p_hotel,p_actor,request_body,p_line);
 return p_line;
end $$;
revoke all on function public.cmpri_po_edit_item(uuid,uuid,uuid,uuid,text,text,uuid,numeric,uuid,boolean,text,numeric,numeric,boolean) from public,anon,authenticated;
grant execute on function public.cmpri_po_edit_item(uuid,uuid,uuid,uuid,text,text,uuid,numeric,uuid,boolean,text,numeric,numeric,boolean) to service_role;

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
