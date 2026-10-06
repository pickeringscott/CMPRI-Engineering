-- CMPRI v1.0 work-order drafts. Drafts are separate from submitted work orders.
begin;
create extension if not exists pgcrypto;
create table if not exists public.cmpri_work_order_drafts (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete restrict,
  staff_first_name text,
  location_id uuid not null references public.locations(id) on delete restrict,
  room text not null default '',
  issue text not null check (btrim(issue) <> ''),
  notes text not null default '',
  asset_id uuid references public.assets(id) on delete set null,
  asset_name text not null default '',
  category text not null default 'General',
  priority text not null default 'Medium',
  revision bigint not null default 1 check (revision >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists cmpri_work_order_drafts_owner_idx
  on public.cmpri_work_order_drafts(hotel_id, created_by, updated_at desc);
alter table public.cmpri_work_order_drafts enable row level security;

-- Direct client access is intentionally limited to a creator's own active-property drafts.
-- Supervisor access is mediated by the server route so the equal/superior policy remains centralized.
drop policy if exists cmpri_work_order_drafts_owner_select on public.cmpri_work_order_drafts;
create policy cmpri_work_order_drafts_owner_select on public.cmpri_work_order_drafts
for select using (
  created_by = auth.uid() and exists (
    select 1 from public.hotel_members m
    where m.user_id = auth.uid()
      and m.hotel_id = cmpri_work_order_drafts.hotel_id
      and m.active = true
  )
);
drop policy if exists cmpri_work_order_drafts_owner_write on public.cmpri_work_order_drafts;
create policy cmpri_work_order_drafts_owner_write on public.cmpri_work_order_drafts
for all using (
  created_by = auth.uid() and exists (
    select 1 from public.hotel_members m
    where m.user_id = auth.uid()
      and m.hotel_id = cmpri_work_order_drafts.hotel_id
      and m.active = true
  )
) with check (
  created_by = auth.uid() and exists (
    select 1 from public.hotel_members m
    where m.user_id = auth.uid()
      and m.hotel_id = cmpri_work_order_drafts.hotel_id
      and m.active = true
  )
);
commit;
