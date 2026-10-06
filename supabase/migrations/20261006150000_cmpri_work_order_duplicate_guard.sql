-- Prevent exact duplicate submissions, including pending approvals, even when
-- concurrent requests pass the application-level similarity check at the same time.
begin;
create unique index if not exists cmpri_work_orders_exact_pending_active_unique
on public.work_orders (
  hotel_id,
  location_id,
  (coalesce(asset_id::text, '')),
  (md5(btrim(regexp_replace(lower(coalesce(issue, '')), '[^[:alnum:]]+', ' ', 'g'))))
)
where status in ('Pending Verification', 'Open', 'In Progress');
commit;
