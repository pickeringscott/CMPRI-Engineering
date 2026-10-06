-- Test against the real schema/RLS before deployment. No existing rows are deleted.
-- Existing active duplicates cause this migration to fail for review rather than
-- being silently discarded. Completed historical work is intentionally excluded;
-- similar wording and unknown-versus-known asset matches still need an atomic
-- database submission workflow before full duplicate prevention can be certified.
begin;
create unique index if not exists cmpri_work_orders_exact_pending_active_unique
on public.work_orders (
  hotel_id,
  location_id,
  (coalesce(asset_id::text, '')),
  (md5(btrim(regexp_replace(lower(coalesce(issue, '')), '[^[:alnum:]]+', ' ', 'g'))))
)
-- Compare enum values directly. Casting the observed enum to text here is
-- not immutable and PostgreSQL would reject an index predicate using that cast.
where status in ('Pending Verification', 'Open', 'In Progress');
commit;
