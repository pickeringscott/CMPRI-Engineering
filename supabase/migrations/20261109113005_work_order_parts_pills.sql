-- Compact list/detail summary; identical PO/physical-receipt rules to cmpri_read_ticket_parts.
-- Mixed tickets show the first unresolved stage: Need to Order, On Order, In-House, Received.
create function public.cmpri_ticket_parts_statuses(p_hotel uuid,p_jobs uuid[])
returns table(work_order_id uuid,status text) language sql stable security invoker set search_path='' as $$
 with selected as (
  select * from public.cmpri_ticket_parts where hotel_id=p_hotel and work_order_id=any(p_jobs)
 ), totals as (
  select r.line_id,sum(r.stock_quantity) received from public.cmpri_po_receipts r
  where r.hotel_id=p_hotel and r.line_id in(select po_line_id from selected) group by r.line_id
 ), statuses as (
  select p.work_order_id,
   case when p.po_line_id is null then p.requested_status
    when l.id is null or o.id is null or p.inventory_item_id is distinct from l.inventory_item_id then 'Need to Order'
    when coalesce(t.received,0)>=p.quantity then 'Received'
    when o.cancelled or (o.origin<>'manual' and o.acceptance<>'accepted') then 'Need to Order' else 'On Order' end as status
  from selected p left join public.cmpri_po_lines l on l.hotel_id=p.hotel_id and l.id=p.po_line_id
  left join public.cmpri_po_orders o on o.hotel_id=l.hotel_id and o.id=l.order_id left join totals t on t.line_id=l.id
 )
 select s.work_order_id,case min(case s.status when 'Need to Order' then 1 when 'On Order' then 2 when 'In-House' then 3 else 4 end)
  when 1 then 'Need to Order' when 2 then 'On Order' when 3 then 'In-House' else 'Received' end
 from statuses s group by s.work_order_id;
$$;
revoke all on function public.cmpri_ticket_parts_statuses(uuid,uuid[]) from public,anon,authenticated;
grant execute on function public.cmpri_ticket_parts_statuses(uuid,uuid[]) to service_role;
