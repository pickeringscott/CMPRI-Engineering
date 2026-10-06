ALTER TABLE public.cmpri_dashboard_notifications
  ADD COLUMN IF NOT EXISTS read_at timestamptz;

ALTER TABLE public.cmpri_dashboard_notifications
  DROP CONSTRAINT IF EXISTS cmpri_dashboard_notifications_target;

ALTER TABLE public.cmpri_dashboard_notifications
  ADD CONSTRAINT cmpri_dashboard_notifications_target CHECK (
    (work_order_id IS NOT NULL AND target_path IS NULL)
    OR (
      work_order_id IS NULL
      AND target_path IN ('/engineering/room-operations', '/engineering/pool-log')
    )
  );

CREATE INDEX IF NOT EXISTS cmpri_dashboard_notifications_unread_idx
  ON public.cmpri_dashboard_notifications (hotel_id, recipient_user_id, recorded_at DESC)
  WHERE cleared_at IS NULL AND read_at IS NULL;
