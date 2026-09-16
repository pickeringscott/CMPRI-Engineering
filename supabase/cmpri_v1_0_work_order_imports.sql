-- CMPRI v1.0 controlled legacy/spreadsheet work-order import provenance.
-- This does not create a new work-order status. Duplicate source records are
-- identified by source + external id and ordinary likely-duplicate checks.

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
