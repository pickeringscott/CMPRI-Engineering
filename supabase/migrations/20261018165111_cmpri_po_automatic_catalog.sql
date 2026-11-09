-- Future lines only. Existing catalog, mappings, evidence and quantities are untouched.
alter table public.cmpri_po_lines add column catalog_review_note text;
create function public.cmpri_auto_catalog_po_line()
returns trigger language plpgsql security invoker set search_path=public,pg_temp as $$
declare o public.cmpri_po_orders; item public.cmpri_inventory_items; identity_key text;
begin
 if new.inventory_item_id is not null then return new; end if;
 select * into o from public.cmpri_po_orders where id=new.order_id and hotel_id=new.hotel_id;
 if not found then raise exception 'PO property identity mismatch'; end if;
 if coalesce(trim(new.sku),'')='' or coalesce(trim(new.uom),'')='' or lower(trim(o.supplier)) in ('','supplier unresolved','offline supplier') then
  new.catalog_review_note='Catalog review required: source supplier, SKU and order unit must be established.'; return new;
 end if;
 -- Identical to the historical catalog identity. Never infer pack contents or unit aliases.
 identity_key=jsonb_build_array(lower(trim(o.supplier)),new.sku,new.uom)::text;
 perform pg_advisory_xact_lock(hashtextextended(new.hotel_id::text||identity_key,0));
 select * into item from public.cmpri_inventory_items where hotel_id=new.hotel_id and po_catalog_key=identity_key for update;
 if found then
  if not item.active or item.unit_of_measure is distinct from new.uom or item.sku is distinct from new.sku then
   new.catalog_review_note='Catalog review required: matching supplier/SKU identity is inactive or its stock unit changed.'; return new;
  end if;
 else
  -- A legacy SKU alone does not establish the supplier or a safe conversion.
  if exists(select 1 from public.cmpri_inventory_items where hotel_id=new.hotel_id and po_catalog_key is null and (sku=new.sku or vendor_sku=new.sku)) then
   new.catalog_review_note='Catalog review required: existing SKU has no verified supplier/unit identity. Confirm the inventory mapping.'; return new;
  end if;
  insert into public.cmpri_inventory_items(hotel_id,po_catalog_key,item_name,name,description,sku,vendor_sku,unit_of_measure,quantity_on_hand,created_by)
  values(new.hotel_id,identity_key,new.description,new.description,new.description,new.sku,new.sku,new.uom,0,o.created_by) returning * into item;
 end if;
 new.inventory_item_id=item.id; new.units_per_order_unit=1; new.catalog_review_note=null;
 return new;
end $$;
revoke all on function public.cmpri_auto_catalog_po_line() from public,anon,authenticated;
grant execute on function public.cmpri_auto_catalog_po_line() to service_role;
create trigger cmpri_po_line_auto_catalog before insert on public.cmpri_po_lines for each row execute function public.cmpri_auto_catalog_po_line();

-- Keep the existing eight-argument API for old clients; the new form supplies SKU.
create function public.cmpri_create_manual_po(p_hotel uuid,p_actor uuid,p_id uuid,p_supplier text,p_reference text,p_description text,p_quantity numeric,p_uom text,p_sku text)
returns uuid language plpgsql security invoker set search_path=public,pg_temp as $$
begin
 if p_id is null or p_actor is null or coalesce(trim(p_supplier),'')='' or coalesce(trim(p_description),'')='' or coalesce(trim(p_uom),'')='' or p_quantity is null or p_quantity<=0 or p_quantity<>round(p_quantity,3) or p_quantity::text in ('NaN','Infinity','-Infinity') or p_quantity<>round(p_quantity,3) then raise exception 'Invalid manual order'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_id::text,0));
 if exists(select 1 from public.cmpri_po_orders where id=p_id) then
  if exists(select 1 from public.cmpri_po_orders o join public.cmpri_po_lines l on l.order_id=o.id where o.id=p_id and o.hotel_id=p_hotel and o.created_by=p_actor and o.supplier=trim(p_supplier) and o.external_reference is not distinct from nullif(trim(p_reference),'') and l.description=trim(p_description) and l.ordered=p_quantity and l.uom=trim(p_uom) and coalesce(l.sku,'')=coalesce(trim(p_sku),'')) then return p_id; end if;
  raise exception 'Manual order key already used';
 end if;
 insert into public.cmpri_po_orders(id,hotel_id,supplier,external_reference,origin,created_by) values(p_id,p_hotel,trim(p_supplier),nullif(trim(p_reference),''),'manual',p_actor);
 insert into public.cmpri_po_lines(hotel_id,order_id,description,ordered,uom,sku) values(p_hotel,p_id,trim(p_description),p_quantity,trim(p_uom),coalesce(trim(p_sku),''));
 return p_id;
end $$;
revoke all on function public.cmpri_create_manual_po(uuid,uuid,uuid,text,text,text,numeric,text,text) from public,anon,authenticated;
grant execute on function public.cmpri_create_manual_po(uuid,uuid,uuid,text,text,text,numeric,text,text) to service_role;

-- Explicit line mapping remains the ambiguity resolution; batch catalog cannot bypass it.
do $$ declare definition text; begin
 definition=pg_get_functiondef('public.cmpri_po_batch(uuid,uuid,uuid,jsonb)'::regprocedure);
 if position('Line already mapped' in definition)=0 then raise exception 'Unexpected catalog batch function'; end if;
 definition=replace(definition, 'if l.inventory_item_id is not null then', 'if l.catalog_review_note is not null then raise exception ''Catalog identity requires explicit mapping review''; end if; if l.inventory_item_id is not null then');
 execute definition;
end $$;

