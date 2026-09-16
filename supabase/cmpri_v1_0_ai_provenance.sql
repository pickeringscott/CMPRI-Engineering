-- CMPRI V1.0 manual AI refresh provenance.
-- AI provider calls are permitted only from the explicit Engineering Dashboard
-- "Refresh AI" action. This table records the human actor, an opaque random
-- browser-device id, timestamp, source action, model, and returned snapshot.

create table if not exists public.cmpri_ai_refresh_events (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete restrict,
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  actor_name text not null,
  device_id text not null check (device_id ~ '^[A-Za-z0-9_-]{16,100}$'),
  action text not null check (action = 'refresh-engineering-dashboard'),
  provider text not null,
  provider_model text not null,
  generated_at timestamptz not null,
  work_order_ids jsonb not null default '[]'::jsonb check (jsonb_typeof(work_order_ids) = 'array'),
  summary_count integer not null default 0 check (summary_count >= 0),
  limited boolean not null default false,
  output_snapshot jsonb not null default '[]'::jsonb check (jsonb_typeof(output_snapshot) = 'array'),
  created_at timestamptz not null default now()
);

create index if not exists cmpri_ai_refresh_events_hotel_generated_idx
  on public.cmpri_ai_refresh_events(hotel_id, generated_at desc);

alter table public.cmpri_ai_refresh_events enable row level security;

drop policy if exists "CMPRI members can read AI refresh provenance" on public.cmpri_ai_refresh_events;
create policy "CMPRI members can read AI refresh provenance"
  on public.cmpri_ai_refresh_events
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.hotel_members hm
      join public.profiles p on p.id = auth.uid()
      where hm.hotel_id = cmpri_ai_refresh_events.hotel_id
        and hm.user_id = auth.uid()
        and hm.active = true
        and p.active = true
        and lower(regexp_replace(p.role, '[^a-z0-9]', '', 'g')) in (
          'chiefengineer','engineeringmanager',
          'maintenancetechnician','technician','engineer','engineering',
          'regionalmaintenance','regionalengineer',
          'generalmanager','gm',
          'seniormanagement','uppermanagement','vpfacilities','regionaldirectoroperations','districtmanager',
          'systemadmin','systemadministrator','administrator','admin'
        )
    )
  );

comment on table public.cmpri_ai_refresh_events is
  'Audit-only provenance for explicit manual Engineering Dashboard AI refresh actions.';
