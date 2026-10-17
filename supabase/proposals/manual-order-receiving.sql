-- Reviewed function-only replacement; applied to the authorized local database only.
-- Not a production migration; no hosted database application is authorized.
-- Manual origin records an externally approved purchase; do not fabricate acceptance metadata.
-- Existing function identity, invoker security, ACL, mapping, locks and ledger behavior are preserved.
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
 delta=p_quantity*l.units_per_order_unit;
 if delta<>round(delta,3) then raise exception 'Stock conversion exceeds supported precision'; end if;
 insert into public.cmpri_po_receipts values(p_id,p_hotel,p_line,p_quantity,delta,p_date,trim(p_note),p_actor,now());
 update public.cmpri_inventory_items set quantity_on_hand=quantity_on_hand+delta where id=item.id;
 insert into public.cmpri_inventory_movements(id,hotel_id,inventory_item_id,movement_type,quantity_change,performed_by_user_id,notes) values(p_id,p_hotel,item.id,'Receipt',delta,p_actor,trim(p_note));
 return p_id;
end $$;
