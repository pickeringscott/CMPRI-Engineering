alter table public.cmpri_order_ideas add column po_line_id uuid references public.cmpri_po_lines(id);
create index cmpri_order_ideas_inventory_open on public.cmpri_order_ideas(hotel_id,inventory_item_id) where status not in ('Received','Dismissed');
create function public.cmpri_inventory_idea_state(p_hotel uuid,p_line uuid,p_item uuid,p_quantity numeric,p_status text)
returns text language sql stable security invoker set search_path='' as $$
 select case when p_line is null or p_status='Dismissed' then p_status else coalesce((select
  case when l.inventory_item_id is distinct from p_item then 'Ready To Order'
   when coalesce((select sum(r.stock_quantity) from public.cmpri_po_receipts r where r.hotel_id=p_hotel and r.line_id=l.id),0)>=coalesce(p_quantity,1) then 'Received'
   when o.cancelled or (o.origin<>'manual' and o.acceptance<>'accepted') then 'Ready To Order' else 'Ordered' end
  from public.cmpri_po_lines l join public.cmpri_po_orders o on o.hotel_id=l.hotel_id and o.id=l.order_id where l.hotel_id=p_hotel and l.id=p_line),'Ready To Order') end;
$$;
revoke all on function public.cmpri_inventory_idea_state(uuid,uuid,uuid,numeric,text) from public,anon,authenticated;
grant execute on function public.cmpri_inventory_idea_state(uuid,uuid,uuid,numeric,text) to service_role;
create function public.cmpri_inventory_idea_mutate(p_hotel uuid,p_actor uuid,p_id uuid,p_idea uuid,p_data jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare prior public.cmpri_inventory_operations; idea public.cmpri_order_ideas; ln public.cmpri_po_lines; ord public.cmpri_po_orders; request_body jsonb; result jsonb;
 item uuid; asset uuid; job uuid; qty numeric; desired text; source text; actor_name text;
begin
 if p_id is null or p_actor is null or jsonb_typeof(p_data)<>'object' then raise exception 'Invalid order idea'; end if;
 request_body=jsonb_build_object('action','idea','idea',p_idea,'data',p_data);
 perform pg_advisory_xact_lock(hashtextextended(p_id::text,0));
 select * into prior from public.cmpri_inventory_operations where id=p_id;
 if found then
  if prior.hotel_id<>p_hotel or prior.actor_id<>p_actor or prior.request<>request_body then raise exception 'Idea operation key already has different details'; end if;
  select * into idea from public.cmpri_order_ideas where hotel_id=p_hotel and id=(prior.result->'idea'->>'id')::uuid;
  return prior.result||jsonb_build_object('idea',to_jsonb(idea)||jsonb_build_object('status',public.cmpri_inventory_idea_state(p_hotel,idea.po_line_id,idea.inventory_item_id,idea.quantity,idea.status)),'replayed',true);
 end if;
 perform set_config('cmpri.parts_actor',p_actor::text,true);perform set_config('cmpri.parts_system','false',true);
 if p_idea is null then
  item=nullif(p_data->>'inventory_item_id','')::uuid;asset=nullif(p_data->>'asset_id','')::uuid;job=nullif(p_data->>'work_order_id','')::uuid;
  qty=nullif(p_data->>'quantity','')::numeric;source=coalesce(p_data->>'source','manual');
  if coalesce(btrim(p_data->>'item_text'),'')='' or length(p_data->>'item_text')>500 or source not in ('manual','work_order','inventory_reorder')
   or (qty is not null and (qty<=0 or qty>999999999 or qty<>round(qty,3) or qty::text in ('NaN','Infinity','-Infinity'))) then raise exception 'Enter order idea and valid quantity'; end if;
  if item is not null and not exists(select 1 from public.cmpri_inventory_items where hotel_id=p_hotel and id=item and active) then raise exception 'Active inventory item required'; end if;
  if asset is not null and not exists(select 1 from public.assets where hotel_id=p_hotel and id=asset and active) then raise exception 'Active equipment required'; end if;
  if job is not null and not exists(select 1 from public.work_orders where hotel_id=p_hotel and id=job) then raise exception 'Work order unavailable'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_hotel::text||coalesce(item::text,lower(btrim(p_data->>'item_text')))||coalesce(job::text,'')||coalesce(asset::text,''),8));
  select * into idea from public.cmpri_order_ideas i where i.hotel_id=p_hotel and i.inventory_item_id is not distinct from item and i.work_order_id is not distinct from job and i.asset_id is not distinct from asset
   and (item is not null or lower(btrim(i.item_text))=lower(btrim(p_data->>'item_text')))
   and public.cmpri_inventory_idea_state(p_hotel,i.po_line_id,i.inventory_item_id,i.quantity,i.status) not in ('Received','Dismissed') order by i.created_at,i.id limit 1;
  if not found then
   select full_name into actor_name from public.profiles where id=p_actor;
   insert into public.cmpri_order_ideas(id,hotel_id,inventory_item_id,asset_id,work_order_id,item_text,quantity,status,source,created_by_user_id,created_by_name,notes)
    values(p_id,p_hotel,item,asset,job,btrim(p_data->>'item_text'),qty,'Idea',source,p_actor,coalesce(actor_name,'Recorded operator'),left(coalesce(p_data->>'notes',''),3000)) returning * into idea;
  end if;
 else
  select * into idea from public.cmpri_order_ideas where hotel_id=p_hotel and id=p_idea for update;
  if not found then raise exception 'Order idea unavailable'; end if;
  desired=p_data->>'status';
  if desired='Link PO' then
   select * into ln from public.cmpri_po_lines where hotel_id=p_hotel and id=(p_data->>'po_line_id')::uuid;
   if not found or idea.inventory_item_id is null or ln.inventory_item_id is distinct from idea.inventory_item_id then raise exception 'Choose a PO line mapped to this inventory item'; end if;
   select * into ord from public.cmpri_po_orders where hotel_id=p_hotel and id=ln.order_id;
   if ord.cancelled then raise exception 'Choose an active PO'; end if;
   if exists(select 1 from public.cmpri_ticket_parts where hotel_id=p_hotel and order_idea_id=idea.id) then raise exception 'Link this ticket part through Labor & Parts'; end if;
   update public.cmpri_order_ideas set po_line_id=ln.id,status='Ordered',updated_at=now() where id=idea.id returning * into idea;
  elsif desired in ('Ready To Order','Dismissed') then
   if desired='Ready To Order' and (idea.po_line_id is not null or idea.status<>'Idea') then raise exception 'PO-linked status follows purchasing records'; end if;
   update public.cmpri_order_ideas set status=desired,updated_at=now() where id=idea.id returning * into idea;
  else raise exception 'Ordered and Received follow a linked PO and physical receiving. Open POs to receive stock'; end if;
 end if;
 result=jsonb_build_object('idea',to_jsonb(idea)||jsonb_build_object('status',public.cmpri_inventory_idea_state(p_hotel,idea.po_line_id,idea.inventory_item_id,idea.quantity,idea.status)));
 insert into public.cmpri_inventory_operations(id,hotel_id,actor_id,request,result) values(p_id,p_hotel,p_actor,request_body,result);
 return result;
end $$;
revoke all on function public.cmpri_inventory_idea_mutate(uuid,uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.cmpri_inventory_idea_mutate(uuid,uuid,uuid,uuid,jsonb) to service_role;
