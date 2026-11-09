-- Permit the existing pool-status notification destination without changing other target rules.
ALTER TABLE public.cmpri_dashboard_notifications
  DROP CONSTRAINT cmpri_dashboard_notifications_target,
  ADD CONSTRAINT cmpri_dashboard_notifications_target CHECK (
    (work_order_id IS NOT NULL AND target_path IS NULL)
    OR (work_order_id IS NULL AND target_path = ANY (ARRAY[
      '/engineering/room-operations'::text,
      '/engineering/pool-log'::text,
      '/pool'::text
    ]))
  );
