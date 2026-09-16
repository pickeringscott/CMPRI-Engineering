-- Actual public.work_order_status was inspected read-only on 2026-09-15:
-- Open, In Progress, Completed, Done. Preserve those historical values.
-- Apply and COMMIT this migration before the duplicate-index migration;
-- PostgreSQL cannot use a newly added enum value until its transaction commits.
begin;
alter type public.work_order_status add value if not exists 'Pending Verification';
alter type public.work_order_status add value if not exists 'Closed';
alter type public.work_order_status add value if not exists 'Will Not Do';
commit;
