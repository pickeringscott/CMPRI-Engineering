-- CMPRI V1.0 work-order provenance for submitted drafts and separated reporter notes.
alter table public.work_orders add column if not exists reporter_notes text;
alter table public.work_orders add column if not exists source_draft_id uuid;
alter table public.work_orders add column if not exists source_draft_created_by uuid;
alter table public.work_orders add column if not exists source_draft_creator_name text;
