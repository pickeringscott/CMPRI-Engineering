-- CMPRI v1.0 source-draft provenance for supervisor submission.
-- A manager/chief may submit a subordinate's draft without erasing who created
-- the original report. The final submitter is stored separately.
begin;
alter table public.work_orders add column if not exists source_draft_id uuid;
alter table public.work_orders add column if not exists source_draft_created_by uuid references auth.users(id) on delete set null;
alter table public.work_orders add column if not exists source_draft_creator_name text;
alter table public.work_orders add column if not exists submitted_by_user_id uuid references auth.users(id) on delete set null;
alter table public.work_orders add column if not exists reporter_notes text;
create index if not exists cmpri_work_orders_source_draft_idx on public.work_orders(source_draft_id);
commit;
