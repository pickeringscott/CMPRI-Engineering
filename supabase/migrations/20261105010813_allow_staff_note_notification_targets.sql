BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
LOCK TABLE public.cmpri_dashboard_notifications IN ACCESS EXCLUSIVE MODE;
DO $guard$
BEGIN
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint
      WHERE conrelid='public.cmpri_dashboard_notifications'::regclass
        AND conname='cmpri_dashboard_notifications_target')
     IS DISTINCT FROM 'CHECK ((((work_order_id IS NOT NULL) AND (target_path IS NULL)) OR ((work_order_id IS NULL) AND (target_path = ANY (ARRAY[''/engineering/room-operations''::text, ''/engineering/pool-log''::text, ''/pool''::text])))))'
  THEN
    RAISE EXCEPTION 'Notification target constraint changed; aborting scoped update';
  END IF;
END $guard$;
ALTER TABLE public.cmpri_dashboard_notifications
  DROP CONSTRAINT cmpri_dashboard_notifications_target,
  ADD CONSTRAINT cmpri_dashboard_notifications_target
  CHECK (
    (work_order_id IS NOT NULL AND target_path IS NULL)
    OR
    (work_order_id IS NULL AND (
      target_path = ANY (ARRAY['/engineering/room-operations'::text, '/engineering/pool-log'::text, '/pool'::text])
      OR target_path ~ '^/staff-notes#note-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    ))
  );
COMMIT;