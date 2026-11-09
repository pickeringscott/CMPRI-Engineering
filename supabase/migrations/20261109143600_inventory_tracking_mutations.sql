create function public.cmpri_inventory_mutate(p_hotel uuid,p_actor uuid,p_id uuid,p_action text,p_item uuid,p_data jsonb,p_expected bigint default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare prior public.cmpri_inventory_operations; item public.cmpri_inventory_items; olditem public.cmpri_inventory_items; request_body jsonb; result jsonb;
 loc public.locations; vendor uuid; asset uuid; item_id uuid; qty numeric; delta numeric; unit text; reason text; actor_name text; actor_role text; note_id uuid;
begin
 if p_id is null or p_actor is null or p_action is null or p_action not in ('create','edit','adjust','return') or p_data is null or jsonb_typeof(p_data)<>'object' then raise exception 'Invalid inventory operation'; end if;
 request_body=jsonb_build_object('action',p_action,'item',p_item,'data',p_data,'revision',p_expected);
 perform pg_advisory_xact_lock(hashtextextended(p_id::text,0));
 select * into prior from public.cmpri_inventory_operations where id=p_id;
 if found then
  if prior.hotel_id<>p_hotel or prior.actor_id<>p_actor or prior.request<>request_body then raise exception 'Inventory operation key already has different details'; end if;
  select * into item from public.cmpri_inventory_items where hotel_id=p_hotel and id=(prior.result->'inventory_item'->>'id')::uuid;
  return prior.result||jsonb_build_object('inventory_item',to_jsonb(item)||jsonb_build_object('unit_locked',item.quantity_on_hand<>0 or item.quantity_reserved<>0 or exists(select 1 from public.cmpri_inventory_movements m where m.hotel_id=p_hotel and m.inventory_item_id=item.id)),'replayed',true);
 end if;
 select full_name,role into actor_name,actor_role from public.profiles where id=p_actor;
 if not found then raise exception 'Recorded operator required'; end if;
 reason=btrim(coalesce(p_data->>'reason',''));
 if length(reason)>2000 then raise exception 'Reason must be at most 2000 characters'; end if;
 if p_action<>'create' then
  select * into item from public.cmpri_inventory_items where hotel_id=p_hotel and id=p_item for update;
  if not found then raise exception 'Inventory item unavailable'; end if;
  if p_expected is null or p_expected<>item.inventory_revision then raise exception using errcode='40001',message='Inventory changed. Refresh and review your entries before saving.'; end if;
  olditem=item;
 end if;
 if p_action in ('create','edit') then
  if coalesce(btrim(p_data->>'item_name'),'')='' or length(p_data->>'item_name')>300 or coalesce(p_data->>'item_type','') not in ('Chemical','Part','Supply') then raise exception 'Enter item name and type'; end if;
  unit=upper(coalesce(p_data->>'unit_of_measure',''));if unit='EACH' then unit='EA';end if;
  if unit not in ('EA','LB','OZ','G','KG','GAL','L','ML','FLOZ') then raise exception 'Choose a supported stock unit'; end if;
  select * into loc from public.locations where hotel_id=p_hotel and id=(p_data->>'storage_location_id')::uuid and active;
  if not found then raise exception 'Choose an active managed Storage Location'; end if;
  vendor=nullif(p_data->>'preferred_vendor_id','')::uuid;asset=nullif(p_data->>'compatible_asset_id','')::uuid;
  if vendor is not null and not exists(select 1 from public.cmpri_vendors where hotel_id=p_hotel and id=vendor and active) then raise exception 'Choose an active vendor in this property'; end if;
  if asset is not null and not exists(select 1 from public.assets where hotel_id=p_hotel and id=asset and active) then raise exception 'Choose active equipment in this property'; end if;
  if length(coalesce(p_data->>'description',''))>3000 or length(coalesce(p_data->>'manufacturer',''))>200 or length(coalesce(p_data->>'vendor_sku',''))>200 then raise exception 'Item details are too long'; end if;
  if nullif(p_data->>'reorder_level','') is not null and ((p_data->>'reorder_level')::numeric<0 or (p_data->>'reorder_level')::numeric>999999999 or (p_data->>'reorder_level')::numeric::text in ('NaN','Infinity','-Infinity')) then raise exception 'Invalid reorder level'; end if;
  if nullif(p_data->>'suggested_order_quantity','') is not null and ((p_data->>'suggested_order_quantity')::numeric<=0 or (p_data->>'suggested_order_quantity')::numeric>999999999 or (p_data->>'suggested_order_quantity')::numeric::text in ('NaN','Infinity','-Infinity')) then raise exception 'Invalid order quantity'; end if;
  if nullif(p_data->>'current_unit_cost','') is not null and ((p_data->>'current_unit_cost')::numeric<0 or (p_data->>'current_unit_cost')::numeric>999999999 or (p_data->>'current_unit_cost')::numeric::text in ('NaN','Infinity','-Infinity')) then raise exception 'Invalid unit cost'; end if;
  if p_action='create' then
   qty=(p_data->>'quantity_on_hand')::numeric;
   if qty is null or qty<0 or qty>999999999 or qty<>round(qty,3) or qty::text in ('NaN','Infinity','-Infinity') or (qty>0 and reason='') then raise exception 'Enter opening count and a count note for opening stock'; end if;
   item_id=p_id;
   insert into public.cmpri_inventory_items(id,hotel_id,item_name,name,item_type,unit_of_measure,storage_location_id,storage_location,preferred_vendor_id,manufacturer,vendor_sku,description,reorder_level,suggested_order_quantity,current_unit_cost,quantity_on_hand,created_by)
   values(item_id,p_hotel,btrim(p_data->>'item_name'),btrim(p_data->>'item_name'),p_data->>'item_type',unit,loc.id,loc.name,vendor,btrim(coalesce(p_data->>'manufacturer','')),btrim(coalesce(p_data->>'vendor_sku','')),btrim(coalesce(p_data->>'description','')),nullif(p_data->>'reorder_level','')::numeric,nullif(p_data->>'suggested_order_quantity','')::numeric,nullif(p_data->>'current_unit_cost','')::numeric,qty,p_actor) returning * into item;
   if qty>0 then
    insert into public.cmpri_inventory_movements(id,hotel_id,inventory_item_id,movement_type,quantity_change,direction,performed_by_user_id,notes,source_type) values(p_id,p_hotel,item.id,'Adjustment',qty,'in',p_actor,reason,'Opening balance');
   else
    insert into public.cmpri_inventory_notes(id,hotel_id,inventory_item_id,actor_id,actor_name,actor_role,kind,message,quantity_before,quantity_after,reserved_before,reserved_after,unit)
     values(p_id,p_hotel,item.id,p_actor,coalesce(actor_name,'Recorded operator'),coalesce(actor_role,''),'Opening balance','Opening count: 0 '||unit||case when reason<>'' then '. '||reason else '' end,0,0,0,0,unit);
   end if;
  else
   update public.cmpri_inventory_items set item_name=btrim(p_data->>'item_name'),item_type=p_data->>'item_type',unit_of_measure=unit,storage_location_id=loc.id,storage_location=loc.name,
    preferred_vendor_id=vendor,manufacturer=btrim(coalesce(p_data->>'manufacturer','')),vendor_sku=btrim(coalesce(p_data->>'vendor_sku','')),description=btrim(coalesce(p_data->>'description','')),
    reorder_level=nullif(p_data->>'reorder_level','')::numeric,suggested_order_quantity=nullif(p_data->>'suggested_order_quantity','')::numeric,current_unit_cost=nullif(p_data->>'current_unit_cost','')::numeric
    where hotel_id=p_hotel and id=p_item returning * into item;
   insert into public.cmpri_inventory_notes(id,hotel_id,inventory_item_id,actor_id,actor_name,actor_role,kind,message,unit)
    values(p_id,p_hotel,item.id,p_actor,coalesce(actor_name,'Recorded operator'),coalesce(actor_role,''),'Item details',
    coalesce(nullif(concat_ws(E'\n',
     case when olditem.item_name is distinct from item.item_name then 'Name: '||olditem.item_name||' → '||item.item_name end,
     case when olditem.item_type is distinct from item.item_type then 'Type: '||olditem.item_type||' → '||item.item_type end,
     case when olditem.storage_location_id is distinct from item.storage_location_id then 'Storage: '||coalesce(nullif(olditem.storage_location,''),'Unassigned')||' → '||loc.name end,
     case when olditem.unit_of_measure is distinct from item.unit_of_measure then 'Stock unit: '||olditem.unit_of_measure||' → '||unit end,
     case when olditem.manufacturer is distinct from item.manufacturer then 'Manufacturer: '||olditem.manufacturer||' → '||item.manufacturer end,
     case when olditem.vendor_sku is distinct from item.vendor_sku then 'Vendor SKU: '||olditem.vendor_sku||' → '||item.vendor_sku end,
     case when olditem.preferred_vendor_id is distinct from item.preferred_vendor_id then 'Preferred vendor updated' end,
     case when olditem.description is distinct from item.description then 'Description: '||item.description end,
     case when olditem.reorder_level is distinct from item.reorder_level then 'Reorder at: '||coalesce(olditem.reorder_level::text,'Not set')||' → '||coalesce(item.reorder_level::text,'Not set') end,
     case when olditem.suggested_order_quantity is distinct from item.suggested_order_quantity then 'Order quantity: '||coalesce(olditem.suggested_order_quantity::text,'Not set')||' → '||coalesce(item.suggested_order_quantity::text,'Not set') end,
     case when olditem.current_unit_cost is distinct from item.current_unit_cost then 'Unit cost: '||coalesce(olditem.current_unit_cost::text,'Not set')||' → '||coalesce(item.current_unit_cost::text,'Not set') end,
     nullif(reason,'')),''),'Details reviewed'),unit);
  end if;
  if asset is not null then insert into public.cmpri_asset_inventory_compatibility(hotel_id,asset_id,inventory_item_id,notes,created_by) values(p_hotel,asset,item.id,'',p_actor) on conflict(asset_id,inventory_item_id) do nothing; end if;
 elsif p_action in ('adjust','return') then
  qty=(p_data->>'quantity')::numeric;
  if reason='' or qty is null or qty<0 or qty>999999999 or qty<>round(qty,3) or qty::text in ('NaN','Infinity','-Infinity') then raise exception 'Enter a valid quantity and adjustment reason'; end if;
  delta=case when p_action='return' then qty else qty-item.quantity_on_hand end;
  update public.cmpri_inventory_items set quantity_on_hand=quantity_on_hand+delta where hotel_id=p_hotel and id=p_item returning * into item;
  if delta<>0 then
   insert into public.cmpri_inventory_movements(id,hotel_id,inventory_item_id,movement_type,quantity_change,direction,performed_by_user_id,notes,source_type)
    values(p_id,p_hotel,item.id,case when p_action='return' then 'Return' else 'Adjustment' end,delta,case when delta>0 then 'in' else 'out' end,p_actor,reason,case when p_action='return' then 'Return' else 'Physical count correction' end);
  else
   insert into public.cmpri_inventory_notes(id,hotel_id,inventory_item_id,actor_id,actor_name,actor_role,kind,message,quantity_before,quantity_after,reserved_before,reserved_after,unit)
    values(p_id,p_hotel,item.id,p_actor,coalesce(actor_name,'Recorded operator'),coalesce(actor_role,''),'Physical count','Count verified; no stock change. '||reason,item.quantity_on_hand,item.quantity_on_hand,item.quantity_reserved,item.quantity_reserved,item.unit_of_measure);
  end if;
 end if;
 result=jsonb_build_object('inventory_item',to_jsonb(item)||jsonb_build_object('unit_locked',item.quantity_on_hand<>0 or item.quantity_reserved<>0 or exists(select 1 from public.cmpri_inventory_movements m where m.hotel_id=p_hotel and m.inventory_item_id=item.id)),'note',(select to_jsonb(n) from public.cmpri_inventory_notes n where id=p_id),
  'compatibility',case when asset is not null then jsonb_build_object('asset_id',asset,'inventory_item_id',item.id) else null end);
 insert into public.cmpri_inventory_operations(id,hotel_id,actor_id,request,result) values(p_id,p_hotel,p_actor,request_body,result);
 return result;
end $$;
revoke all on function public.cmpri_inventory_mutate(uuid,uuid,uuid,text,uuid,jsonb,bigint) from public,anon,authenticated;
grant execute on function public.cmpri_inventory_mutate(uuid,uuid,uuid,text,uuid,jsonb,bigint) to service_role;

