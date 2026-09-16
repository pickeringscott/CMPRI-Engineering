-- CMPRI v1.0 operational email / purchasing integration schema
-- Safe to run more than once.
create extension if not exists pgcrypto;

create table if not exists public.cmpri_email_events (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null,
  gmail_message_id text not null unique,
  gmail_thread_id text,
  direction text not null default 'inbound',
  category text not null,
  confidence numeric(4,3),
  subject text,
  from_address text,
  to_address text,
  message_at timestamptz,
  parsed jsonb not null default '{}'::jsonb,
  body_text text,
  processed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.cmpri_purchases (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null,
  external_key text not null,
  order_number text,
  vendor text,
  status text not null default 'Ordered',
  ordered_at timestamptz,
  eta text,
  work_order_id uuid references public.work_orders(id) on delete set null,
  last_email_event_id uuid references public.cmpri_email_events(id) on delete set null,
  notes text,
  line_items jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(hotel_id, external_key)
);

create table if not exists public.cmpri_purchase_shipments (
  id uuid primary key default gen_random_uuid(),
  purchase_id uuid not null references public.cmpri_purchases(id) on delete cascade,
  tracking_number text,
  carrier text,
  ship_from text,
  status text not null default 'Shipped',
  shipped_at timestamptz,
  delivered_at timestamptz,
  received_at timestamptz,
  eta text,
  last_email_event_id uuid references public.cmpri_email_events(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists cmpri_purchase_shipments_tracking_unique
  on public.cmpri_purchase_shipments(purchase_id, tracking_number);

create table if not exists public.cmpri_enseo_tickets (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null,
  external_key text not null,
  ticket_number text,
  room_number text,
  enseo_endpoint text,
  status text,
  work_order_id uuid references public.work_orders(id) on delete set null,
  subject text,
  last_email_event_id uuid references public.cmpri_email_events(id) on delete set null,
  last_update_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(hotel_id, external_key)
);

create table if not exists public.cmpri_warranty_cases (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null,
  external_key text not null,
  warranty_case_number text,
  rma_number text,
  vendor text,
  status text not null default 'Open',
  work_order_id uuid references public.work_orders(id) on delete set null,
  last_email_event_id uuid references public.cmpri_email_events(id) on delete set null,
  tracking_numbers jsonb not null default '[]'::jsonb,
  ship_from text,
  eta text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(hotel_id, external_key)
);

create table if not exists public.cmpri_supplier_followups (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null,
  external_key text not null,
  purchase_id uuid references public.cmpri_purchases(id) on delete set null,
  work_order_id uuid references public.work_orders(id) on delete set null,
  topic text,
  status text not null default 'Vendor Contacted — Awaiting Response',
  last_outbound_at timestamptz,
  last_inbound_at timestamptz,
  last_email_event_id uuid references public.cmpri_email_events(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(hotel_id, external_key)
);

create table if not exists public.cmpri_gss_reports (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null,
  report_week date not null,
  subject text,
  scores jsonb not null default '{}'::jsonb,
  source_email_event_id uuid references public.cmpri_email_events(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(hotel_id, report_week)
);

create index if not exists cmpri_purchases_work_order_idx on public.cmpri_purchases(work_order_id);
create index if not exists cmpri_enseo_work_order_idx on public.cmpri_enseo_tickets(work_order_id);
create index if not exists cmpri_warranty_work_order_idx on public.cmpri_warranty_cases(work_order_id);
create index if not exists cmpri_email_events_message_at_idx on public.cmpri_email_events(message_at desc);

alter table public.cmpri_email_events enable row level security;
alter table public.cmpri_purchases enable row level security;
alter table public.cmpri_purchase_shipments enable row level security;
alter table public.cmpri_enseo_tickets enable row level security;
alter table public.cmpri_warranty_cases enable row level security;
alter table public.cmpri_supplier_followups enable row level security;
alter table public.cmpri_gss_reports enable row level security;

-- Forward-compatible column additions in case an earlier v1.0 draft of this schema was already applied.
alter table public.cmpri_email_events add column if not exists body_text text;
-- Existing events remain retryable: historical drafts could save an event before failing its operational writes.
alter table public.cmpri_email_events add column if not exists processed_at timestamptz;
-- PostgREST ON CONFLICT requires a non-partial unique index; the older partial index is retained harmlessly.
create unique index if not exists cmpri_purchase_shipments_upsert_unique
  on public.cmpri_purchase_shipments(purchase_id, tracking_number);
alter table public.cmpri_purchases add column if not exists line_items jsonb not null default '[]'::jsonb;
alter table public.cmpri_warranty_cases add column if not exists tracking_numbers jsonb not null default '[]'::jsonb;
alter table public.cmpri_warranty_cases add column if not exists ship_from text;
alter table public.cmpri_warranty_cases add column if not exists eta text;
