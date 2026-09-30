-- Reconcile legacy v1.0 draft tables with the inventory/vendor API schema.
-- Legacy columns are retained; existing values are copied into current fields.
begin;

alter table public.cmpri_vendors
  add column if not exists name text not null default '',
  add column if not exists company_name text,
  add column if not exists phone text,
  add column if not exists services text[] not null default '{}',
  add column if not exists main_phone text not null default '',
  add column if not exists emergency_phone text not null default '',
  add column if not exists preferred boolean not null default false,
  add column if not exists approved boolean not null default false,
  add column if not exists active boolean not null default true,
  add column if not exists created_by uuid,
  add column if not exists updated_at timestamptz not null default now();

update public.cmpri_vendors
set company_name = coalesce(nullif(btrim(company_name), ''), nullif(btrim(name), ''), 'Legacy vendor ' || id::text),
    main_phone = coalesce(nullif(btrim(main_phone), ''), nullif(btrim(phone), ''), '')
where company_name is null or btrim(company_name) = '' or main_phone = '';

alter table public.cmpri_vendors
  alter column company_name set default '',
  alter column company_name set not null,
  alter column name set default '';

alter table public.cmpri_vendor_contacts
  add column if not exists hotel_id uuid,
  add column if not exists title text not null default '',
  add column if not exists role_title text not null default '',
  add column if not exists mobile_phone text not null default '',
  add column if not exists emergency_contact boolean not null default false,
  add column if not exists active boolean not null default true,
  add column if not exists created_by uuid,
  add column if not exists updated_at timestamptz not null default now();

update public.cmpri_vendor_contacts contacts
set hotel_id = vendors.hotel_id
from public.cmpri_vendors vendors
where contacts.vendor_id = vendors.id and contacts.hotel_id is null;

update public.cmpri_vendor_contacts
set role_title = coalesce(nullif(btrim(role_title), ''), nullif(btrim(title), ''), '')
where role_title = '';

alter table public.cmpri_vendor_proposals
  add column if not exists title text,
  add column if not exists summary text,
  add column if not exists vendor_contact_id uuid,
  add column if not exists location_id uuid,
  add column if not exists proposal_number text not null default '',
  add column if not exists proposal_date date not null default current_date,
  add column if not exists recommendation text not null default '',
  add column if not exists status text not null default 'Pending',
  add column if not exists quoted_cost numeric(12,2) not null default 0,
  add column if not exists scope_summary text not null default '',
  add column if not exists storage_path text not null default '',
  add column if not exists vendor_company_snapshot text not null default '',
  add column if not exists vendor_contact_snapshot text not null default '',
  add column if not exists vendor_phone_snapshot text not null default '',
  add column if not exists vendor_email_snapshot text not null default '',
  add column if not exists notes text not null default '',
  add column if not exists created_by uuid;

update public.cmpri_vendor_proposals proposals
set vendor_company_snapshot = coalesce(nullif(proposals.vendor_company_snapshot, ''), vendors.company_name),
    proposal_number = coalesce(nullif(proposals.proposal_number, ''), nullif(proposals.title, ''), ''),
    scope_summary = coalesce(nullif(proposals.scope_summary, ''), nullif(proposals.summary, ''), '')
from public.cmpri_vendors vendors
where proposals.vendor_id = vendors.id
  and (proposals.vendor_company_snapshot = '' or proposals.proposal_number = '' or proposals.scope_summary = '');

alter table public.cmpri_inventory_items
  add column if not exists name text not null default '',
  add column if not exists quantity integer not null default 0,
  add column if not exists min_quantity integer not null default 0,
  add column if not exists location text not null default '',
  add column if not exists category text,
  add column if not exists stock_on_hand integer,
  add column if not exists vendor_id uuid,
  add column if not exists unit_cost numeric(10,2),
  add column if not exists preferred_vendor_id uuid,
  add column if not exists item_name text not null default '',
  add column if not exists description text not null default '',
  add column if not exists manufacturer text not null default '',
  add column if not exists vendor_sku text not null default '',
  add column if not exists product_url text not null default '',
  add column if not exists package_quantity numeric(12,3) not null default 1,
  add column if not exists unit_of_measure text not null default 'Each',
  add column if not exists quantity_on_hand numeric(12,3) not null default 0,
  add column if not exists quantity_reserved numeric(12,3) not null default 0,
  add column if not exists reorder_level numeric(12,3),
  add column if not exists suggested_order_quantity numeric(12,3),
  add column if not exists storage_location text not null default '',
  add column if not exists current_unit_cost numeric(12,2),
  add column if not exists active boolean not null default true,
  add column if not exists created_by uuid;

update public.cmpri_inventory_items
set item_name = coalesce(nullif(btrim(item_name), ''), nullif(btrim(name), ''), 'Legacy inventory item ' || id::text),
    preferred_vendor_id = coalesce(preferred_vendor_id, vendor_id),
    quantity_on_hand = greatest(coalesce(quantity_on_hand, 0), coalesce(quantity, 0), coalesce(stock_on_hand, 0)),
    reorder_level = coalesce(reorder_level, min_quantity),
    storage_location = coalesce(nullif(storage_location, ''), location),
    current_unit_cost = coalesce(current_unit_cost, unit_cost);

alter table public.cmpri_inventory_items
  alter column name set default '';

create table if not exists public.cmpri_inventory_movements (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  inventory_item_id uuid not null references public.cmpri_inventory_items(id) on delete restrict,
  movement_type text not null check (movement_type in ('Receipt', 'Use', 'Reservation', 'Release', 'Return', 'Adjustment')),
  quantity_change numeric(12,3) not null check (quantity_change <> 0),
  work_order_item_id uuid references public.cmpri_work_order_items(id) on delete set null,
  unit_cost numeric(12,2) check (unit_cost is null or unit_cost >= 0),
  performed_by_user_id uuid references auth.users(id) on delete set null,
  performed_by_name text not null default '',
  performed_at timestamptz not null default now(),
  notes text not null default ''
);

alter table public.cmpri_inventory_movements
  add column if not exists quantity integer not null default 0,
  add column if not exists direction text not null default 'in',
  add column if not exists reason text,
  add column if not exists work_order_id uuid,
  add column if not exists actor_id uuid,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists movement_type text,
  add column if not exists quantity_change numeric(12,3),
  add column if not exists work_order_item_id uuid,
  add column if not exists unit_cost numeric(12,2),
  add column if not exists performed_by_user_id uuid,
  add column if not exists performed_by_name text not null default '',
  add column if not exists performed_at timestamptz not null default now(),
  add column if not exists notes text not null default '';

alter table public.cmpri_work_order_items
  add column if not exists name text not null default '',
  add column if not exists description text,
  add column if not exists qty integer,
  add column if not exists unit_cost numeric(12,2),
  add column if not exists quantity numeric(12,3),
  add column if not exists status text not null default 'Suggested',
  add column if not exists unit_cost_snapshot numeric(12,2),
  add column if not exists recorded_by_user_id uuid,
  add column if not exists recorded_by_name text not null default '',
  add column if not exists recorded_at timestamptz not null default now(),
  add column if not exists notes text not null default '';

alter table public.cmpri_work_order_items
  alter column name set default '',
  alter column quantity type numeric(12,3) using quantity::numeric;

update public.cmpri_work_order_items
set quantity = coalesce(quantity, qty, 1),
    name = coalesce(nullif(btrim(name), ''), nullif(btrim(description), ''), ''),
    unit_cost_snapshot = coalesce(unit_cost_snapshot, unit_cost);

alter table public.cmpri_work_order_items
  alter column quantity set default 1,
  alter column quantity set not null;

alter table public.cmpri_asset_inventory_compatibility
  add column if not exists hotel_id uuid,
  add column if not exists created_by uuid;

update public.cmpri_asset_inventory_compatibility compatibility
set hotel_id = assets.hotel_id
from public.assets assets
where compatibility.asset_id = assets.id and compatibility.hotel_id is null;

update public.cmpri_inventory_movements
set movement_type = coalesce(movement_type, case when lower(coalesce(direction, '')) = 'out' then 'Use' else 'Receipt' end),
    quantity_change = coalesce(quantity_change, case when lower(coalesce(direction, '')) = 'out' then -abs(quantity) else abs(quantity) end),
  direction = coalesce(direction, case when lower(coalesce(movement_type, '')) in ('use', 'reservation') then 'out' else 'in' end),
    performed_by_user_id = coalesce(performed_by_user_id, actor_id),
    performed_at = coalesce(performed_at, created_at),
    notes = coalesce(nullif(notes, ''), reason, '');

alter table public.cmpri_inventory_movements
  alter column quantity set default 0,
  alter column direction set default 'in';

alter table public.cmpri_order_ideas
  add column if not exists name text not null default '',
  add column if not exists item_name text,
  add column if not exists qty numeric(12,3),
  add column if not exists rationale text,
  add column if not exists inventory_item_id uuid,
  add column if not exists asset_id uuid,
  add column if not exists item_text text not null default '',
  add column if not exists quantity numeric(12,3),
  add column if not exists status text not null default 'Idea',
  add column if not exists source text not null default 'manual',
  add column if not exists notes text not null default '',
  add column if not exists created_by_user_id uuid,
  add column if not exists created_by_name text not null default '';

update public.cmpri_order_ideas
set item_text = coalesce(nullif(btrim(item_text), ''), nullif(btrim(item_name), ''), nullif(btrim(name), ''), 'Legacy order idea ' || id::text),
    quantity = coalesce(quantity, qty),
  notes = coalesce(nullif(btrim(notes), ''), nullif(btrim(rationale), ''), ''),
    source = coalesce(nullif(btrim(source), ''), 'manual')
where item_text = '' or quantity is null or notes = '' or source is null or btrim(source) = '';

alter table public.cmpri_order_ideas
  alter column name set default '',
  alter column item_name set default '',
  alter column qty set default 1,
  alter column notes set default '',
  alter column source set default 'manual';

alter table public.cmpri_vendors enable row level security;
alter table public.cmpri_vendor_contacts enable row level security;
alter table public.cmpri_vendor_proposals enable row level security;
alter table public.cmpri_inventory_items enable row level security;
alter table public.cmpri_asset_inventory_compatibility enable row level security;
alter table public.cmpri_work_order_items enable row level security;
alter table public.cmpri_inventory_movements enable row level security;
alter table public.cmpri_order_ideas enable row level security;

revoke all on public.cmpri_vendors from anon, authenticated;
revoke all on public.cmpri_vendor_contacts from anon, authenticated;
revoke all on public.cmpri_vendor_proposals from anon, authenticated;
revoke all on public.cmpri_inventory_items from anon, authenticated;
revoke all on public.cmpri_asset_inventory_compatibility from anon, authenticated;
revoke all on public.cmpri_work_order_items from anon, authenticated;
revoke all on public.cmpri_inventory_movements from anon, authenticated;
revoke all on public.cmpri_order_ideas from anon, authenticated;

grant select, insert, update, delete on public.cmpri_vendors, public.cmpri_vendor_contacts,
  public.cmpri_vendor_proposals, public.cmpri_inventory_items,
  public.cmpri_asset_inventory_compatibility, public.cmpri_work_order_items,
  public.cmpri_inventory_movements, public.cmpri_order_ideas to service_role;

create unique index if not exists cmpri_asset_inventory_compatibility_asset_item_uidx
  on public.cmpri_asset_inventory_compatibility(asset_id, inventory_item_id);

commit;