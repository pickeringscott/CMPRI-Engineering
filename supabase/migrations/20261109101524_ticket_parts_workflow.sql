-- Additive ticket parts workflow. Existing inventory/PO ledgers remain authoritative.
begin;
create table public.cmpri_ticket_parts (
 id uuid primary key, hotel_id uuid not null, work_order_id uuid not null,
 name text not null check(length(btrim(name)) between 1 and 500),
 inventory_item_id uuid references public.cmpri_inventory_items(id),
 requested_status text not null check(requested_status in ('In-House','Need to Order')),
 quantity numeric not null check(quantity>0 and quantity<=999999 and quantity=round(quantity,3)),
 po_line_id uuid references public.cmpri_po_lines(id),
 order_idea_id uuid references public.cmpri_order_ideas(id),
 revision bigint not null default 1, actor_id uuid not null,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 foreign key(work_order_id,hotel_id) references public.work_orders(id,hotel_id) on delete cascade
);
create index cmpri_ticket_parts_job on public.cmpri_ticket_parts(hotel_id,work_order_id);
create index cmpri_ticket_parts_po on public.cmpri_ticket_parts(hotel_id,po_line_id) where po_line_id is not null;
alter table public.cmpri_ticket_parts enable row level security;
revoke all on public.cmpri_ticket_parts from public,anon,authenticated;
grant select,insert,update on public.cmpri_ticket_parts to service_role;
create policy cmpri_ticket_parts_service on public.cmpri_ticket_parts for all to service_role using(true) with check(true);

-- One append to the existing ticket note stream; concurrent notes cannot overwrite it.
create function public.cmpri_part_ticket_note(p_hotel uuid,p_job uuid,p_actor uuid,p_text text)
returns void language plpgsql security invoker set search_path='' as $$
declare actor_name text; actor_role text; line text;
begin
 select full_name,role::text into actor_name,actor_role from public.profiles where id=p_actor;
 line='CMPRI2|'||to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')||'|'||
 replace(coalesce(nullif(actor_name,''),'CMPRI'),'|','/')||'|'||replace(coalesce(actor_role,''),'|','/')||'|note|'||regexp_replace(replace(p_text,'|','/'),'[\n\r]+',' ','g');
 update public.work_orders set notes=concat_ws(E'\n',nullif(notes,''),line),history_actor_user_id=p_actor,history_source='CMPRI app'
 where hotel_id=p_hotel and id=p_job;
 if not found then raise exception 'Work order unavailable'; end if;
end $$;
revoke all on function public.cmpri_part_ticket_note(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.cmpri_part_ticket_note(uuid,uuid,uuid,text) to service_role;

create function public.cmpri_save_ticket_part(p_hotel uuid,p_actor uuid,p_id uuid,p_job uuid,p_name text,p_item uuid,p_status text,p_quantity numeric,p_line uuid,p_revision bigint)
returns uuid language plpgsql security invoker set search_path='' as $$
declare prior public.cmpri_ticket_parts; item public.cmpri_inventory_items; ln public.cmpri_po_lines; idea uuid; actor_name text; line_label text; note_status text;
begin
 if p_revision is null or p_id is null or p_actor is null or coalesce(btrim(p_name),'')='' or length(p_name)>500 or p_status is null or p_status not in ('In-House','Need to Order') or p_quantity is null or p_quantity<=0 or p_quantity>999999 or p_quantity<>round(p_quantity,3) or p_quantity::text in ('NaN','Infinity','-Infinity') then raise exception 'Invalid part details'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_id::text,0));
 perform 1 from public.work_orders where hotel_id=p_hotel and id=p_job and status not in ('Closed','Will Not Do');
 if not found then raise exception 'Work order unavailable for parts editing'; end if;
 if p_line is not null then
  perform 1 from public.cmpri_po_lines where hotel_id=p_hotel and id=p_line for share;
  if not found then raise exception 'PO line unavailable'; end if;
  perform 1 from public.cmpri_po_orders o join public.cmpri_po_lines l on l.order_id=o.id and l.hotel_id=o.hotel_id where l.hotel_id=p_hotel and l.id=p_line for share of o;
  if not found then raise exception 'PO order unavailable'; end if;
 end if;
 select * into prior from public.cmpri_ticket_parts where id=p_id for update;
 if found then
  if prior.hotel_id<>p_hotel or prior.work_order_id<>p_job then raise exception 'Part does not belong to this ticket'; end if;
  if (prior.name,prior.inventory_item_id,prior.requested_status,prior.quantity,prior.po_line_id) is not distinct from (btrim(p_name),p_item,p_status,p_quantity,p_line) then return p_id; end if;
  if prior.revision is distinct from p_revision then raise exception 'Part changed; refresh before saving'; end if;
 elsif p_revision<>0 then raise exception 'Part no longer exists';
 end if;
 if p_item is not null then
  select * into item from public.cmpri_inventory_items where hotel_id=p_hotel and id=p_item and active=true;
  if not found then raise exception 'Active inventory item unavailable'; end if;
 end if;
 if p_status='In-House' and p_line is null and (p_item is null or item.quantity_on_hand-item.quantity_reserved<p_quantity) then
  raise exception 'Choose sufficient available inventory or select Need to Order';
 end if;
 if p_line is not null then
  select * into ln from public.cmpri_po_lines where hotel_id=p_hotel and id=p_line;
  if not found then raise exception 'PO line unavailable'; end if;
  if ln.inventory_item_id is distinct from p_item then raise exception 'Select the PO line mapped inventory item before linking'; end if;
  select coalesce(external_reference,supplier) into line_label from public.cmpri_po_orders where hotel_id=p_hotel and id=ln.order_id;
 end if;
 perform set_config('cmpri.parts_actor',p_actor::text,true);
 perform set_config('cmpri.parts_system','false',true);
 note_status=p_status;
 if p_line is not null then
  select case when coalesce((select sum(r.stock_quantity) from public.cmpri_po_receipts r where r.hotel_id=p_hotel and r.line_id=p_line),0)>=p_quantity then 'Received'
   when o.cancelled or (o.origin<>'manual' and o.acceptance<>'accepted') then 'Need to Order' else 'On Order' end
  into note_status from public.cmpri_po_orders o where o.hotel_id=p_hotel and o.id=ln.order_id;
 end if;
 idea=prior.order_idea_id;
 if p_status='Need to Order' and idea is null then
  select full_name into actor_name from public.profiles where id=p_actor;
  idea=p_id;
  insert into public.cmpri_order_ideas(id,hotel_id,work_order_id,inventory_item_id,item_text,quantity,status,source,created_by_user_id,created_by_name)
   values(idea,p_hotel,p_job,p_item,btrim(p_name),p_quantity,'Idea','work_order',p_actor,coalesce(actor_name,''));
 end if;
 if idea is not null then
  update public.cmpri_order_ideas set item_text=btrim(p_name),inventory_item_id=p_item,quantity=p_quantity,
   status=case when p_line is not null and note_status='On Order' then 'Ordered' when p_line is not null and note_status='Received' then 'Received' when p_status='In-House' then 'Dismissed' when status in ('Dismissed','Received','Ordered') then 'Idea' else status end,
   created_by_user_id=coalesce(created_by_user_id,p_actor)
  where hotel_id=p_hotel and id=idea;
 end if;
 insert into public.cmpri_ticket_parts(id,hotel_id,work_order_id,name,inventory_item_id,requested_status,quantity,po_line_id,order_idea_id,actor_id)
 values(p_id,p_hotel,p_job,btrim(p_name),p_item,p_status,p_quantity,p_line,idea,p_actor)
 on conflict(id) do update set name=excluded.name,inventory_item_id=excluded.inventory_item_id,requested_status=excluded.requested_status,
 quantity=excluded.quantity,po_line_id=excluded.po_line_id,order_idea_id=excluded.order_idea_id,actor_id=excluded.actor_id,
 revision=cmpri_ticket_parts.revision+1,updated_at=now();
 if p_status='In-House' or p_line is distinct from prior.po_line_id or prior.id is not null then
  perform public.cmpri_part_ticket_note(p_hotel,p_job,p_actor,'[Parts] '||btrim(p_name)||' · '||p_quantity||' required · '||note_status||
   case when p_line is not null then ' · Linked PO '||coalesce(line_label,'')||' / '||ln.description when prior.po_line_id is not null then ' · PO link removed' else '' end);
 end if;
 return p_id;
end $$;
revoke all on function public.cmpri_save_ticket_part(uuid,uuid,uuid,uuid,text,uuid,text,numeric,uuid,bigint) from public,anon,authenticated;
grant execute on function public.cmpri_save_ticket_part(uuid,uuid,uuid,uuid,text,uuid,text,numeric,uuid,bigint) to service_role;

-- Order Ideas stay in their existing workspace, with their conversation on the ticket.
create function public.cmpri_order_idea_ticket_note() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if new.work_order_id is null then return new; end if;
 if tg_op='UPDATE' and (new.item_text,new.quantity,new.status,new.notes) is not distinct from (old.item_text,old.quantity,old.status,old.notes) then return new; end if;
 perform public.cmpri_part_ticket_note(new.hotel_id,new.work_order_id,
  case when current_setting('cmpri.parts_system',true)='true' then null else coalesce(nullif(current_setting('cmpri.parts_actor',true),'')::uuid,new.created_by_user_id) end,
  '[Order idea] '||new.item_text||' · '||coalesce(new.quantity::text,'quantity not specified')||' · '||new.status||' · /engineering/parts'||
  case when coalesce(new.notes,'')<>'' then ' · '||new.notes else '' end);
 return new;
end $$;
create trigger cmpri_order_idea_ticket_note after insert or update on public.cmpri_order_ideas for each row execute function public.cmpri_order_idea_ticket_note();

-- The established use transaction already serializes the item and prevents replay.
-- Its insert, deduction and this note commit or roll back as one transaction.
create function public.cmpri_supply_use_ticket_note() returns trigger language plpgsql security invoker set search_path='' as $$
declare item public.cmpri_inventory_items;
begin
 select * into item from public.cmpri_inventory_items where hotel_id=new.hotel_id and id=new.inventory_item_id;
 perform public.cmpri_part_ticket_note(new.hotel_id,new.work_order_id,new.actor_id,
  '[Supply use] Used '||new.quantity||' '||item.unit_of_measure||' '||item.item_name||' · On hand '||item.quantity_on_hand||' → '||(item.quantity_on_hand-new.quantity)||' '||item.unit_of_measure||
  case when coalesce(new.note,'')<>'' then ' · '||new.note else '' end);
 return new;
end $$;
create trigger cmpri_supply_use_ticket_note after insert on public.cmpri_supply_uses for each row execute function public.cmpri_supply_use_ticket_note();


-- Keep linked Order Ideas consistent with the same PO facts used by the ticket.
create function public.cmpri_reconcile_ticket_part_ideas(p_hotel uuid,p_line uuid,p_actor uuid)
returns void language plpgsql security invoker set search_path='' as $$
declare part record; next_status text;
begin
 perform set_config('cmpri.parts_actor',coalesce(p_actor::text,''),true);
 perform set_config('cmpri.parts_system',case when p_actor is null then 'true' else 'false' end,true);
 for part in select p.*,o.acceptance,o.origin,o.cancelled,
  coalesce((select sum(r.stock_quantity) from public.cmpri_po_receipts r where r.hotel_id=p_hotel and r.line_id=p_line),0) as received
  from public.cmpri_ticket_parts p join public.cmpri_po_lines l on l.id=p.po_line_id and l.hotel_id=p.hotel_id
  join public.cmpri_po_orders o on o.id=l.order_id and o.hotel_id=l.hotel_id
  where p.hotel_id=p_hotel and p.po_line_id=p_line and p.order_idea_id is not null
 loop
  next_status=case when part.received>=part.quantity then 'Received'
   when part.cancelled or (part.origin<>'manual' and part.acceptance<>'accepted') then 'Idea' else 'Ordered' end;
  update public.cmpri_order_ideas set status=next_status where hotel_id=p_hotel and id=part.order_idea_id and status is distinct from next_status;
 end loop;
end $$;
revoke all on function public.cmpri_reconcile_ticket_part_ideas(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.cmpri_reconcile_ticket_part_ideas(uuid,uuid,uuid) to service_role;

-- A corrected PO item is not automatically the part requested for the repair.
-- Require explicit relinking instead of silently switching the technician's supply.
create function public.cmpri_po_line_part_review() returns trigger language plpgsql security invoker set search_path='' as $$
declare part record;
begin
 if (new.inventory_item_id,new.description,new.uom,new.units_per_order_unit) is not distinct from (old.inventory_item_id,old.description,old.uom,old.units_per_order_unit) then return new; end if;
 perform set_config('cmpri.parts_actor','',true);
 perform set_config('cmpri.parts_system','true',true);
 for part in select * from public.cmpri_ticket_parts where hotel_id=new.hotel_id and po_line_id=new.id for update loop
  update public.cmpri_ticket_parts set po_line_id=null,requested_status='Need to Order',revision=revision+1,updated_at=now() where id=part.id;
  update public.cmpri_order_ideas set status='Idea' where hotel_id=new.hotel_id and id=part.order_idea_id and status<>'Idea';
  perform public.cmpri_part_ticket_note(new.hotel_id,part.work_order_id,null,
   '[PO] Linked PO item or unit mapping changed for '||part.name||'. Review the part and relink the corrected PO item.');
 end loop;
 return new;
end $$;
create trigger cmpri_po_line_part_review after update on public.cmpri_po_lines for each row execute function public.cmpri_po_line_part_review();
revoke all on function public.cmpri_po_line_part_review() from public,anon,authenticated;
grant execute on function public.cmpri_po_line_part_review() to service_role;

create function public.cmpri_po_receipt_ticket_note() returns trigger language plpgsql security invoker set search_path='' as $$
declare part record; ln public.cmpri_po_lines; reference text;
begin
 select * into ln from public.cmpri_po_lines where hotel_id=new.hotel_id and id=new.line_id;
 perform public.cmpri_reconcile_ticket_part_ideas(new.hotel_id,new.line_id,new.actor_id);
 select coalesce(external_reference,supplier) into reference from public.cmpri_po_orders where hotel_id=new.hotel_id and id=ln.order_id;
 for part in select distinct work_order_id from public.cmpri_ticket_parts where hotel_id=new.hotel_id and po_line_id=new.line_id loop
  perform public.cmpri_part_ticket_note(new.hotel_id,part.work_order_id,new.actor_id,
   '[PO] Physical receipt: '||new.quantity||' '||ln.uom||' '||ln.description||' · PO '||reference||' · Stock added '||new.stock_quantity||' · '||new.note||' · /engineering/purchasing?order='||ln.order_id::text);
 end loop;
 return new;
end $$;
create trigger cmpri_po_receipt_ticket_note after insert on public.cmpri_po_receipts for each row execute function public.cmpri_po_receipt_ticket_note();
create function public.cmpri_po_state_ticket_note() returns trigger language plpgsql security invoker set search_path='' as $$
declare part record; ln record; note_actor uuid;
begin
 if (new.acceptance,new.cancelled) is not distinct from (old.acceptance,old.cancelled) then return new; end if;
 note_actor=case when new.cancelled is distinct from old.cancelled then null else new.accepted_by end;
 for ln in select distinct l.id from public.cmpri_po_lines l join public.cmpri_ticket_parts p on p.po_line_id=l.id and p.hotel_id=l.hotel_id where l.hotel_id=new.hotel_id and l.order_id=new.id loop
  perform public.cmpri_reconcile_ticket_part_ideas(new.hotel_id,ln.id,note_actor);
 end loop;
 for part in select distinct p.work_order_id from public.cmpri_ticket_parts p join public.cmpri_po_lines l on l.id=p.po_line_id and l.hotel_id=p.hotel_id where p.hotel_id=new.hotel_id and l.order_id=new.id loop
  perform public.cmpri_part_ticket_note(new.hotel_id,part.work_order_id,note_actor,
   '[PO] '||coalesce(new.external_reference,new.supplier)||' · '||case when new.cancelled then 'Cancelled' else new.acceptance end||case when coalesce(new.acceptance_note,'')<>'' then ' · '||new.acceptance_note else '' end||' · /engineering/purchasing?order='||new.id::text);
 end loop;
 return new;
end $$;
create trigger cmpri_po_state_ticket_note after update on public.cmpri_po_orders for each row execute function public.cmpri_po_state_ticket_note();
revoke all on function public.cmpri_order_idea_ticket_note(),public.cmpri_supply_use_ticket_note(),public.cmpri_po_receipt_ticket_note(),public.cmpri_po_state_ticket_note() from public,anon,authenticated;
grant execute on function public.cmpri_order_idea_ticket_note(),public.cmpri_supply_use_ticket_note(),public.cmpri_po_receipt_ticket_note(),public.cmpri_po_state_ticket_note() to service_role;
create function public.cmpri_update_idea_ticket_status(p_hotel uuid,p_actor uuid,p_id uuid,p_status text)
returns public.cmpri_order_ideas language plpgsql security invoker set search_path='' as $$
declare result public.cmpri_order_ideas; part public.cmpri_ticket_parts; actual_status text;
begin
 if p_actor is null or p_status is null or p_status not in ('Idea','Ready To Order','Ordered','Received','Dismissed') then raise exception 'Invalid order idea status'; end if;
 select * into part from public.cmpri_ticket_parts where hotel_id=p_hotel and order_idea_id=p_id;
 if found and p_status in ('Ordered','Received') then
  select case when coalesce((select sum(r.stock_quantity) from public.cmpri_po_receipts r where r.hotel_id=p_hotel and r.line_id=part.po_line_id),0)>=part.quantity then 'Received'
   when o.cancelled or (o.origin<>'manual' and o.acceptance<>'accepted') then 'Idea' else 'Ordered' end
  into actual_status from public.cmpri_po_lines l join public.cmpri_po_orders o on o.id=l.order_id and o.hotel_id=l.hotel_id
  where l.hotel_id=p_hotel and l.id=part.po_line_id;
  if actual_status is distinct from p_status then raise exception 'Link the accepted PO and record physical receipt in POs before changing this status'; end if;
 end if;
 perform set_config('cmpri.parts_actor',p_actor::text,true);
 perform set_config('cmpri.parts_system','false',true);
 update public.cmpri_order_ideas set status=p_status where hotel_id=p_hotel and id=p_id returning * into result;
 if not found then raise exception 'Order idea unavailable'; end if;
 return result;
end $$;
revoke all on function public.cmpri_update_idea_ticket_status(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.cmpri_update_idea_ticket_status(uuid,uuid,uuid,text) to service_role;

-- Default inventory-unit use must enforce whole counts just like explicit EA use.
-- Retain the original note/replay fingerprint for existing callers.
create or replace function public.cmpri_use_supply(p_hotel uuid,p_actor uuid,p_id uuid,p_job uuid,p_item uuid,p_quantity numeric,p_note text)
returns uuid language plpgsql security invoker set search_path='' as $$
declare unit text;
begin
 if p_quantity is null or p_quantity<=0 or p_quantity>999999999 or p_quantity<>round(p_quantity,3) or p_quantity::text in ('NaN','Infinity','-Infinity') then raise exception 'Invalid usage quantity'; end if;
 select upper(unit_of_measure) into unit from public.cmpri_inventory_items where hotel_id=p_hotel and id=p_item and active=true;
 if not found then raise exception 'Active inventory item not found'; end if;
 if unit in ('EA','EACH','EACHES') and p_quantity<>trunc(p_quantity) then raise exception 'Each usage requires a whole count'; end if;
 return public.cmpri_use_supply_precise(p_hotel,p_actor,p_id,p_job,p_item,p_quantity,p_note);
end $$;
revoke all on function public.cmpri_use_supply(uuid,uuid,uuid,uuid,uuid,numeric,text) from public,anon,authenticated;
grant execute on function public.cmpri_use_supply(uuid,uuid,uuid,uuid,uuid,numeric,text) to service_role;

-- Status and receipt totals are calculated with PostgreSQL numeric, never float sums.
create function public.cmpri_read_ticket_parts(p_hotel uuid,p_job uuid)
returns jsonb language sql stable security invoker set search_path='' as $$
 with totals as (
  select line_id,sum(stock_quantity) received from public.cmpri_po_receipts where hotel_id=p_hotel group by line_id
 ), parts as (
  select to_jsonb(p)||jsonb_build_object('received',coalesce(t.received,0)::text,'status',
   case when p.po_line_id is null then p.requested_status
    when l.id is null or o.id is null or p.inventory_item_id is distinct from l.inventory_item_id then 'Need to Order'
    when coalesce(t.received,0)>=p.quantity then 'Received'
    when o.cancelled or (o.origin<>'manual' and o.acceptance<>'accepted') then 'Need to Order' else 'On Order' end) as value
  from public.cmpri_ticket_parts p left join public.cmpri_po_lines l on l.hotel_id=p.hotel_id and l.id=p.po_line_id
  left join public.cmpri_po_orders o on o.hotel_id=l.hotel_id and o.id=l.order_id left join totals t on t.line_id=l.id
  where p.hotel_id=p_hotel and p.work_order_id=p_job order by p.created_at,p.id
 )
 select jsonb_build_object('parts',coalesce((select jsonb_agg(value) from parts),'[]'::jsonb),
 'receiptTotals',coalesce((select jsonb_agg(jsonb_build_object('line_id',line_id,'received',received::text)) from totals),'[]'::jsonb));
$$;
revoke all on function public.cmpri_read_ticket_parts(uuid,uuid) from public,anon,authenticated;
grant execute on function public.cmpri_read_ticket_parts(uuid,uuid) to service_role;

commit;
