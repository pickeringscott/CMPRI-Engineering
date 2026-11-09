-- Catalog identities and explicitly reviewed physical operations are separate.
alter table public.cmpri_inventory_items add column if not exists po_catalog_key text;
alter table public.cmpri_inventory_items add column if not exists stock_counted_at timestamptz;
create unique index if not exists cmpri_inventory_po_catalog_key on public.cmpri_inventory_items(hotel_id,po_catalog_key) where po_catalog_key is not null;
create table public.cmpri_po_operation_batches(id uuid primary key,hotel_id uuid not null,actor_id uuid not null,payload jsonb not null,result jsonb not null,created_at timestamptz not null default now());
alter table public.cmpri_po_operation_batches enable row level security;
revoke all on public.cmpri_po_operation_batches from public,anon,authenticated;
grant select,insert on public.cmpri_po_operation_batches to service_role;

create function public.cmpri_po_batch(p_hotel uuid,p_actor uuid,p_id uuid,p_payload jsonb)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare prior public.cmpri_po_operation_batches; r jsonb; l public.cmpri_po_lines; o public.cmpri_po_orders; item public.cmpri_inventory_items; key text; iid uuid; n integer:=0; q numeric; delta numeric; result jsonb;
begin
 if p_hotel is null or p_actor is null or p_id is null or coalesce(p_payload->>'mode','') not in ('catalog','receive','count') or jsonb_typeof(p_payload->'rows') is distinct from 'array' or jsonb_array_length(p_payload->'rows') not between 1 and 250 or (p_payload->>'confirmed')::boolean is distinct from true then raise exception 'Explicit reviewed batch required'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_id::text,0));
 select * into prior from public.cmpri_po_operation_batches where id=p_id;
 if found then if prior.hotel_id=p_hotel and prior.actor_id=p_actor and prior.payload=p_payload then return prior.result; end if; raise exception 'Batch key already used for different details'; end if;
 if (select count(distinct value->>'id') from jsonb_array_elements(p_payload->'rows'))<>jsonb_array_length(p_payload->'rows') then raise exception 'Duplicate batch row'; end if;
 -- One transaction: any conflict rolls back every row, including catalog mappings.
 for r in select value from jsonb_array_elements(p_payload->'rows') order by value->>'id' loop
  if p_payload->>'mode'='count' then
   select * into item from public.cmpri_inventory_items where hotel_id=p_hotel and id=(r->>'id')::uuid and active for update;
   if not found or item.quantity_on_hand is distinct from (r->>'expectedBalance')::numeric or item.stock_counted_at is distinct from (r->>'expectedCountedAt')::timestamptz then raise exception 'Inventory changed; refresh and review count'; end if;
   q=(r->>'quantity')::numeric;
   if q is null or q<0 or q>999999999 or q<>round(q,3) or q::text in ('NaN','Infinity','-Infinity') or coalesce(trim(r->>'note'),'')='' then raise exception 'Actual counted quantity and note required'; end if;
   delta=q-item.quantity_on_hand;
   update public.cmpri_inventory_items set quantity_on_hand=q,stock_counted_at=now() where id=item.id;
   if delta<>0 then insert into public.cmpri_inventory_movements(hotel_id,inventory_item_id,movement_type,quantity_change,performed_by_user_id,notes) values(p_hotel,item.id,'Adjustment',delta,p_actor,trim(r->>'note')); end if;
  else
   select * into l from public.cmpri_po_lines where hotel_id=p_hotel and id=(r->>'id')::uuid for update;
   if not found then raise exception 'PO line not found'; end if;
   select * into o from public.cmpri_po_orders where hotel_id=p_hotel and id=l.order_id for share;
   if o.cancelled then raise exception 'Cancelled order cannot be processed'; end if;
   if l.ordered is distinct from (r->>'expectedOrdered')::numeric or l.inventory_item_id::text is distinct from r->>'expectedItem' or l.units_per_order_unit is distinct from (r->>'expectedFactor')::numeric then raise exception 'PO line changed; refresh and review'; end if;
   if p_payload->>'mode'='catalog' then
    if l.inventory_item_id is not null then raise exception 'Line already mapped'; end if;
    if coalesce(trim(l.sku),'')='' or coalesce(trim(o.supplier),'') in ('','Supplier unresolved') then raise exception 'Source supplier and SKU required'; end if;
    key=jsonb_build_array(lower(trim(o.supplier)),l.sku,l.uom)::text;
    perform pg_advisory_xact_lock(hashtextextended(p_hotel::text||key,0));
    select id into iid from public.cmpri_inventory_items where hotel_id=p_hotel and po_catalog_key=key and active;
    if iid is null then
     insert into public.cmpri_inventory_items(hotel_id,po_catalog_key,item_name,name,description,sku,vendor_sku,unit_of_measure,quantity_on_hand,created_by) values(p_hotel,key,l.description,l.description,l.description,l.sku,l.sku,l.uom,0,p_actor) returning id into iid;
    end if;
    perform public.cmpri_link_po_line(p_hotel,l.id,iid,1);
   else
    q=(r->>'quantity')::numeric;
    if q is null or q<1 or q<>trunc(q) or q>999999999 or q::text in ('NaN','Infinity','-Infinity') or l.ordered<>trunc(l.ordered) then raise exception 'Whole physical receipt count required'; end if;
    if exists(select 1 from public.cmpri_po_receipts where line_id=l.id and quantity<>trunc(quantity)) then raise exception 'Fractional legacy receipt requires review'; end if;
    perform public.cmpri_receive_po(p_hotel,p_actor,(r->>'receiptId')::uuid,l.id,q,(r->>'date')::date,r->>'note');
   end if;
  end if;
  n=n+1;
 end loop;
 result=jsonb_build_object('processed',n,'mode',p_payload->>'mode','stockChanged',p_payload->>'mode'<>'catalog');
 insert into public.cmpri_po_operation_batches values(p_id,p_hotel,p_actor,p_payload,result,now());
 return result;
end $$;
revoke all on function public.cmpri_po_batch(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.cmpri_po_batch(uuid,uuid,uuid,jsonb) to service_role;

-- Preserve the original acceptance provenance across cross-actor replays.
do $$ declare definition text; begin
 definition=pg_get_functiondef('public.cmpri_import_po_order(uuid,uuid,jsonb)'::regprocedure);
 if position('accepted_by=p_actor' in definition)=0 then raise exception 'Unexpected import function; review migration'; end if;
 definition=replace(definition,'accepted_by=p_actor','accepted_by=coalesce(accepted_by,p_actor)');
 definition=replace(definition,'acceptance_note=''Verified company-accepted source''','acceptance_note=coalesce(acceptance_note,''Verified company-accepted source'')');
 execute definition;
end $$;

