-- One bundled snapshot; item searches and list pagination use this permission-scoped local data.
create function public.cmpri_inventory_snapshot(p_hotel uuid,p_stock_only boolean default false)
returns jsonb language sql stable security invoker set search_path='' as $$
 select jsonb_build_object(
  'inventory',coalesce((select jsonb_agg(to_jsonb(i)||jsonb_build_object('storage_location',coalesce(l.name,i.storage_location),'unit_locked',i.quantity_on_hand<>0 or i.quantity_reserved<>0 or exists(select 1 from public.cmpri_inventory_movements m where m.hotel_id=p_hotel and m.inventory_item_id=i.id)) order by i.item_name,i.id) from public.cmpri_inventory_items i left join public.locations l on l.hotel_id=i.hotel_id and l.id=i.storage_location_id where i.hotel_id=p_hotel),'[]'::jsonb),
  'ideas',coalesce((select jsonb_agg(to_jsonb(i)||jsonb_build_object('status',public.cmpri_inventory_idea_state(p_hotel,i.po_line_id,i.inventory_item_id,i.quantity,i.status)) order by i.created_at desc,i.id) from public.cmpri_order_ideas i where hotel_id=p_hotel),'[]'::jsonb),
  'po_options',coalesce((select jsonb_agg(jsonb_build_object('id',l.id,'order_id',o.id,'inventory_item_id',l.inventory_item_id,'label',coalesce(o.external_reference,o.supplier)||' · '||l.description) order by o.created_at desc,l.id)
   from public.cmpri_po_lines l join public.cmpri_po_orders o on o.id=l.order_id and o.hotel_id=l.hotel_id where l.hotel_id=p_hotel and not o.cancelled and l.inventory_item_id is not null),'[]'::jsonb),
  'as_of',now(),'stock_only',p_stock_only
 )||case when p_stock_only then '{}'::jsonb else jsonb_build_object(
  'vendors',coalesce((select jsonb_agg(to_jsonb(v) order by v.company_name,v.id) from public.cmpri_vendors v where hotel_id=p_hotel),'[]'::jsonb),
  'contacts',coalesce((select jsonb_agg(to_jsonb(v) order by v.name,v.id) from public.cmpri_vendor_contacts v where hotel_id=p_hotel),'[]'::jsonb),
  'proposals',coalesce((select jsonb_agg(to_jsonb(v) order by v.proposal_date desc,v.id) from public.cmpri_vendor_proposals v where hotel_id=p_hotel),'[]'::jsonb),
  'compatibility',coalesce((select jsonb_agg(to_jsonb(v)) from public.cmpri_asset_inventory_compatibility v where hotel_id=p_hotel),'[]'::jsonb),
  'assets',coalesce((select jsonb_agg(jsonb_build_object('id',v.id,'name',v.name,'asset_type',v.asset_type,'location_id',v.location_id,'active',v.active) order by v.name,v.id) from public.assets v where hotel_id=p_hotel and active),'[]'::jsonb),
  'locations',coalesce((select jsonb_agg(jsonb_build_object('id',v.id,'name',v.name,'room_number',v.room_number,'area',v.area,'active',v.active) order by v.name,v.id) from public.locations v where hotel_id=p_hotel and active),'[]'::jsonb),
  'work_order_items','[]'::jsonb
 ) end;
$$;
revoke all on function public.cmpri_inventory_snapshot(uuid,boolean) from public,anon,authenticated;
grant execute on function public.cmpri_inventory_snapshot(uuid,boolean) to service_role;
create function public.cmpri_inventory_history(p_hotel uuid,p_item uuid,p_query text default '',p_before timestamptz default null,p_before_id uuid default null)
returns jsonb language sql stable security invoker set search_path='' as $$
 with found as (
  select * from public.cmpri_inventory_notes where hotel_id=p_hotel and inventory_item_id=p_item
  and (coalesce(p_query,'')='' or position(lower(p_query) in lower(concat_ws(' ',message,actor_name,kind,recorded_at::text,to_char(recorded_at at time zone 'America/Chicago','FMMon FMDD, YYYY HH12:MI AM'))))>0)
  and (p_before is null or (recorded_at,id)<(p_before,p_before_id)) order by recorded_at desc,id desc limit 51
 )
 select jsonb_build_object('item',(select to_jsonb(i)||jsonb_build_object('unit_locked',i.quantity_on_hand<>0 or i.quantity_reserved<>0 or exists(select 1 from public.cmpri_inventory_movements m where m.hotel_id=p_hotel and m.inventory_item_id=i.id)) from public.cmpri_inventory_items i where hotel_id=p_hotel and id=p_item),
 'notes',coalesce((select jsonb_agg(to_jsonb(f) order by recorded_at desc,id desc) from (select * from found order by recorded_at desc,id desc limit 50) f),'[]'::jsonb),
 'has_more',(select count(*)>50 from found));
$$;
revoke all on function public.cmpri_inventory_history(uuid,uuid,text,timestamptz,uuid) from public,anon,authenticated;
grant execute on function public.cmpri_inventory_history(uuid,uuid,text,timestamptz,uuid) to service_role;
create function public.cmpri_pool_inventory(p_hotel uuid) returns jsonb language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('location',case when l.id is not null then jsonb_build_object('id',l.id,'name',l.name) else null end,
 'items',coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'item_name',i.item_name,'quantity_on_hand',i.quantity_on_hand,'quantity_reserved',i.quantity_reserved,'unit_of_measure',i.unit_of_measure,'inventory_revision',i.inventory_revision) order by i.item_name,i.id)
 from public.cmpri_inventory_items i where i.hotel_id=p_hotel and i.active and i.item_type='Chemical' and i.storage_location_id=l.id),'[]'::jsonb))
 from (select 1) seed left join public.cmpri_inventory_settings s on s.hotel_id=p_hotel left join public.locations l on l.hotel_id=s.hotel_id and l.id=s.pool_location_id and l.active;
$$;
revoke all on function public.cmpri_pool_inventory(uuid) from public,anon,authenticated;
grant execute on function public.cmpri_pool_inventory(uuid) to service_role;

