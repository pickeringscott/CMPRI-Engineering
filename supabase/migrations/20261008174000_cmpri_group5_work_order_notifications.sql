ALTER TABLE public.cmpri_web_push_deliveries
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz;

ALTER TABLE public.cmpri_web_push_deliveries
  DROP CONSTRAINT IF EXISTS cmpri_web_push_deliveries_status_check;

ALTER TABLE public.cmpri_web_push_deliveries
  ADD CONSTRAINT cmpri_web_push_deliveries_status_check
  CHECK (status IN ('pending', 'sending', 'sent', 'suppressed', 'failed'));

CREATE OR REPLACE FUNCTION public.cmpri_resolve_technician_new_order_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_role text;
BEGIN
  IF NEW.actor_user_id IS NULL OR NEW.event_type = 'created' THEN
    RETURN NEW;
  END IF;

  SELECT regexp_replace(lower(coalesce(p.role::text, '')), '[^a-z0-9]', '', 'g')
    INTO actor_role
    FROM public.profiles p
    JOIN public.hotel_members hm ON hm.user_id = p.id
   WHERE p.id = NEW.actor_user_id
     AND p.active = true
     AND hm.hotel_id = NEW.hotel_id
     AND hm.active = true;

  IF actor_role IS NULL OR actor_role NOT IN (
    'chiefengineer', 'engineer', 'engineering', 'engineeringmanager',
    'regionalmaintenance', 'regionalengineer', 'systemadmin',
    'systemadministrator', 'administrator', 'admin'
  ) THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.cmpri_work_order_engineering_views (
    hotel_id, work_order_id, work_order_display_id, engineering_user_id, viewed_at
  ) VALUES (
    NEW.hotel_id, NEW.work_order_id, coalesce(NEW.snapshot->>'display_id', ''),
    NEW.actor_user_id, NEW.recorded_at
  )
  ON CONFLICT (hotel_id, work_order_id, engineering_user_id) DO NOTHING;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.cmpri_enrich_work_order_notification_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_room text;
  v_issue text;
  v_actor_role text;
BEGIN
  SELECT w.room, w.issue
    INTO v_room, v_issue
    FROM public.work_orders w
   WHERE w.hotel_id = NEW.hotel_id
     AND w.id = NEW.work_order_id;

  NEW.snapshot := coalesce(NEW.snapshot, '{}'::jsonb)
    || jsonb_build_object('room', coalesce(v_room, ''), 'issue', coalesce(v_issue, ''));

  IF NEW.actor_user_id IS NOT NULL AND NEW.event_type IN ('status_changed', 'closed', 'reopened') THEN
    SELECT p.role::text INTO v_actor_role
      FROM public.profiles p
     WHERE p.id = NEW.actor_user_id;
    IF v_actor_role IS NOT NULL THEN
      NEW.changed_fields := coalesce(NEW.changed_fields, '{}'::jsonb)
        || jsonb_build_object('actor_role', v_actor_role);
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.cmpri_enrich_work_order_notification_history() FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS cmpri_enrich_work_order_notification_history ON public.cmpri_work_order_history;
CREATE TRIGGER cmpri_enrich_work_order_notification_history
BEFORE INSERT ON public.cmpri_work_order_history
FOR EACH ROW EXECUTE FUNCTION public.cmpri_enrich_work_order_notification_history();

CREATE OR REPLACE FUNCTION public.cmpri_resolve_technician_work_order_notification_reads()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.cmpri_dashboard_notifications n
     SET read_at = NEW.viewed_at
   WHERE n.hotel_id = NEW.hotel_id
     AND n.work_order_id = NEW.work_order_id
     AND n.notification_key = 'new-order:' || NEW.work_order_id::text
     AND n.cleared_at IS NULL
     AND n.read_at IS NULL
     AND n.recipient_user_id IN (
       SELECT p.id
         FROM public.profiles p
        WHERE regexp_replace(lower(coalesce(p.role::text, '')), '[^a-z0-9]', '', 'g')
              IN ('technician', 'maintenancetechnician')
     );

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.cmpri_resolve_technician_work_order_notification_reads() FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS cmpri_resolve_technician_work_order_notification_reads ON public.cmpri_work_order_technician_views;
CREATE TRIGGER cmpri_resolve_technician_work_order_notification_reads
AFTER INSERT ON public.cmpri_work_order_technician_views
FOR EACH ROW EXECUTE FUNCTION public.cmpri_resolve_technician_work_order_notification_reads();

CREATE OR REPLACE FUNCTION public.cmpri_resolve_technician_status_notification_reads()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.event_type IN ('status_changed', 'closed', 'reopened')
     AND NEW.old_status IS DISTINCT FROM NEW.new_status
     AND NEW.new_status IN ('In Progress', 'Pending Verification') THEN
    UPDATE public.cmpri_dashboard_notifications n
       SET read_at = NEW.recorded_at
     WHERE n.hotel_id = NEW.hotel_id
       AND n.work_order_id = NEW.work_order_id
       AND n.notification_key = 'new-order:' || NEW.work_order_id::text
       AND n.cleared_at IS NULL
       AND n.read_at IS NULL
       AND n.recipient_user_id IN (
         SELECT p.id
           FROM public.profiles p
          WHERE regexp_replace(lower(coalesce(p.role::text, '')), '[^a-z0-9]', '', 'g')
                IN ('technician', 'maintenancetechnician')
       );
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.cmpri_resolve_technician_status_notification_reads() FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS cmpri_resolve_technician_status_notification_reads ON public.cmpri_work_order_history;
CREATE TRIGGER cmpri_resolve_technician_status_notification_reads
AFTER INSERT ON public.cmpri_work_order_history
FOR EACH ROW EXECUTE FUNCTION public.cmpri_resolve_technician_status_notification_reads();

CREATE OR REPLACE FUNCTION public.cmpri_resolve_late_technician_notification_reads()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.notification_key LIKE 'new-order:%'
     AND EXISTS (
       SELECT 1
         FROM public.cmpri_work_order_history h
        WHERE h.hotel_id = NEW.hotel_id
          AND h.work_order_id = NEW.work_order_id
          AND h.event_type IN ('status_changed', 'closed', 'reopened')
          AND h.old_status IS DISTINCT FROM h.new_status
          AND h.new_status IN ('In Progress', 'Pending Verification')
          AND h.recorded_at >= NEW.recorded_at
     ) THEN
    UPDATE public.cmpri_dashboard_notifications n
       SET read_at = NEW.recorded_at
     WHERE n.id = NEW.id
       AND n.read_at IS NULL
       AND n.recipient_user_id IN (
         SELECT p.id
           FROM public.profiles p
          WHERE regexp_replace(lower(coalesce(p.role::text, '')), '[^a-z0-9]', '', 'g')
                IN ('technician', 'maintenancetechnician')
       );
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.cmpri_resolve_late_technician_notification_reads() FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS cmpri_resolve_late_technician_notification_reads ON public.cmpri_dashboard_notifications;
CREATE TRIGGER cmpri_resolve_late_technician_notification_reads
AFTER INSERT ON public.cmpri_dashboard_notifications
FOR EACH ROW EXECUTE FUNCTION public.cmpri_resolve_late_technician_notification_reads();
