create or replace function public.cmpri_import_po_order(p_hotel uuid,p_actor uuid,p_order jsonb)
returns uuid language plpgsql security invoker set search_path=public,pg_temp as $$
declare oid uuid; src jsonb; ln jsonb; shipment record; existing public.cmpri_po_orders; oldline public.cmpri_po_lines; oldship public.cmpri_po_shipments;
begin
 if p_actor is null or p_hotel is null or coalesce(p_order->>'externalPo','')='' or jsonb_typeof(p_order->'lines') is distinct from 'array' or jsonb_typeof(p_order->'evidence') is distinct from 'array' then raise exception 'Invalid reviewed PO'; end if;
 if coalesce(p_order->>'supplier','')='' or (jsonb_array_length(p_order->'lines')=0 and not coalesce((p_order->>'cancelled')::boolean,false)) then
  if not exists(select 1 from jsonb_array_elements(p_order->'evidence') e where e->>'kind'='company-accepted' and e->>'externalPo'=p_order->>'externalPo' and not coalesce((e->>'incomplete')::boolean,false)) then raise exception 'Exact accepted PO evidence required for unresolved details'; end if;
  if coalesce(p_order->>'supplier','')='' then p_order=jsonb_set(p_order,'{supplier}','"Supplier unresolved"'::jsonb); end if;
 end if;
 if jsonb_array_length(p_order->'lines')<>(select count(distinct l->>'sku') from jsonb_array_elements(p_order->'lines') l) then raise exception 'Duplicate source SKU requires review'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_hotel::text||':'||(p_order->>'externalPo'),0));
 select * into existing from public.cmpri_po_orders where hotel_id=p_hotel and origin='ibuy' and external_reference=p_order->>'externalPo' for update;
 if found then
  if existing.supplier<>p_order->>'supplier' and existing.supplier<>'Supplier unresolved' and p_order->>'supplier'<>'Supplier unresolved' then raise exception 'Supplier conflict'; end if;oid=existing.id;
  if existing.supplier='Supplier unresolved' and p_order->>'supplier'<>'Supplier unresolved' then update public.cmpri_po_orders set supplier=p_order->>'supplier' where id=oid; end if;
  if jsonb_array_length(p_order->'lines')>0 and exists(select 1 from public.cmpri_po_lines where hotel_id=p_hotel and order_id=oid) and (select count(*) from public.cmpri_po_lines where hotel_id=p_hotel and order_id=oid)<>jsonb_array_length(p_order->'lines') then raise exception 'Changed line snapshot requires review'; end if;
 else
  oid=gen_random_uuid();insert into public.cmpri_po_orders(id,hotel_id,external_reference,supplier,origin,created_by) values(oid,p_hotel,p_order->>'externalPo',p_order->>'supplier','ibuy',p_actor);
 end if;
 for ln in select * from jsonb_array_elements(p_order->'lines') loop
  if coalesce(ln->>'sku','')='' or coalesce(ln->>'description','')='' or coalesce(ln->>'uom','')='' or ((ln->>'quantity')::numeric<=0 or (ln->>'quantity')::numeric<>round((ln->>'quantity')::numeric,3) or ln->>'quantity' in ('NaN','Infinity','-Infinity')) then raise exception 'Invalid source line'; end if;
  select * into oldline from public.cmpri_po_lines where hotel_id=p_hotel and order_id=oid and sku=ln->>'sku';
  if found then
   if oldline.ordered<>(ln->>'quantity')::numeric or oldline.uom<>ln->>'uom' or oldline.description<>ln->>'description' or oldline.purchase_unit_price_cents is distinct from (ln->>'unitPriceCents')::bigint then raise exception 'Changed line snapshot requires review'; end if;
  else
   insert into public.cmpri_po_lines(hotel_id,order_id,description,sku,ordered,uom,purchase_unit_price_cents) values(p_hotel,oid,ln->>'description',ln->>'sku',(ln->>'quantity')::numeric,ln->>'uom',(ln->>'unitPriceCents')::bigint);
  end if;
 end loop;
 for src in select * from jsonb_array_elements(p_order->'evidence') loop
  if exists(select 1 from public.cmpri_po_sources where hotel_id=p_hotel and account=src->>'account' and message_id=src->>'messageId' and (order_id<>oid or source_note<>src::text)) then raise exception 'Source reference conflicts with previous import'; end if;
  insert into public.cmpri_po_sources(hotel_id,order_id,account,message_id,kind,source_note,review_status) values(p_hotel,oid,src->>'account',src->>'messageId',src->>'kind',src::text,case when jsonb_array_length(p_order->'lines')=0 then 'identity-verified-details-unresolved' else 'verified-extraction' end) on conflict(hotel_id,account,message_id) do nothing;
 end loop;
 if (p_order->>'accepted')::boolean and exists(select 1 from jsonb_array_elements(p_order->'evidence') e where e->>'kind'='company-accepted' and e->>'externalPo'=p_order->>'externalPo') then update public.cmpri_po_orders set acceptance='accepted',acceptance_note='Verified company-accepted source',accepted_by=p_actor,accepted_at=coalesce(accepted_at,now()) where id=oid; end if;
 if coalesce((p_order->>'cancelled')::boolean,false) then update public.cmpri_po_orders set cancelled=true where id=oid; end if;
 update public.cmpri_po_orders set supplier_order_refs=array(select distinct ref from (select unnest(supplier_order_refs) ref union select jsonb_array_elements_text(p_order->'vendorOrders')) refs) where id=oid;
 for shipment in select key,value from jsonb_each(p_order->'shipments') loop
  select * into oldship from public.cmpri_po_shipments where hotel_id=p_hotel and order_id=oid and supplier_shipment_id=shipment.key;
  if found and oldship.lines<>shipment.value->'lines' then raise exception 'Changed shipment snapshot requires review'; end if;
  insert into public.cmpri_po_shipments(hotel_id,order_id,supplier_shipment_id,carrier,tracking,tracking_url,ship_date,eta,lines) values(p_hotel,oid,shipment.key,shipment.value->>'carrier',shipment.value->>'tracking',shipment.value->>'trackingUrl',nullif(shipment.value->>'shippedDate','')::date,shipment.value->>'eta',shipment.value->'lines') on conflict(hotel_id,order_id,supplier_shipment_id) do nothing;
 end loop;
 return oid;
end $$;
