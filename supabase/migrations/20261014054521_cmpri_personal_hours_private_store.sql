-- Local schema proposal only. Not a production migration; never auto-applied.
-- Server API enforces Chief Engineer, Assistant General Manager, Front Desk Manager, or Maintenance Technician eligibility and owner identity before every access.
create table public.cmpri_personal_hours (
  owner_id uuid primary key references auth.users(id),
  revision integer not null check (revision > 0),
  document jsonb not null check (jsonb_typeof(document) = 'object' and document->>'version' = '1')
);
alter table public.cmpri_personal_hours enable row level security;
alter table public.cmpri_personal_hours force row level security;
revoke all on public.cmpri_personal_hours from public, anon, authenticated;
grant select, insert, update on public.cmpri_personal_hours to service_role;
-- No browser, MCP, generic admin UI, or direct authenticated Data API access.
-- No DELETE endpoint/grant and no spreadsheet dependencies or attendance defaults.
