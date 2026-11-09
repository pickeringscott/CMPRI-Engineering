-- Edit this order's package conversion before its first receipt. Never rewrite stock/history.
create function public.cmpri_po_edit_package(p_hotel uuid,p_actor uuid,p_id uuid,p_line uuid,p_package numeric,p_content text,p_expected numeric,p_expected_content text)
returns uuid language plpgsql security invoker set search_path=public,pg_temp as $$
declare l public.cmpri_po_lines; item public.cmpri_inventory_items; prior public.cmpri_po_package_operations; request_body jsonb; base_unit text; numerator numeric; denominator numeric;
begin
 if p_actor is null or p_id is null or p_package is null or p_package<=0 or p_package>999999999
 or p_package<>round(p_package,3) or p_package::text in ('NaN','Infinity','-Infinity')
 or p_content is null or p_content not in ('EA','LB','OZ','G','KG')
 or (p_content='EA' and p_package<>trunc(p_package)) then raise exception 'Invalid package contents'; end if;
 request_body=jsonb_build_object('action','edit-package','line',p_line,'package',p_package,'content',p_content,'expected',p_expected,'expectedContent',p_expected_content);
 perform pg_advisory_xact_lock(hashtextextended(p_id::text,0));
 select * into prior from public.cmpri_po_package_operations where id=p_id;
 if found then
  if prior.hotel_id=p_hotel and prior.actor_id=p_actor and prior.request=request_body then return prior.line_id; end if;
  raise exception 'Package edit key already used for different details';
 end if;
 select * into l from public.cmpri_po_lines where hotel_id=p_hotel and id=p_line for update;
 if not found or l.uom not in ('EA','CS') then raise exception 'Mapped package order line required'; end if;
 if l.package_size is distinct from p_expected or l.content_unit is distinct from p_expected_content then raise exception using errcode='40001',message='Package conversion changed. Reload before editing.'; end if;
 if exists(select 1 from public.cmpri_po_receipts where hotel_id=p_hotel and line_id=p_line) then raise exception 'Package contents cannot change after receiving. Add a new order line for a different package size.'; end if;
 perform 1 from public.cmpri_po_orders where hotel_id=p_hotel and id=l.order_id and not cancelled for share;
 if not found then raise exception 'Active order required'; end if;
 select * into item from public.cmpri_inventory_items where hotel_id=p_hotel and id=l.inventory_item_id and active for update;
 if not found then raise exception 'Select an active inventory mapping first'; end if;
 base_unit=case upper(item.unit_of_measure) when 'EACH' then 'EA' when 'POUND' then 'LB' when 'POUNDS' then 'LB' else upper(item.unit_of_measure) end;
 if p_content='EA' and base_unit='EA' then numerator=p_package;denominator=1;
 elsif public.cmpri_unit_grams(p_content) is not null and public.cmpri_unit_grams(base_unit) is not null then
  numerator=p_package*public.cmpri_unit_grams(p_content);denominator=public.cmpri_unit_grams(base_unit);
 else raise exception 'Package contents do not match inventory unit'; end if;
 update public.cmpri_po_lines set package_size=p_package,content_unit=p_content,conversion_numerator=numerator,
 conversion_denominator=denominator,units_per_order_unit=round(numerator::numeric(60,24)/denominator,24) where id=p_line;
 insert into public.cmpri_po_package_operations values(p_id,p_hotel,p_actor,request_body,p_line);
 return p_line;
end $$;
revoke all on function public.cmpri_po_edit_package(uuid,uuid,uuid,uuid,numeric,text,numeric,text) from public,anon,authenticated;
grant execute on function public.cmpri_po_edit_package(uuid,uuid,uuid,uuid,numeric,text,numeric,text) to service_role;
