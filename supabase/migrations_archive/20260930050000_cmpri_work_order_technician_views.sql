CREATE TABLE IF NOT EXISTS public.cmpri_work_order_technician_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id uuid NOT NULL,
  work_order_id uuid NOT NULL REFERENCES public.work_orders(id) ON DELETE CASCADE,
  work_order_display_id text NOT NULL,
  technician_user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  technician_name text NOT NULL,
  status_at_view text NOT NULL,
  viewed_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE (hotel_id, work_order_id, technician_user_id)
);

CREATE INDEX IF NOT EXISTS cmpri_work_order_technician_views_pending_idx
  ON public.cmpri_work_order_technician_views(hotel_id, viewed_at)
  WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS cmpri_work_order_technician_views_resolved_idx
  ON public.cmpri_work_order_technician_views(hotel_id, resolved_at)
  WHERE resolved_at IS NOT NULL;

ALTER TABLE public.cmpri_work_order_technician_views ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cmpri_work_order_technician_views FROM anon, authenticated;
GRANT ALL ON public.cmpri_work_order_technician_views TO service_role;

CREATE OR REPLACE FUNCTION public.cmpri_resolve_technician_view_notifications()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    UPDATE public.cmpri_work_order_technician_views
    SET resolved_at = now()
    WHERE hotel_id = NEW.hotel_id
      AND work_order_id = NEW.id
      AND resolved_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS cmpri_resolve_technician_view_notifications ON public.work_orders;
CREATE TRIGGER cmpri_resolve_technician_view_notifications
AFTER UPDATE OF status ON public.work_orders
FOR EACH ROW
EXECUTE FUNCTION public.cmpri_resolve_technician_view_notifications();
