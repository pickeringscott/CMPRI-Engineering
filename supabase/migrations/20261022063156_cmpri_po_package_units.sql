-- Widen decimal storage without rewriting values or changing inventory identities.
-- Original package quantities and exact rational conversion inputs are retained.
alter table public.cmpri_inventory_items alter column quantity_on_hand type numeric;
alter table public.cmpri_po_lines alter column units_per_order_unit type numeric;
alter table public.cmpri_po_receipts alter column stock_quantity type numeric;
alter table public.cmpri_inventory_movements alter column quantity_change type numeric;
alter table public.cmpri_po_lines add column package_size numeric, add column content_unit text,
 add column conversion_numerator numeric, add column conversion_denominator numeric;
create table public.cmpri_po_package_operations(id uuid primary key,hotel_id uuid not null,actor_id uuid not null,request jsonb not null,line_id uuid not null);
alter table public.cmpri_po_package_operations enable row level security;
revoke all on public.cmpri_po_package_operations from anon,authenticated;
grant all on public.cmpri_po_package_operations to service_role;
create function public.cmpri_unit_grams(p_unit text) returns numeric language sql immutable as $$
 select case upper(p_unit) when 'LB' then 453.59237 when 'OZ' then 28.349523125 when 'G' then 1 when 'KG' then 1000 else null end
$$;
create function public.cmpri_po_add_item(p_hotel uuid,p_actor uuid,p_id uuid,p_order uuid,p_item uuid,p_description text,p_quantity numeric,p_unit text,p_package numeric,p_content text,p_sku text,p_price numeric)
 returns uuid language plpgsql security invoker set search_path=public,pg_temp as $$
declare prior public.cmpri_po_package_operations; request_body jsonb; item public.cmpri_inventory_items; o public.cmpri_po_orders; base_unit text; source_unit text; amount numeric; numerator numeric; denominator numeric; factor numeric;
begin
 if p_id is null or p_actor is null or p_quantity is null or p_quantity<=0 or p_quantity>999999999 or p_quantity<>round(p_quantity,3)
 or p_quantity::text in ('NaN','Infinity','-Infinity') or p_unit not in ('EA','CS','LB','OZ','G','KG') or nullif(btrim(p_description),'') is null or length(p_description)>1000
 or (p_price is not null and (p_price<0 or p_price>999999999 or p_price<>round(p_price,2) or p_price::text in ('NaN','Infinity','-Infinity'))) then raise exception 'Invalid order item'; end if;
 if p_unit in ('EA','CS') and p_quantity<>trunc(p_quantity) then raise exception 'Packages require a whole quantity'; end if;
 request_body=jsonb_build_object('order',p_order,'item',p_item,'description',btrim(p_description),'quantity',p_quantity,'unit',p_unit,'package',p_package,'content',p_content,'sku',p_sku,'price',p_price);
 perform pg_advisory_xact_lock(hashtextextended(p_id::text,0));
 select * into prior from public.cmpri_po_package_operations where id=p_id;
 if found then
  if prior.hotel_id=p_hotel and prior.actor_id=p_actor and prior.request=request_body then return prior.line_id; end if;
  raise exception 'Item key already used for different details';
 end if;
 select * into o from public.cmpri_po_orders where id=p_order and hotel_id=p_hotel for update;
 if not found or o.cancelled then raise exception 'Active order not found'; end if;
 source_unit=p_unit;amount=1;
 if p_unit in ('EA','CS') then
  if p_package is null and p_content is null and p_unit='EA' then source_unit='EA';
  else
   if p_package is null or p_package<=0 or p_package>999999999 or p_package<>round(p_package,3) or p_package::text in ('NaN','Infinity','-Infinity') or p_content is null or p_content not in ('EA','LB','OZ','G','KG') then raise exception 'Explicit package contents required'; end if;
   if p_content='EA' and p_package<>trunc(p_package) then raise exception 'Each contents require a whole count'; end if;
   source_unit=p_content;amount=p_package;
  end if;
 elsif p_package is not null or p_content is not null then raise exception 'Weight orders do not use package contents'; end if;
 if p_item is not null then
  select * into item from public.cmpri_inventory_items where id=p_item and hotel_id=p_hotel and active=true for update;
  if not found then raise exception 'Active inventory mapping required'; end if;
  base_unit=case upper(item.unit_of_measure) when 'EACH' then 'EA' when 'POUND' then 'LB' when 'POUNDS' then 'LB' else upper(item.unit_of_measure) end;
 else
  -- Prevent concurrent duplicate name creation; never infer a mapping from description.
  perform pg_advisory_xact_lock(hashtextextended(p_hotel::text||lower(btrim(p_description)),1));
  if exists(select 1 from public.cmpri_inventory_items where hotel_id=p_hotel and lower(btrim(item_name))=lower(btrim(p_description))) then raise exception 'Select the existing inventory item explicitly'; end if;
  base_unit=case when source_unit='EA' then 'EA' else 'LB' end;
  insert into public.cmpri_inventory_items(hotel_id,item_name,name,unit_of_measure,quantity_on_hand,created_by,sku)
   values(p_hotel,btrim(p_description),btrim(p_description),base_unit,0,p_actor,coalesce(p_sku,'')) returning * into item;
 end if;
 if source_unit='EA' and base_unit='EA' then numerator=amount;denominator=1;
 elsif public.cmpri_unit_grams(source_unit) is not null and public.cmpri_unit_grams(base_unit) is not null then
  numerator=amount*public.cmpri_unit_grams(source_unit);denominator=public.cmpri_unit_grams(base_unit);
 else raise exception 'Order unit does not match the selected inventory unit'; end if;
 factor=round(numerator::numeric(60,24)/denominator,24);
 insert into public.cmpri_po_lines(id,hotel_id,order_id,description,sku,ordered,uom,inventory_item_id,units_per_order_unit,purchase_unit_price_cents,package_size,content_unit,conversion_numerator,conversion_denominator)
 values(p_id,p_hotel,p_order,btrim(p_description),coalesce(p_sku,''),p_quantity,p_unit,item.id,factor,case when p_price is null then null else (p_price*100)::bigint end,p_package,p_content,numerator,denominator);
 insert into public.cmpri_po_package_operations values(p_id,p_hotel,p_actor,request_body,p_id);
 return p_id;
end $$;
revoke all on function public.cmpri_unit_grams(text),public.cmpri_po_add_item(uuid,uuid,uuid,uuid,uuid,text,numeric,text,numeric,text,text,numeric) from public,anon,authenticated;
grant execute on function public.cmpri_unit_grams(text),public.cmpri_po_add_item(uuid,uuid,uuid,uuid,uuid,text,numeric,text,numeric,text,text,numeric) to service_role;

create or replace function public.cmpri_receive_po(p_hotel uuid,p_actor uuid,p_id uuid,p_line uuid,p_quantity numeric,p_date date,p_note text)
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
 if o.origin is distinct from 'manual' and o.acceptance is distinct from 'accepted' then raise exception 'Company acceptance required'; end if;
 if l.inventory_item_id is null or l.units_per_order_unit is null then raise exception 'Reviewed inventory and UOM mapping required'; end if;
 select * into item from public.cmpri_inventory_items where hotel_id=p_hotel and id=l.inventory_item_id and active=true for update;
 if not found then raise exception 'Active inventory item not found in this property'; end if;
 select coalesce(sum(quantity),0) into already from public.cmpri_po_receipts where hotel_id=p_hotel and line_id=p_line;
 if p_quantity+already>l.ordered then raise exception 'Receipt exceeds outstanding quantity'; end if;
 delta=case when l.conversion_numerator is not null and l.conversion_denominator is not null then round((p_quantity*l.conversion_numerator)::numeric(60,24)/l.conversion_denominator,24) else p_quantity*l.units_per_order_unit end;

 insert into public.cmpri_po_receipts values(p_id,p_hotel,p_line,p_quantity,delta,p_date,trim(p_note),p_actor,now());
 update public.cmpri_inventory_items set quantity_on_hand=quantity_on_hand+delta where id=item.id;
 insert into public.cmpri_inventory_movements(id,hotel_id,inventory_item_id,movement_type,quantity_change,performed_by_user_id,notes) values(p_id,p_hotel,item.id,'Receipt',delta,p_actor,trim(p_note));
 return p_id;
end $$;


alter table public.cmpri_supply_uses alter column quantity type numeric;
alter table public.cmpri_work_order_items alter column quantity type numeric;
create function public.cmpri_use_supply_precise(p_hotel uuid,p_actor uuid,p_id uuid,p_job uuid,p_item uuid,p_quantity numeric,p_note text)
returns uuid language plpgsql security invoker set search_path=public,pg_temp as $$
declare prior public.cmpri_supply_uses; item public.cmpri_inventory_items;
begin
 if p_actor is null or p_id is null or p_quantity is null or p_quantity<=0 or p_quantity::text in ('NaN','Infinity','-Infinity') or coalesce(trim(p_note),'')='' then raise exception 'Invalid supply usage'; end if;
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

revoke all on function public.cmpri_use_supply_precise(uuid,uuid,uuid,uuid,uuid,numeric,text) from public,anon,authenticated;
grant execute on function public.cmpri_use_supply_precise(uuid,uuid,uuid,uuid,uuid,numeric,text) to service_role;
create function public.cmpri_use_supply_unit(p_hotel uuid,p_actor uuid,p_id uuid,p_job uuid,p_item uuid,p_quantity numeric,p_unit text,p_note text)
 returns uuid language plpgsql security invoker set search_path=public,pg_temp as $$
declare item public.cmpri_inventory_items; base text; delta numeric;
begin
 if p_quantity is null or p_quantity<=0 or p_quantity>999999999 or p_quantity<>round(p_quantity,3) or p_quantity::text in ('NaN','Infinity','-Infinity') then raise exception 'Invalid usage quantity'; end if;
 select * into item from public.cmpri_inventory_items where hotel_id=p_hotel and id=p_item and active=true;
 if not found then raise exception 'Active inventory item not found'; end if;
 base=case upper(item.unit_of_measure) when 'EACH' then 'EA' when 'POUND' then 'LB' when 'POUNDS' then 'LB' else upper(item.unit_of_measure) end;
 if p_unit=base then delta=p_quantity;
 elsif public.cmpri_unit_grams(p_unit) is not null and public.cmpri_unit_grams(base) is not null then
  delta=round((p_quantity*public.cmpri_unit_grams(p_unit))::numeric(60,24)/public.cmpri_unit_grams(base),24);
 else raise exception 'Usage unit does not match inventory'; end if;
 if base='EA' and delta<>trunc(delta) then raise exception 'Each usage requires a whole count'; end if;
 return public.cmpri_use_supply_precise(p_hotel,p_actor,p_id,p_job,p_item,delta,btrim(p_note)||E'\nEntered usage: '||p_quantity::text||' '||p_unit);
end $$;
revoke all on function public.cmpri_use_supply_unit(uuid,uuid,uuid,uuid,uuid,numeric,text,text) from public,anon,authenticated;
grant execute on function public.cmpri_use_supply_unit(uuid,uuid,uuid,uuid,uuid,numeric,text,text) to service_role;
