// Generates a reviewed, one-time transaction; never exposed through the application API.
// Input must be the frozen, individually verified batch, not current outstanding orders.
export function historicalReceiptBatch({hotel,actor,batch,rows}) {
 const uuid=/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
 if(!uuid.test(hotel)||!uuid.test(actor)||!/^[a-z0-9-]+$/.test(batch)||!rows.length)throw Error('Invalid batch identity');
 const seen=new Set();
 const data=rows.map(r=>{
  if(!uuid.test(r.line_id)||!uuid.test(r.order_id)||!uuid.test(r.inventory_item_id)||seen.has(r.line_id)||!Number.isInteger(r.approved)||r.approved<=0||!['EA','PKG','BOX','CS'].includes(r.uom)||r.uom!==r.unit_of_measure||Number(r.units_per_order_unit)!==1||r.conversion_numerator!=null||r.conversion_denominator!=null)throw Error('Unverified batch row');
  seen.add(r.line_id);return {line:r.line_id,order:r.order_id,item:r.inventory_item_id,qty:r.approved,uom:r.uom,po:r.po,sku:r.sku};
 });
 const literal=JSON.stringify(data).replaceAll("'","''");
 return `DO $reconcile$
DECLARE
 h constant uuid := '${hotel}'; actor constant uuid := '${actor}'; batch constant text := '${batch}';
 expected constant jsonb := '${literal}'::jsonb;
 r record; l public.cmpri_po_lines; o public.cmpri_po_orders; i public.cmpri_inventory_items;
 prior public.cmpri_po_receipts; movement public.cmpri_inventory_movements; rid uuid; found_count integer := 0;
 note constant text := 'Verified historical receipt reconciliation; actual receipt date unknown. Stock added once; audit timestamp is not the receipt date.';
BEGIN
 perform pg_advisory_xact_lock(hashtextextended(batch,0));
 -- Same lock order as normal receiving; all affected rows are held until commit.
 perform 1 from public.cmpri_po_lines where id in(select (x->>'line')::uuid from jsonb_array_elements(expected)x) order by id for update;
 perform 1 from public.cmpri_po_orders where id in(select (x->>'order')::uuid from jsonb_array_elements(expected)x) order by id for share;
 perform 1 from public.cmpri_inventory_items where id in(select (x->>'item')::uuid from jsonb_array_elements(expected)x) order by id for update;
 for r in select * from jsonb_to_recordset(expected) as x(line uuid,"order" uuid,item uuid,qty numeric,uom text,po text,sku text) loop
  rid := md5(batch||':'||r.line::text)::uuid;
  select * into prior from public.cmpri_po_receipts where id=rid;
  if found then
   if prior.hotel_id<>h or prior.line_id<>r.line or prior.quantity<>r.qty or prior.stock_quantity<>r.qty or prior.received_date is not null or prior.receipt_kind<>'historical' or prior.reconciliation_batch is distinct from batch or prior.actor_id<>actor then raise exception 'Replay receipt mismatch: %',r.line; end if;
   select * into movement from public.cmpri_inventory_movements where id=rid;
   if not found or movement.hotel_id<>h or movement.inventory_item_id<>r.item or movement.quantity_change<>r.qty or movement.movement_type<>'Receipt' then raise exception 'Replay movement mismatch: %',r.line; end if;
   found_count:=found_count+1;
  end if;
 end loop;
 if found_count=jsonb_array_length(expected) then return; end if;
 if found_count<>0 or exists(select 1 from public.cmpri_po_receipts where reconciliation_batch=batch) then raise exception 'Partial or conflicting historical batch'; end if;
 -- Abort on any changed evidence; never overwrite or silently guess a delta.
 for r in select * from jsonb_to_recordset(expected) as x(line uuid,"order" uuid,item uuid,qty numeric,uom text,po text,sku text) loop
  select * into l from public.cmpri_po_lines where id=r.line and hotel_id=h;
  if not found or l.order_id<>r."order" or l.inventory_item_id is distinct from r.item or l.ordered<>r.qty or l.uom<>r.uom or l.sku<>r.sku or l.units_per_order_unit is distinct from 1 or l.conversion_numerator is not null or l.conversion_denominator is not null then raise exception 'Line evidence changed: %',r.line; end if;
  select * into o from public.cmpri_po_orders where id=r."order" and hotel_id=h;
  if not found or o.cancelled or o.acceptance<>'accepted' or o.external_reference is distinct from r.po then raise exception 'Order evidence changed: %',r.line; end if;
  select * into i from public.cmpri_inventory_items where id=r.item and hotel_id=h;
  if not found or not i.active or i.unit_of_measure<>r.uom or i.quantity_on_hand is distinct from 0 or i.quantity_reserved is distinct from 0 then raise exception 'Inventory evidence changed: %',r.item; end if;
  if exists(select 1 from public.cmpri_po_receipts where line_id=r.line) or exists(select 1 from public.cmpri_supply_uses where inventory_item_id=r.item) or exists(select 1 from public.cmpri_inventory_movements where inventory_item_id=r.item) then raise exception 'Receipt or usage evidence changed: %',r.line; end if;
 end loop;
 for r in select * from jsonb_to_recordset(expected) as x(line uuid,"order" uuid,item uuid,qty numeric,uom text,po text,sku text) loop
  rid := md5(batch||':'||r.line::text)::uuid;
  insert into public.cmpri_po_receipts(id,hotel_id,line_id,quantity,stock_quantity,received_date,note,actor_id,receipt_kind,reconciliation_batch) values(rid,h,r.line,r.qty,r.qty,null,note,actor,'historical',batch);
  update public.cmpri_inventory_items set quantity_on_hand=quantity_on_hand+r.qty where id=r.item and hotel_id=h;
  insert into public.cmpri_inventory_movements(id,hotel_id,inventory_item_id,movement_type,quantity_change,performed_by_user_id,notes) values(rid,h,r.item,'Receipt',r.qty,actor,note);
 end loop;
END $reconcile$;`;
}
