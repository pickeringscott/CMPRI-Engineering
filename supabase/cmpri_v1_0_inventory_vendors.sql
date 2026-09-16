-- CMPRI v1.0 inventory, vendor and proposal records.
-- Source-only migration. Apply only through the approved V1.0 migration bundle.
-- Browser clients receive no direct table policies; authenticated server routes enforce
-- exact-property scope and application capabilities before using the service client.

create table if not exists public.cmpri_vendors (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  company_name text not null,
  services text[] not null default '{}',
  main_phone text not null default '',
  email text not null default '',
  website text not null default '',
  emergency_phone text not null default '',
  preferred boolean not null default false,
  approved boolean not null default false,
  notes text not null default '',
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (hotel_id, company_name)
);

create table if not exists public.cmpri_vendor_contacts (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  vendor_id uuid not null references public.cmpri_vendors(id) on delete cascade,
  name text not null,
  role_title text not null default '',
  phone text not null default '',
  mobile_phone text not null default '',
  email text not null default '',
  emergency_contact boolean not null default false,
  active boolean not null default true,
  notes text not null default '',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.cmpri_vendor_proposals (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  vendor_id uuid not null references public.cmpri_vendors(id) on delete restrict,
  vendor_contact_id uuid references public.cmpri_vendor_contacts(id) on delete set null,
  asset_id uuid references public.assets(id) on delete set null,
  location_id uuid references public.locations(id) on delete set null,
  work_order_id uuid references public.work_orders(id) on delete set null,
  proposal_number text not null default '',
  proposal_date date not null default current_date,
  recommendation text not null default '' check (recommendation in ('', 'Repair', 'Replace', 'Repair Or Replace', 'Other')),
  status text not null default 'Pending' check (status in ('Pending', 'Approved', 'Declined', 'Expired', 'Completed')),
  quoted_cost numeric(12,2) not null default 0 check (quoted_cost >= 0),
  scope_summary text not null default '',
  storage_path text not null default '',
  vendor_company_snapshot text not null,
  vendor_contact_snapshot text not null default '',
  vendor_phone_snapshot text not null default '',
  vendor_email_snapshot text not null default '',
  notes text not null default '',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.cmpri_inventory_items (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  preferred_vendor_id uuid references public.cmpri_vendors(id) on delete set null,
  item_name text not null,
  description text not null default '',
  manufacturer text not null default '',
  vendor_sku text not null default '',
  product_url text not null default '',
  package_quantity numeric(12,3) not null default 1 check (package_quantity > 0),
  unit_of_measure text not null default 'Each',
  quantity_on_hand numeric(12,3) not null default 0 check (quantity_on_hand >= 0),
  quantity_reserved numeric(12,3) not null default 0 check (quantity_reserved >= 0),
  reorder_level numeric(12,3) check (reorder_level is null or reorder_level >= 0),
  suggested_order_quantity numeric(12,3) check (suggested_order_quantity is null or suggested_order_quantity > 0),
  storage_location text not null default '',
  current_unit_cost numeric(12,2) check (current_unit_cost is null or current_unit_cost >= 0),
  active boolean not null default true,
  notes text not null default '',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (quantity_reserved <= quantity_on_hand)
);

create unique index if not exists cmpri_inventory_item_identity_unique
  on public.cmpri_inventory_items (hotel_id, lower(item_name), coalesce(vendor_sku, ''));

create table if not exists public.cmpri_asset_inventory_compatibility (
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  asset_id uuid not null references public.assets(id) on delete cascade,
  inventory_item_id uuid not null references public.cmpri_inventory_items(id) on delete cascade,
  notes text not null default '',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (asset_id, inventory_item_id)
);

create table if not exists public.cmpri_work_order_items (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  work_order_id uuid not null references public.work_orders(id) on delete cascade,
  inventory_item_id uuid not null references public.cmpri_inventory_items(id) on delete restrict,
  status text not null default 'Suggested' check (status in ('Suggested', 'Reserved', 'Installed / Used', 'Returned To Inventory', 'Ordered', 'Received')),
  quantity numeric(12,3) not null check (quantity > 0),
  unit_cost_snapshot numeric(12,2) check (unit_cost_snapshot is null or unit_cost_snapshot >= 0),
  recorded_by_user_id uuid references auth.users(id) on delete set null,
  recorded_by_name text not null default '',
  recorded_at timestamptz not null default now(),
  notes text not null default ''
);

create table if not exists public.cmpri_inventory_movements (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  inventory_item_id uuid not null references public.cmpri_inventory_items(id) on delete restrict,
  work_order_item_id uuid references public.cmpri_work_order_items(id) on delete set null,
  movement_type text not null check (movement_type in ('Receipt', 'Use', 'Reservation', 'Release', 'Return', 'Adjustment')),
  quantity_change numeric(12,3) not null check (quantity_change <> 0),
  unit_cost numeric(12,2) check (unit_cost is null or unit_cost >= 0),
  performed_by_user_id uuid references auth.users(id) on delete set null,
  performed_by_name text not null default '',
  performed_at timestamptz not null default now(),
  notes text not null default ''
);

create table if not exists public.cmpri_order_ideas (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  inventory_item_id uuid references public.cmpri_inventory_items(id) on delete set null,
  asset_id uuid references public.assets(id) on delete set null,
  work_order_id uuid references public.work_orders(id) on delete set null,
  item_text text not null,
  quantity numeric(12,3) check (quantity is null or quantity > 0),
  status text not null default 'Idea' check (status in ('Idea', 'Ready To Order', 'Ordered', 'Received', 'Dismissed')),
  source text not null default 'manual' check (source in ('manual', 'work_order', 'inventory_reorder')),
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_by_name text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  notes text not null default ''
);

create index if not exists cmpri_vendor_proposals_asset_idx on public.cmpri_vendor_proposals(hotel_id, asset_id, proposal_date desc);
create index if not exists cmpri_vendor_proposals_work_order_idx on public.cmpri_vendor_proposals(hotel_id, work_order_id, proposal_date desc);
create index if not exists cmpri_inventory_reorder_idx on public.cmpri_inventory_items(hotel_id, quantity_on_hand, reorder_level) where active = true;
create index if not exists cmpri_compatibility_asset_idx on public.cmpri_asset_inventory_compatibility(hotel_id, asset_id);
create index if not exists cmpri_work_order_items_idx on public.cmpri_work_order_items(hotel_id, work_order_id, recorded_at desc);
create index if not exists cmpri_order_ideas_status_idx on public.cmpri_order_ideas(hotel_id, status, created_at desc);

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
