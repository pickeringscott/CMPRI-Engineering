-- Service-only cumulative receipt entry point. Existing receipt and movement history is retained.
create function public.cmpri_receive_po_total(
 p_hotel uuid,p_actor uuid,p_id uuid,p_line uuid,p_total numeric,p_expected numeric,p_date date
) returns uuid language plpgsql security invoker set search_path=public,pg_temp as $$
declare prior public.cmpri_po_receipts; already numeric; delta numeric;
begin
 if p_total is null or p_expected is null or p_total::text in ('NaN','Infinity','-Infinity')
 or p_expected::text in ('NaN','Infinity','-Infinity') or p_expected<0 or p_total<p_expected
 or p_total<>round(p_total,3) or p_expected<>round(p_expected,3)
 or p_actor is null or p_id is null or p_date is null then raise exception 'Invalid cumulative receipt'; end if;
 delta=p_total-p_expected;
 perform pg_advisory_xact_lock(hashtextextended(p_id::text,0));
 select * into prior from public.cmpri_po_receipts where id=p_id;
 if found then
  if prior.hotel_id=p_hotel and prior.actor_id=p_actor and prior.line_id=p_line
    and prior.quantity=delta and prior.note='Cumulative physical count: '||p_expected::text||' -> '||p_total::text
    then return p_id; end if;
  raise exception 'Receipt key already used for different details';
 end if;
 perform 1 from public.cmpri_po_lines where hotel_id=p_hotel and id=p_line for update;
 if not found then raise exception 'Order line not found'; end if;
 select coalesce(sum(quantity),0) into already from public.cmpri_po_receipts where hotel_id=p_hotel and line_id=p_line;
 if already<>p_expected then raise exception using errcode='40001',message='Received count changed. Reload the saved count before receiving.'; end if;
 if delta=0 then return null; end if;
 -- Reuses existing mapping, acceptance, cancellation, active-item and overreceipt checks.
 return public.cmpri_receive_po(p_hotel,p_actor,p_id,p_line,delta,p_date,
   'Cumulative physical count: '||p_expected::text||' -> '||p_total::text);
end $$;
revoke all on function public.cmpri_receive_po_total(uuid,uuid,uuid,uuid,numeric,numeric,date) from public,anon,authenticated;
grant execute on function public.cmpri_receive_po_total(uuid,uuid,uuid,uuid,numeric,numeric,date) to service_role;
