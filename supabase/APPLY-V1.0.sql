-- CMPRI V1.0 database preparation. VALIDATE IN AN ISOLATED COPY BEFORE PRODUCTION.
-- Prepared from the observed 2026-09-15 column schema and tested in PGlite.
-- Existing production policies/triggers/constraints still require inspection.
-- No destructive data reset is included. Existing duplicates halt unique indexes.
-- Explicit commits are intentional: new enum values must commit before use.

-- SECTION: status_values
-- Actual public.work_order_status was inspected read-only on 2026-09-15:
-- Open, In Progress, Completed, Done. Preserve those historical values.
-- Apply and COMMIT this migration before the duplicate-index migration;
-- PostgreSQL cannot use a newly added enum value until its transaction commits.
begin;
alter type public.work_order_status add value if not exists 'Pending Verification';
alter type public.work_order_status add value if not exists 'Closed';
alter type public.work_order_status add value if not exists 'Will Not Do';
commit;


-- SECTION: integrations
begin;
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

commit;


-- SECTION: submitter_attribution
-- Apply to an isolated test database first. Core schema/RLS is not supplied here.
-- Preserve shared-account identity and the required individual first name.
begin;
alter table public.work_orders add column if not exists submitted_by_name text;

create or replace function public.cmpri_check_work_order_submitter()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  caller_id uuid := auth.uid();
  caller public.profiles%rowtype;
  staff_name text;
begin
  -- Scheduled service imports retain their separate provenance workflow.
  if caller_id is null then
    if auth.role() = 'service_role' then return new; end if;
    raise exception 'An authenticated active account is required';
  end if;
  select * into caller from public.profiles where id = caller_id;
  if not found or caller.active is distinct from true then
    raise exception 'An active account is required';
  end if;
  new.created_by := caller_id;
  new.creator_account_user_id := caller_id;
  if regexp_replace(lower(coalesce(caller.role, '')), '[[:space:]_-]', '', 'g') = 'frontdesk' then
    staff_name := btrim(coalesce(new.submitted_by_name, ''));
    if length(staff_name) < 1 or length(staff_name) > 80 or staff_name !~ '^[[:alpha:]][[:alpha:] ''’-]*$' then
      raise exception 'Enter your first name before submitting';
    end if;
    new.submitted_by_name := staff_name;
    new.creator_name := staff_name;
    new.creator_source := 'front_desk_pending_verification';
    new.status := 'Pending Verification';
  else
    new.submitted_by_name := null;
    new.creator_name := coalesce(nullif(btrim(caller.full_name), ''), 'Unknown User');
    new.creator_source := 'signed_in_user';
  end if;
  return new;
end;
$$;
drop trigger if exists cmpri_work_order_submitter on public.work_orders;
create trigger cmpri_work_order_submitter before insert on public.work_orders
for each row execute function public.cmpri_check_work_order_submitter();
commit;


-- SECTION: work_order_revision
-- Validate against an isolated copy of the actual schema before production.
-- Existing ticket content and attribution are preserved.
begin;
alter table public.work_orders add column if not exists revision bigint not null default 1;
create or replace function public.cmpri_bump_work_order_revision()
returns trigger language plpgsql set search_path = '' as $$
begin
  if TG_OP = 'INSERT' then
    new.revision := 1;
  else
    -- Ignore caller-supplied revisions; every writer advances the same counter.
    new.revision := old.revision + 1;
  end if;
  return new;
end;
$$;
drop trigger if exists cmpri_work_order_revision on public.work_orders;
create trigger cmpri_work_order_revision before insert or update on public.work_orders
for each row execute function public.cmpri_bump_work_order_revision();
commit;


-- SECTION: exact_duplicate_guard
-- Test against the real schema/RLS before deployment. No existing rows are deleted.
-- Existing active duplicates cause this migration to fail for review rather than
-- being silently discarded. Completed historical work is intentionally excluded;
-- similar wording and unknown-versus-known asset matches still need an atomic
-- database submission workflow before full duplicate prevention can be certified.
begin;
create unique index if not exists cmpri_work_orders_exact_active_unique
on public.work_orders (
  hotel_id,
  location_id,
  (coalesce(asset_id::text, '')),
  (md5(btrim(regexp_replace(lower(coalesce(issue, '')), '[^[:alnum:]]+', ' ', 'g'))))
)
-- Compare enum values directly. Casting the observed enum to text here is
-- not immutable and PostgreSQL would reject an index predicate using that cast.
where status in ('Open', 'In Progress');
commit;


-- SECTION: work_order_imports
-- Keep import-source deduplication available in the release schema.
begin;
alter table public.work_orders add column if not exists import_source text;
alter table public.work_orders add column if not exists import_external_id text;
alter table public.work_orders add column if not exists import_reported_at timestamptz;
alter table public.work_orders add column if not exists imported_at timestamptz;
alter table public.work_orders add column if not exists imported_by_user_id uuid references auth.users(id) on delete set null;
create unique index if not exists cmpri_work_orders_import_identity_unique
  on public.work_orders (hotel_id, import_source, import_external_id)
  where import_source is not null and btrim(import_source) <> ''
    and import_external_id is not null and btrim(import_external_id) <> '';
create index if not exists cmpri_work_orders_import_source_idx
  on public.work_orders (hotel_id, import_source, imported_at desc)
  where import_source is not null;
commit;


-- SECTION: pool_log_guard
-- Validate against the observed pool_daily_logs schema in an isolated database.
begin;
-- Two tests per day: a single AM result and a single PM result.
-- Retain shallow/deep records; a single sample has one recorded location.
alter table public.pool_daily_logs add column if not exists sample_location_am text check (sample_location_am in ('shallow','deep'));
alter table public.pool_daily_logs add column if not exists sample_location_pm text check (sample_location_pm in ('shallow','deep'));
alter table public.pool_daily_logs add column if not exists ph_am numeric;
alter table public.pool_daily_logs add column if not exists ph_pm numeric;
alter table public.pool_daily_logs add column if not exists sanitizer_am numeric;
alter table public.pool_daily_logs add column if not exists sanitizer_pm numeric;
alter table public.pool_daily_logs add column if not exists sanitizer_band_am text
  check (sanitizer_band_am in ('0', '1-2', '2-4', '3-6', '5-10', '7.5-15', '10-20'));
alter table public.pool_daily_logs add column if not exists sanitizer_band_pm text
  check (sanitizer_band_pm in ('0', '1-2', '2-4', '3-6', '5-10', '7.5-15', '10-20'));
alter table public.pool_daily_logs add column if not exists revision bigint not null default 1;
alter table public.pool_daily_logs add column if not exists updated_by uuid;
create unique index if not exists cmpri_pool_daily_log_unique
on public.pool_daily_logs(hotel_id, pool_facility_id, log_date);
create table if not exists public.cmpri_pool_log_history (
  id uuid primary key default gen_random_uuid(),
  pool_log_id uuid not null references public.pool_daily_logs(id),
  hotel_id uuid not null,
  actor_id uuid,
  recorded_at timestamptz not null default now(),
  snapshot jsonb not null
);
alter table public.cmpri_pool_log_history enable row level security;
create or replace function public.cmpri_stamp_pool_log()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := coalesce(auth.uid(),new.updated_by);
  actor_role text;
begin
  select regexp_replace(lower(p.role),'[[:space:]_-]','','g') into actor_role
  from public.profiles p join public.hotel_members m on m.user_id=p.id
  where p.id=actor and p.active=true and m.active=true and m.hotel_id=new.hotel_id;
  if actor_role is null or actor_role not in
    ('admin','administrator','systemadmin','chiefengineer','engineer','engineering',
     'technician','maintenancetechnician','regionalmaintenance','frontdeskmanager','generalmanager','gm',
     'assistantmanager','assistantgeneralmanager','assistantgm') then
    raise exception 'An active engineering account assigned to this property is required';
  end if;
  if (new.ph_am is null) <> (new.sanitizer_am is null and new.sanitizer_band_am is null)
    or (new.ph_pm is null) <> (new.sanitizer_pm is null and new.sanitizer_band_pm is null) then
    raise exception 'Each AM/PM sample requires both pH and bromine';
  end if;
  if (new.sanitizer_am is not null and new.sanitizer_band_am is not null)
    or (new.sanitizer_pm is not null and new.sanitizer_band_pm is not null) then
    raise exception 'Use either a numeric bromine reading or a selected range, not both';
  end if;
  if (new.ph_am is not null and new.sample_location_am is null)
    or (new.ph_pm is not null and new.sample_location_pm is null) then
    raise exception 'Each sample requires a shallow or deep location';
  end if;
  if new.ph_am is null then new.sample_location_am := null; end if;
  if new.ph_pm is null then new.sample_location_pm := null; end if;
  new.ph_shallow_am := case when new.sample_location_am = 'shallow' then new.ph_am else null end;
  new.ph_deep_am := case when new.sample_location_am = 'deep' then new.ph_am else null end;
  new.sanitizer_shallow_am := case when new.sample_location_am = 'shallow' then new.sanitizer_am else null end;
  new.sanitizer_deep_am := case when new.sample_location_am = 'deep' then new.sanitizer_am else null end;
  new.ph_shallow_pm := case when new.sample_location_pm = 'shallow' then new.ph_pm else null end;
  new.ph_deep_pm := case when new.sample_location_pm = 'deep' then new.ph_pm else null end;
  new.sanitizer_shallow_pm := case when new.sample_location_pm = 'shallow' then new.sanitizer_pm else null end;
  new.sanitizer_deep_pm := case when new.sample_location_pm = 'deep' then new.sanitizer_pm else null end;
  if new.ph_am < 7.2 or new.ph_am > 7.8
    or new.ph_pm < 7.2 or new.ph_pm > 7.8
    or new.sanitizer_band_am in ('0', '1-2', '7.5-15', '10-20')
    or new.sanitizer_band_pm in ('0', '1-2', '7.5-15', '10-20')
    or new.sanitizer_am <= 2 or new.sanitizer_am >= 7.5
    or new.sanitizer_pm <= 2 or new.sanitizer_pm >= 7.5 then
    new.closure_condition := true;
  end if;
  new.updated_by := actor;
  new.updated_at := now();
  if TG_OP = 'INSERT' then
    new.revision := 1;
    new.created_by := coalesce(auth.uid(),new.created_by);
  else
    new.revision := old.revision + 1;
    new.created_by := old.created_by;
  end if;
  return new;
end;
$$;
create or replace function public.cmpri_audit_pool_log()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.cmpri_pool_log_history(pool_log_id,hotel_id,actor_id,snapshot)
  values(new.id,new.hotel_id,new.updated_by,to_jsonb(new));
  return new;
end;
$$;
drop trigger if exists cmpri_pool_log_stamp on public.pool_daily_logs;
create trigger cmpri_pool_log_stamp before insert or update on public.pool_daily_logs
for each row execute function public.cmpri_stamp_pool_log();
drop trigger if exists cmpri_pool_log_audit on public.pool_daily_logs;
create trigger cmpri_pool_log_audit after insert or update on public.pool_daily_logs
for each row execute function public.cmpri_audit_pool_log();
commit;
