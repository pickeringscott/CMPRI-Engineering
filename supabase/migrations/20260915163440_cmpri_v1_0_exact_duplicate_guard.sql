CREATE UNIQUE INDEX IF NOT EXISTS cmpri_work_orders_exact_active_unique
ON public.work_orders (
  hotel_id,
  location_id,
  (coalesce(asset_id::text, '')),
  (md5(btrim(regexp_replace(lower(coalesce(issue, '')), '[^[:alnum:]]+', ' ', 'g'))))
)
WHERE status IN ('Open', 'In Progress', 'Completed', 'Pending Verification');