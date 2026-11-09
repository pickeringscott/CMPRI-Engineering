-- Deterministic inventory tracking. Server-only writes; existing stock and historical timestamps are preserved.
alter table public.cmpri_inventory_items
 add column item_type text not null default 'Supply' check(item_type in ('Chemical','Part','Supply')),
 add column storage_location_id uuid references public.locations(id),
 add column inventory_revision bigint not null default 1;
-- Resolve only an exact, unambiguous managed location; never infer storage or chemical identity from a name.
update public.cmpri_inventory_items i set storage_location_id=l.id from public.locations l
 where l.hotel_id=i.hotel_id and l.active and lower(btrim(l.name))=lower(btrim(i.storage_location))
 and not exists(select 1 from public.locations x where x.hotel_id=l.hotel_id and x.active and lower(btrim(x.name))=lower(btrim(l.name)) and x.id<>l.id);
update public.cmpri_inventory_items set item_type=case when lower(btrim(category)) in ('chemical','chemicals') then 'Chemical' when lower(btrim(category)) in ('part','parts') then 'Part' else 'Supply' end;
create index cmpri_inventory_storage_type on public.cmpri_inventory_items(hotel_id,storage_location_id,item_type) where active;
create index if not exists cmpri_inventory_movements_item on public.cmpri_inventory_movements(hotel_id,inventory_item_id);
create table public.cmpri_inventory_settings(hotel_id uuid primary key,pool_location_id uuid references public.locations(id));
insert into public.cmpri_inventory_settings(hotel_id,pool_location_id)
 select hotel_id,min(id::text)::uuid from public.locations where active and lower(btrim(name))='pool pump room' group by hotel_id having count(*)=1;
create table public.cmpri_inventory_operations(id uuid primary key,hotel_id uuid not null,actor_id uuid not null,request jsonb not null,result jsonb not null,created_at timestamptz not null default now());
create table public.cmpri_inventory_notes(
 id uuid primary key default gen_random_uuid(),hotel_id uuid not null,inventory_item_id uuid not null references public.cmpri_inventory_items(id),
 actor_id uuid,actor_name text not null,actor_role text not null default '',recorded_at timestamptz not null default now(),
 kind text not null,message text not null,quantity_before numeric,quantity_after numeric,reserved_before numeric,reserved_after numeric,unit text,
 movement_id uuid unique references public.cmpri_inventory_movements(id),work_order_id uuid,pool_log_id uuid,po_order_id uuid,source_date date
);
create index cmpri_inventory_notes_item_time on public.cmpri_inventory_notes(hotel_id,inventory_item_id,recorded_at desc,id desc);
alter table public.cmpri_inventory_movements add column source_type text,add column source_id uuid,add column source_date date;
alter table public.cmpri_inventory_settings enable row level security;
alter table public.cmpri_inventory_operations enable row level security;
alter table public.cmpri_inventory_notes enable row level security;
revoke all on public.cmpri_inventory_settings,public.cmpri_inventory_operations,public.cmpri_inventory_notes from public,anon,authenticated;
grant select on public.cmpri_inventory_settings to service_role;
grant select,insert on public.cmpri_inventory_operations,public.cmpri_inventory_notes to service_role;

create function public.cmpri_inventory_key(value text) returns text language sql immutable set search_path='' as $$
 select lower(regexp_replace(normalize(btrim(coalesce(value,'')),NFKC),'\s+',' ','g'));
$$;
revoke all on function public.cmpri_inventory_key(text) from public,anon,authenticated;
grant execute on function public.cmpri_inventory_key(text) to service_role;

create function public.cmpri_inventory_guard() returns trigger language plpgsql security invoker set search_path='' as $$
declare base text; identity_changed boolean;
begin
 base=case upper(new.unit_of_measure) when 'EACH' then 'EA' else upper(new.unit_of_measure) end;
 if new.quantity_on_hand<0 or new.quantity_reserved<0 or new.quantity_reserved>new.quantity_on_hand
  or new.quantity_on_hand::text in ('NaN','Infinity','-Infinity') or new.quantity_reserved::text in ('NaN','Infinity','-Infinity') then raise exception 'Invalid stock counts or insufficient unreserved stock'; end if;
 if base='EA' and (new.quantity_on_hand<>trunc(new.quantity_on_hand) or new.quantity_reserved<>trunc(new.quantity_reserved)) then raise exception 'Each inventory requires whole counts'; end if;
 if new.storage_location_id is not null then
  perform 1 from public.locations where id=new.storage_location_id and hotel_id=new.hotel_id;
  if not found then raise exception 'Storage location must belong to this property'; end if;
 end if;
 identity_changed=TG_OP='INSERT';
 if TG_OP='UPDATE' then
  if (case upper(new.unit_of_measure) when 'EACH' then 'EA' else upper(new.unit_of_measure) end) is distinct from (case upper(old.unit_of_measure) when 'EACH' then 'EA' else upper(old.unit_of_measure) end) and (old.quantity_on_hand<>0 or old.quantity_reserved<>0 or exists(select 1 from public.cmpri_inventory_movements where inventory_item_id=old.id)) then raise exception 'Stock unit cannot change after stock or movements are recorded'; end if;
  new.inventory_revision=old.inventory_revision+1;
  identity_changed=(new.item_name,new.manufacturer,new.vendor_sku,new.preferred_vendor_id,new.unit_of_measure) is distinct from (old.item_name,old.manufacturer,old.vendor_sku,old.preferred_vendor_id,old.unit_of_measure);
 end if;
 if identity_changed then
  perform pg_advisory_xact_lock(hashtextextended(new.hotel_id::text||public.cmpri_inventory_key(new.item_name),7));
  if exists(select 1 from public.cmpri_inventory_items i where i.hotel_id=new.hotel_id and i.id<>new.id
   and public.cmpri_inventory_key(i.item_name)=public.cmpri_inventory_key(new.item_name) and public.cmpri_inventory_key(i.manufacturer)=public.cmpri_inventory_key(new.manufacturer)
   and public.cmpri_inventory_key(i.vendor_sku)=public.cmpri_inventory_key(new.vendor_sku) and i.preferred_vendor_id is not distinct from new.preferred_vendor_id
   and (case upper(i.unit_of_measure) when 'EACH' then 'EA' else upper(i.unit_of_measure) end)=base) then raise exception using errcode='23505',message='Matching inventory already exists. Open the existing item.'; end if;
 end if;
 return new;
end $$;
revoke all on function public.cmpri_inventory_guard() from public,anon,authenticated;
grant execute on function public.cmpri_inventory_guard() to service_role;
create trigger aa_cmpri_inventory_guard before insert or update on public.cmpri_inventory_items for each row execute function public.cmpri_inventory_guard();

create function public.cmpri_inventory_movement_note() returns trigger language plpgsql security invoker set search_path='' as $$
declare item public.cmpri_inventory_items; actor_name text; actor_role text; po uuid; pool uuid; source_day date;
begin
 select * into item from public.cmpri_inventory_items where hotel_id=new.hotel_id and id=new.inventory_item_id;
 if not found then raise exception 'Movement inventory is outside this property'; end if;
 select full_name,role into actor_name,actor_role from public.profiles where id=new.performed_by_user_id;
 select l.order_id into po from public.cmpri_po_receipts r join public.cmpri_po_lines l on l.id=r.line_id and l.hotel_id=r.hotel_id where r.id=new.id and r.hotel_id=new.hotel_id;
 if new.source_type='Pool log' then
  select id,log_date into pool,source_day from public.pool_daily_logs where id=new.source_id and hotel_id=new.hotel_id;
  -- A pool log's BEFORE trigger inserts its movement before the new log row is visible.
  pool=new.source_id;source_day=coalesce(new.source_date,source_day);
 end if;
 insert into public.cmpri_inventory_notes(id,hotel_id,inventory_item_id,actor_id,actor_name,actor_role,recorded_at,kind,message,quantity_before,quantity_after,reserved_before,reserved_after,unit,movement_id,work_order_id,pool_log_id,po_order_id,source_date)
 values(new.id,new.hotel_id,item.id,new.performed_by_user_id,coalesce(nullif(new.performed_by_name,''),actor_name,'Recorded operator'),coalesce(actor_role,''),coalesce(new.performed_at,now()),
  coalesce(new.source_type,case when po is not null then 'PO receipt' when new.work_order_id is not null and new.movement_type='Use' then 'Work order usage' else new.movement_type end),
  coalesce(nullif(new.notes,''),new.movement_type||' '||abs(new.quantity_change)::text||' '||item.unit_of_measure),
  case when new.movement_type in ('Reservation','Release') then item.quantity_on_hand else item.quantity_on_hand-new.quantity_change end,item.quantity_on_hand,
  case when new.movement_type='Reservation' then item.quantity_reserved-abs(new.quantity_change) when new.movement_type='Release' then item.quantity_reserved+abs(new.quantity_change) else item.quantity_reserved end,item.quantity_reserved,item.unit_of_measure,new.id,new.work_order_id,pool,po,source_day);
 return new;
end $$;
revoke all on function public.cmpri_inventory_movement_note() from public,anon,authenticated;
grant execute on function public.cmpri_inventory_movement_note() to service_role;
create trigger cmpri_inventory_movement_note after insert on public.cmpri_inventory_movements for each row execute function public.cmpri_inventory_movement_note();
-- Old transactions retain their original timestamp and note, without inventing historical balances.
insert into public.cmpri_inventory_notes(id,hotel_id,inventory_item_id,actor_id,actor_name,actor_role,recorded_at,kind,message,unit,movement_id,work_order_id,po_order_id)
 select m.id,m.hotel_id,m.inventory_item_id,m.performed_by_user_id,coalesce(nullif(m.performed_by_name,''),p.full_name,'Recorded operator'),'',coalesce(m.performed_at,m.created_at),m.movement_type,
 coalesce(nullif(m.notes,''),m.movement_type||' '||abs(m.quantity_change)::text||' '||i.unit_of_measure),i.unit_of_measure,m.id,m.work_order_id,l.order_id
 from public.cmpri_inventory_movements m join public.cmpri_inventory_items i on i.id=m.inventory_item_id and i.hotel_id=m.hotel_id
 left join public.profiles p on p.id=m.performed_by_user_id left join public.cmpri_po_receipts r on r.id=m.id and r.hotel_id=m.hotel_id left join public.cmpri_po_lines l on l.id=r.line_id and l.hotel_id=r.hotel_id;
