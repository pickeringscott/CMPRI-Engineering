-- Reviewed corrections overlay immutable imported source; no historical data rewrite.
create table public.cmpri_po_line_review_state(order_id uuid primary key references public.cmpri_po_orders(id),hotel_id uuid not null,source_lines jsonb not null,revision integer not null default 0);
create table public.cmpri_po_line_changes(id uuid primary key,hotel_id uuid not null,order_id uuid not null references public.cmpri_po_orders(id),line_id uuid not null,actor_id uuid not null,reason text not null,payload jsonb not null,before_line jsonb,after_line jsonb not null,revision integer not null,created_at timestamptz not null default now());
alter table public.cmpri_po_line_review_state enable row level security;
alter table public.cmpri_po_line_changes enable row level security;
revoke all on public.cmpri_po_line_review_state,public.cmpri_po_line_changes from public,anon,authenticated;
grant select,insert,update on public.cmpri_po_line_review_state to service_role;
grant select,insert on public.cmpri_po_line_changes to service_role;
create function public.cmpri_po_source_lines(p_lines jsonb) returns jsonb language sql immutable security invoker set search_path=public,pg_temp as $$
 select coalesce(jsonb_agg(jsonb_build_object('sku',l->>'sku','description',l->>'description','quantity',(l->>'quantity')::numeric,'uom',l->>'uom','unitPriceCents',(l->>'unitPriceCents')::bigint) order by l->>'sku'),'[]'::jsonb) from jsonb_array_elements(p_lines) l
$$;
revoke all on function public.cmpri_po_source_lines(jsonb) from public,anon,authenticated;
grant execute on function public.cmpri_po_source_lines(jsonb) to service_role;
create function public.cmpri_edit_po_line(p_hotel uuid,p_actor uuid,p_id uuid,p_payload jsonb) returns uuid language plpgsql security invoker set search_path=public,pg_temp as $$
declare o public.cmpri_po_orders; oldline public.cmpri_po_lines; updated public.cmpri_po_lines; prior public.cmpri_po_line_changes; state public.cmpri_po_line_review_state; lid uuid; q numeric; price numeric; received numeric; baseline jsonb;
begin
 if p_hotel is null or p_actor is null or p_id is null or coalesce(trim(p_payload->>'reason'),'')='' or length(p_payload->>'reason')>1000 then raise exception 'Attributed edit and reason required'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_id::text,0));
 select * into prior from public.cmpri_po_line_changes where id=p_id;
 if found then if prior.hotel_id=p_hotel and prior.actor_id=p_actor and prior.payload=p_payload then return prior.line_id; end if; raise exception 'Edit key already used for different details'; end if;
 select * into o from public.cmpri_po_orders where hotel_id=p_hotel and id=(p_payload->>'orderId')::uuid for update;
 if not found then raise exception 'Order not found'; end if;
 if o.cancelled then raise exception 'Cancelled order cannot be edited'; end if;
 select * into state from public.cmpri_po_line_review_state where order_id=o.id;
 if (p_payload->>'expectedRevision')::integer is distinct from coalesce(state.revision,0) then raise exception 'Order changed; refresh and review your edit'; end if;
 lid=(p_payload->>'lineId')::uuid;q=(p_payload->>'quantity')::numeric;price=(p_payload->>'unitPriceCents')::numeric;
 if lid is null or coalesce(trim(p_payload->>'description'),'')='' or length(p_payload->>'description')>1000 or length(coalesce(p_payload->>'sku',''))>200 or coalesce(trim(p_payload->>'uom'),'')='' or length(p_payload->>'uom')>30 or q is null or q<=0 or q>999999999 or q<>trunc(q) or q::text in ('NaN','Infinity','-Infinity') or (price is not null and (price<0 or price>999999999999 or price<>trunc(price) or price::text in ('NaN','Infinity','-Infinity'))) then raise exception 'Valid item, whole ordered quantity, unit and exact nonnegative price required'; end if;
 select * into oldline from public.cmpri_po_lines where id=lid for update;
 if found and (oldline.hotel_id<>p_hotel or oldline.order_id<>o.id) then raise exception 'Line belongs to another order'; end if;
 if exists(select 1 from public.cmpri_po_lines where order_id=o.id and id<>lid and sku=trim(p_payload->>'sku') and sku<>'') then raise exception 'SKU already exists on this order'; end if;
 select coalesce(sum(quantity),0) into received from public.cmpri_po_receipts where hotel_id=p_hotel and line_id=lid;
 if q<received or q<coalesce(oldline.backordered,0) then raise exception 'Ordered quantity cannot be below posted receipts or backorders'; end if;
 if (oldline.inventory_item_id is not null or received>0) and (oldline.sku is distinct from coalesce(trim(p_payload->>'sku'),'') or oldline.uom is distinct from trim(p_payload->>'uom')) then raise exception 'Mapped or received line SKU/unit cannot change; preserve reviewed inventory mapping'; end if;
 if state.order_id is null then
  select coalesce(jsonb_agg(jsonb_build_object('sku',sku,'description',description,'quantity',ordered,'uom',uom,'unitPriceCents',purchase_unit_price_cents) order by sku),'[]'::jsonb) into baseline from public.cmpri_po_lines where order_id=o.id;
  insert into public.cmpri_po_line_review_state values(o.id,p_hotel,baseline,0);
 end if;
 if oldline.id is null then
  insert into public.cmpri_po_lines(id,hotel_id,order_id,description,sku,ordered,uom,purchase_unit_price_cents) values(lid,p_hotel,o.id,trim(p_payload->>'description'),coalesce(trim(p_payload->>'sku'),''),q,trim(p_payload->>'uom'),price) returning * into updated;
 else
  update public.cmpri_po_lines set description=trim(p_payload->>'description'),sku=coalesce(trim(p_payload->>'sku'),''),ordered=q,uom=trim(p_payload->>'uom'),purchase_unit_price_cents=price where id=lid returning * into updated;
 end if;
 update public.cmpri_po_line_review_state set revision=revision+1 where order_id=o.id returning * into state;
 insert into public.cmpri_po_line_changes(id,hotel_id,order_id,line_id,actor_id,reason,payload,before_line,after_line,revision) values(p_id,p_hotel,o.id,lid,p_actor,trim(p_payload->>'reason'),p_payload,case when oldline.id is null then null else to_jsonb(oldline) end,to_jsonb(updated),state.revision);
 return lid;
end $$;
revoke all on function public.cmpri_edit_po_line(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.cmpri_edit_po_line(uuid,uuid,uuid,jsonb) to service_role;
-- Safe identity completion can auto-map an unmapped line; established mappings remain untouched.
create trigger cmpri_po_line_auto_catalog_edit before update of sku,uom on public.cmpri_po_lines for each row when (new.inventory_item_id is null) execute function public.cmpri_auto_catalog_po_line();
-- Preserve the original importer evidence/acceptance/shipment guards. Only reviewed lines use a frozen snapshot.
do $$ declare definition text; begin
 definition=pg_get_functiondef('public.cmpri_import_po_order(uuid,uuid,jsonb)'::regprocedure);
 if position('for ln in select * from jsonb_array_elements(p_order->''lines'') loop' in definition)=0 then raise exception 'Unexpected importer definition'; end if;
 definition=replace(definition,'if jsonb_array_length(p_order->''lines'')>0 and exists', 'if not exists(select 1 from public.cmpri_po_line_review_state where order_id=oid) and jsonb_array_length(p_order->''lines'')>0 and exists');
 definition=replace(definition,'for ln in select * from jsonb_array_elements(p_order->''lines'') loop',
 'if exists(select 1 from public.cmpri_po_line_review_state where order_id=oid and source_lines<>public.cmpri_po_source_lines(p_order->''lines'')) then raise exception ''Imported source lines changed after reviewed corrections; reconcile source evidence''; end if;
 for ln in select * from jsonb_array_elements(case when exists(select 1 from public.cmpri_po_line_review_state where order_id=oid) then ''[]''::jsonb else p_order->''lines'' end) loop');
 execute definition;
end $$;

-- Original manual-create replay preserves reviewed corrections.
do $$ declare definition text; signature text; sku_expr text; begin
 for signature,sku_expr in select * from (values
 ('public.cmpri_create_manual_po(uuid,uuid,uuid,text,text,text,numeric,text)', $expr$''::text$expr$),
 ('public.cmpri_create_manual_po(uuid,uuid,uuid,text,text,text,numeric,text,text)', $expr$coalesce(trim(p_sku),'')$expr$)) v(signature,sku_expr) loop
  definition=pg_get_functiondef(signature::regprocedure);
  definition=replace(definition,'if exists(select 1 from public.cmpri_po_orders where id=p_id) then',
  format($body$if exists(select 1 from public.cmpri_po_orders o join public.cmpri_po_line_review_state s on s.order_id=o.id where o.id=p_id and o.hotel_id=p_hotel and o.created_by=p_actor and o.origin='manual' and o.supplier=trim(p_supplier) and o.external_reference is not distinct from nullif(trim(p_reference),'') and s.source_lines=public.cmpri_po_source_lines(jsonb_build_array(jsonb_build_object('sku',%s,'description',trim(p_description),'quantity',p_quantity,'uom',trim(p_uom),'unitPriceCents',null)))) then return p_id; end if;
  if exists(select 1 from public.cmpri_po_orders where id=p_id) then$body$,sku_expr));
  execute definition;
 end loop;
end $$;

