-- Additive receiving ledger. No historical purchases or opening balances are migrated.
create table public.cmpri_po_orders (
 id uuid primary key default gen_random_uuid(), hotel_id uuid not null,
 external_reference text, supplier text not null check (length(trim(supplier))>0),
 origin text not null check(origin in ('manual','ibuy')),
 acceptance text not null default 'unresolved' check(acceptance in ('unresolved','submitted','accepted')),
 cancelled boolean not null default false, acceptance_note text, accepted_by uuid, accepted_at timestamptz,
 created_by uuid not null, created_at timestamptz not null default now(),
 unique(hotel_id,id), check(external_reference is null or length(trim(external_reference))>0)
);
create unique index cmpri_po_supplier_reference on public.cmpri_po_orders(hotel_id,lower(supplier),lower(external_reference)) where external_reference is not null;
create table public.cmpri_po_lines (
 id uuid primary key default gen_random_uuid(), hotel_id uuid not null, order_id uuid not null,
 description text not null check(length(trim(description))>0), sku text not null default '',
 ordered numeric(12,3) not null check(ordered>0), uom text not null,
 inventory_item_id uuid references public.cmpri_inventory_items(id),
 units_per_order_unit numeric(12,3) check(units_per_order_unit>0),
 backordered numeric(12,3) not null default 0 check(backordered>=0), backorder_note text,
 unique(hotel_id,id), foreign key(hotel_id,order_id) references public.cmpri_po_orders(hotel_id,id),
 check(backordered<=ordered)
);
create table public.cmpri_po_sources (
 id uuid primary key default gen_random_uuid(), hotel_id uuid not null, order_id uuid,
 account text not null, message_id text not null, kind text not null,
 document_sha256 text, source_note text not null, review_status text not null default 'needs-review',
 created_at timestamptz not null default now(), unique(hotel_id,account,message_id),
 foreign key(hotel_id,order_id) references public.cmpri_po_orders(hotel_id,id)
);
create table public.cmpri_po_shipments (
 id uuid primary key default gen_random_uuid(), hotel_id uuid not null, order_id uuid not null,
 supplier_shipment_id text not null, carrier text, tracking text, tracking_url text,
 ship_date date, eta text, lines jsonb not null default '[]',
 unique(hotel_id,order_id,supplier_shipment_id),
 foreign key(hotel_id,order_id) references public.cmpri_po_orders(hotel_id,id)
);
create table public.cmpri_po_receipts (
 id uuid primary key, hotel_id uuid not null, line_id uuid not null,
 quantity numeric(12,3) not null check(quantity>0), stock_quantity numeric(12,3) not null check(stock_quantity>0),
 received_date date not null, note text not null check(length(trim(note))>0), actor_id uuid not null,
 created_at timestamptz not null default now(), foreign key(hotel_id,line_id) references public.cmpri_po_lines(hotel_id,id)
);
create table public.cmpri_supply_uses (
 id uuid primary key, hotel_id uuid not null, work_order_id uuid not null references public.work_orders(id),
 inventory_item_id uuid not null references public.cmpri_inventory_items(id), quantity numeric(12,3) not null check(quantity>0),
 note text not null check(length(trim(note))>0), actor_id uuid not null,
 -- Cost intentionally unknown until the approved costing basis is configured.
 unit_cost numeric(12,2), costing_basis text, created_at timestamptz not null default now()
);
create index cmpri_po_lines_order on public.cmpri_po_lines(hotel_id,order_id);
create index cmpri_po_receipts_line on public.cmpri_po_receipts(hotel_id,line_id);
create index cmpri_supply_uses_job on public.cmpri_supply_uses(hotel_id,work_order_id);
-- Server routes enforce CMPRI capability and property scope. No direct browser access.
alter table public.cmpri_po_orders enable row level security;
alter table public.cmpri_po_lines enable row level security;
alter table public.cmpri_po_sources enable row level security;
alter table public.cmpri_po_shipments enable row level security;
alter table public.cmpri_po_receipts enable row level security;
alter table public.cmpri_supply_uses enable row level security;
revoke all on public.cmpri_po_orders,public.cmpri_po_lines,public.cmpri_po_sources,public.cmpri_po_shipments,public.cmpri_po_receipts,public.cmpri_supply_uses from anon,authenticated;
grant select,insert,update on public.cmpri_po_orders,public.cmpri_po_lines,public.cmpri_po_sources,public.cmpri_po_shipments,public.cmpri_po_receipts,public.cmpri_supply_uses to service_role;

create function public.cmpri_receive_po(p_hotel uuid,p_actor uuid,p_id uuid,p_line uuid,p_quantity numeric,p_date date,p_note text)
returns uuid language plpgsql security invoker set search_path=public,pg_temp as $$
declare l public.cmpri_po_lines; o public.cmpri_po_orders; prior public.cmpri_po_receipts; item public.cmpri_inventory_items; already numeric; delta numeric;
begin
 if p_actor is null or p_id is null or p_quantity is null or p_quantity<=0 or p_quantity<>round(p_quantity,3) or p_quantity::text in ('NaN','Infinity','-Infinity') or p_date is null or coalesce(trim(p_note),'')='' then raise exception 'Invalid physical receipt'; end if;
 -- Serialize both line total and replay key, including replays across different lines.
 perform pg_advisory_xact_lock(hashtextextended(p_id::text,0));
 select * into prior from public.cmpri_po_receipts where id=p_id;
 if found then
  if prior.hotel_id=p_hotel and prior.line_id=p_line and prior.quantity=p_quantity and prior.received_date=p_date and prior.note=trim(p_note) and prior.actor_id=p_actor then return p_id; end if;
  raise exception 'Receipt key already used for different details';
 end if;
 select * into l from public.cmpri_po_lines where hotel_id=p_hotel and id=p_line for update;
 if not found then raise exception 'Order line not found'; end if;
 select * into o from public.cmpri_po_orders where hotel_id=p_hotel and id=l.order_id for share;
 if o.cancelled then raise exception 'Cancelled order cannot receive'; end if;
 if o.acceptance is distinct from 'accepted' then raise exception 'Company acceptance required'; end if;
 if l.inventory_item_id is null or l.units_per_order_unit is null then raise exception 'Reviewed inventory and UOM mapping required'; end if;
 select * into item from public.cmpri_inventory_items where hotel_id=p_hotel and id=l.inventory_item_id and active=true for update;
 if not found then raise exception 'Active inventory item not found in this property'; end if;
 select coalesce(sum(quantity),0) into already from public.cmpri_po_receipts where hotel_id=p_hotel and line_id=p_line;
 if p_quantity+already>l.ordered then raise exception 'Receipt exceeds outstanding quantity'; end if;
 delta=p_quantity*l.units_per_order_unit;
 if delta<>round(delta,3) then raise exception 'Stock conversion exceeds supported precision'; end if;
 insert into public.cmpri_po_receipts values(p_id,p_hotel,p_line,p_quantity,delta,p_date,trim(p_note),p_actor,now());
 update public.cmpri_inventory_items set quantity_on_hand=quantity_on_hand+delta where id=item.id;
 insert into public.cmpri_inventory_movements(id,hotel_id,inventory_item_id,movement_type,quantity_change,performed_by_user_id,notes) values(p_id,p_hotel,item.id,'Receipt',delta,p_actor,trim(p_note));
 return p_id;
end $$;
create function public.cmpri_use_supply(p_hotel uuid,p_actor uuid,p_id uuid,p_job uuid,p_item uuid,p_quantity numeric,p_note text)
returns uuid language plpgsql security invoker set search_path=public,pg_temp as $$
declare prior public.cmpri_supply_uses; item public.cmpri_inventory_items;
begin
 if p_actor is null or p_id is null or p_quantity is null or p_quantity<=0 or p_quantity<>round(p_quantity,3) or p_quantity::text in ('NaN','Infinity','-Infinity') or coalesce(trim(p_note),'')='' then raise exception 'Invalid supply usage'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_id::text,0));
 select * into prior from public.cmpri_supply_uses where id=p_id;
 if found then
  if prior.hotel_id=p_hotel and prior.work_order_id=p_job and prior.inventory_item_id=p_item and prior.quantity=p_quantity and prior.note=trim(p_note) and prior.actor_id=p_actor then return p_id; end if;
  raise exception 'Usage key already used for different details';
 end if;
 perform 1 from public.work_orders where hotel_id=p_hotel and id=p_job;
 if not found then raise exception 'Work order not found in this property'; end if;
 select * into item from public.cmpri_inventory_items where hotel_id=p_hotel and id=p_item and active=true for update;
 if not found or item.quantity_on_hand-item.quantity_reserved<p_quantity then raise exception 'Insufficient available inventory'; end if;
 insert into public.cmpri_supply_uses(id,hotel_id,work_order_id,inventory_item_id,quantity,note,actor_id) values(p_id,p_hotel,p_job,p_item,p_quantity,trim(p_note),p_actor);
 update public.cmpri_inventory_items set quantity_on_hand=quantity_on_hand-p_quantity where id=p_item;
 insert into public.cmpri_work_order_items(id,hotel_id,work_order_id,inventory_item_id,name,quantity,status,unit_cost_snapshot,recorded_by_user_id,notes) values(p_id,p_hotel,p_job,p_item,item.item_name,p_quantity,'Installed / Used',null,p_actor,trim(p_note));
 insert into public.cmpri_inventory_movements(id,hotel_id,inventory_item_id,movement_type,quantity_change,work_order_item_id,work_order_id,direction,performed_by_user_id,notes) values(p_id,p_hotel,p_item,'Use',-p_quantity,p_id,p_job,'out',p_actor,trim(p_note));
 return p_id;
end $$;
revoke all on function public.cmpri_receive_po(uuid,uuid,uuid,uuid,numeric,date,text) from public,anon,authenticated;
revoke all on function public.cmpri_use_supply(uuid,uuid,uuid,uuid,uuid,numeric,text) from public,anon,authenticated;
grant execute on function public.cmpri_receive_po(uuid,uuid,uuid,uuid,numeric,date,text) to service_role;
grant execute on function public.cmpri_use_supply(uuid,uuid,uuid,uuid,uuid,numeric,text) to service_role;
create function public.cmpri_create_manual_po(p_hotel uuid,p_actor uuid,p_id uuid,p_supplier text,p_reference text,p_description text,p_quantity numeric,p_uom text)
returns uuid language plpgsql security invoker set search_path=public,pg_temp as $$
begin
 if p_id is null or p_actor is null or coalesce(trim(p_supplier),'')='' or coalesce(trim(p_description),'')='' or coalesce(trim(p_uom),'')='' or p_quantity is null or p_quantity<=0 or p_quantity<>round(p_quantity,3) or p_quantity::text in ('NaN','Infinity','-Infinity') or p_quantity<>round(p_quantity,3) then raise exception 'Invalid manual order'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_id::text,0));
 if exists(select 1 from public.cmpri_po_orders where id=p_id) then
  if exists(select 1 from public.cmpri_po_orders o join public.cmpri_po_lines l on l.order_id=o.id where o.id=p_id and o.hotel_id=p_hotel and o.created_by=p_actor and o.supplier=trim(p_supplier) and o.external_reference is not distinct from nullif(trim(p_reference),'') and l.description=trim(p_description) and l.ordered=p_quantity and l.uom=trim(p_uom)) then return p_id; end if;
  raise exception 'Manual order key already used';
 end if;
 insert into public.cmpri_po_orders(id,hotel_id,supplier,external_reference,origin,created_by) values(p_id,p_hotel,trim(p_supplier),nullif(trim(p_reference),''),'manual',p_actor);
 insert into public.cmpri_po_lines(hotel_id,order_id,description,ordered,uom) values(p_hotel,p_id,trim(p_description),p_quantity,trim(p_uom));
 return p_id;
end $$;
revoke all on function public.cmpri_create_manual_po(uuid,uuid,uuid,text,text,text,numeric,text) from public,anon,authenticated;
grant execute on function public.cmpri_create_manual_po(uuid,uuid,uuid,text,text,text,numeric,text) to service_role;
create function public.cmpri_link_po_line(p_hotel uuid,p_line uuid,p_item uuid,p_factor numeric)
returns uuid language plpgsql security invoker set search_path=public,pg_temp as $$
begin
 if p_factor is null or p_factor<=0 or p_factor::text in ('NaN','Infinity','-Infinity') or p_factor<>round(p_factor,3) then raise exception 'Invalid stock UOM conversion'; end if;
 perform 1 from public.cmpri_po_lines where hotel_id=p_hotel and id=p_line for update;
 if not found then raise exception 'Line not found'; end if;
 if exists(select 1 from public.cmpri_po_receipts where hotel_id=p_hotel and line_id=p_line) then raise exception 'Mapping cannot change after receiving'; end if;
 perform 1 from public.cmpri_inventory_items where hotel_id=p_hotel and id=p_item and active=true;
 if not found then raise exception 'Inventory item not found'; end if;
 update public.cmpri_po_lines set inventory_item_id=p_item,units_per_order_unit=p_factor where id=p_line;
 return p_line;
end $$;
revoke all on function public.cmpri_link_po_line(uuid,uuid,uuid,numeric) from public,anon,authenticated;
grant execute on function public.cmpri_link_po_line(uuid,uuid,uuid,numeric) to service_role;
-- Reviewed source snapshots only. No inventory writes, inferred receipts, or historical replacement.
alter table public.cmpri_po_orders add column supplier_order_refs text[] not null default '{}';
alter table public.cmpri_po_lines add column purchase_unit_price_cents bigint check(purchase_unit_price_cents>=0);
create unique index cmpri_po_ibuy_reference on public.cmpri_po_orders(hotel_id,external_reference) where origin='ibuy';
create function public.cmpri_import_po_order(p_hotel uuid,p_actor uuid,p_order jsonb)
returns uuid language plpgsql security invoker set search_path=public,pg_temp as $$
declare oid uuid; src jsonb; ln jsonb; shipment record; existing public.cmpri_po_orders; oldline public.cmpri_po_lines; oldship public.cmpri_po_shipments;
begin
 if p_actor is null or coalesce(p_order->>'externalPo','')='' or coalesce(p_order->>'supplier','')='' or (jsonb_array_length(p_order->'lines')=0 and not coalesce((p_order->>'cancelled')::boolean,false)) then raise exception 'Exact PO, supplier and verified lines required'; end if;
 if jsonb_array_length(p_order->'lines')<>(select count(distinct l->>'sku') from jsonb_array_elements(p_order->'lines') l) then raise exception 'Duplicate source SKU requires review'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_hotel::text||':'||(p_order->>'externalPo'),0));
 select * into existing from public.cmpri_po_orders where hotel_id=p_hotel and origin='ibuy' and external_reference=p_order->>'externalPo' for update;
 if found then
  if existing.supplier<>p_order->>'supplier' then raise exception 'Supplier conflict'; end if;oid=existing.id;
  if jsonb_array_length(p_order->'lines')>0 and (select count(*) from public.cmpri_po_lines where hotel_id=p_hotel and order_id=oid)<>jsonb_array_length(p_order->'lines') then raise exception 'Changed line snapshot requires review'; end if;
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
  insert into public.cmpri_po_sources(hotel_id,order_id,account,message_id,kind,source_note,review_status) values(p_hotel,oid,src->>'account',src->>'messageId',src->>'kind',src::text,'verified-extraction') on conflict(hotel_id,account,message_id) do nothing;
 end loop;
 if (p_order->>'accepted')::boolean and exists(select 1 from jsonb_array_elements(p_order->'evidence') e where e->>'kind'='company-accepted' and e->>'externalPo'=p_order->>'externalPo') then update public.cmpri_po_orders set acceptance='accepted',acceptance_note='Verified company-accepted source',accepted_by=p_actor,accepted_at=coalesce(accepted_at,now()) where id=oid; end if;
 if coalesce((p_order->>'cancelled')::boolean,false) then update public.cmpri_po_orders set cancelled=true where id=oid; end if;
 update public.cmpri_po_orders set supplier_order_refs=array(select jsonb_array_elements_text(p_order->'vendorOrders')) where id=oid;
 for shipment in select key,value from jsonb_each(p_order->'shipments') loop
  select * into oldship from public.cmpri_po_shipments where hotel_id=p_hotel and order_id=oid and supplier_shipment_id=shipment.key;
  if found and oldship.lines<>shipment.value->'lines' then raise exception 'Changed shipment snapshot requires review'; end if;
  insert into public.cmpri_po_shipments(hotel_id,order_id,supplier_shipment_id,carrier,tracking,tracking_url,ship_date,eta,lines) values(p_hotel,oid,shipment.key,shipment.value->>'carrier',shipment.value->>'tracking',shipment.value->>'trackingUrl',nullif(shipment.value->>'shippedDate','')::date,shipment.value->>'eta',shipment.value->'lines') on conflict(hotel_id,order_id,supplier_shipment_id) do nothing;
 end loop;
 return oid;
end $$;
revoke all on function public.cmpri_import_po_order(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.cmpri_import_po_order(uuid,uuid,jsonb) to service_role;
