BEGIN;

ALTER TABLE public.cmpri_work_order_history DROP CONSTRAINT cmpri_work_order_history_event_type_check;
ALTER TABLE public.cmpri_work_order_history ADD CONSTRAINT cmpri_work_order_history_event_type_check
CHECK (event_type IN ('created','status_changed','closed','reopened','claimed','assigned','unassigned','report_corrected'));

-- Uses the existing server-only actor capture and immutable history conventions.
-- This separate trigger leaves status/assignment history unchanged.
CREATE FUNCTION public.cmpri_log_report_correction()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  actor uuid := auth.uid();
  hint text := nullif(current_setting('cmpri.history_actor', true), '');
  actor_name text;
  changes jsonb := '{}'::jsonb;
  event_id uuid;
  event_time timestamptz;
  summary text;
BEGIN
  IF OLD.room IS NOT DISTINCT FROM NEW.room AND OLD.location_id IS NOT DISTINCT FROM NEW.location_id
     AND OLD.issue IS NOT DISTINCT FROM NEW.issue THEN RETURN NEW; END IF;
  IF actor IS NULL AND hint ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN actor := hint::uuid; END IF;
  SELECT p.full_name INTO actor_name FROM public.profiles p WHERE p.id = actor;
  IF NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = actor) THEN actor := NULL; END IF;
  IF OLD.room IS DISTINCT FROM NEW.room OR OLD.location_id IS DISTINCT FROM NEW.location_id THEN
    changes := changes || jsonb_build_object('room', jsonb_build_object('old', OLD.room, 'new', NEW.room),
      'location_id', jsonb_build_object('old', OLD.location_id, 'new', NEW.location_id));
  END IF;
  IF OLD.issue IS DISTINCT FROM NEW.issue THEN
    changes := changes || jsonb_build_object('issue', jsonb_build_object('old', OLD.issue, 'new', NEW.issue));
  END IF;
  INSERT INTO public.cmpri_work_order_history
    (hotel_id, work_order_id, actor_user_id, actor_name, event_type, old_status, new_status, changed_fields, snapshot, source)
  VALUES (NEW.hotel_id, NEW.id, actor, coalesce(nullif(btrim(actor_name),''),'System'), 'report_corrected',
    OLD.status::text, NEW.status::text, changes,
    jsonb_build_object('display_id', NEW.display_id, 'room', NEW.room, 'issue', NEW.issue),
    coalesce(nullif(current_setting('cmpri.history_source', true),''),'Direct database change'))
  RETURNING id, recorded_at INTO event_id, event_time;

  -- Every saved correction with an authenticated actor alerts other active Chief Engineers.
  -- One immutable event ID per successful change; retries/no-ops cannot reuse a new-ticket key.
  IF actor IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.profiles a JOIN public.hotel_members am ON am.user_id=a.id AND am.hotel_id=NEW.hotel_id AND am.active
    WHERE a.id=actor AND a.active AND (
      EXISTS (SELECT 1 FROM unnest(ARRAY[a.role::text] || coalesce(a.secondary_roles,ARRAY[]::text[])) r(label),
        regexp_split_to_table(r.label,'\s*(/|\+|,|&|\mand\M)\s*') part
        WHERE regexp_replace(lower(part),'[^a-z0-9]','','g')='chiefengineer'
          OR (OLD.status::text IN ('Open','In Progress') AND regexp_replace(lower(part),'[^a-z0-9]','','g') IN
            ('frontdeskmanager','assistantgm','assistantgeneralmanager','assistantmanager','manager','generalmanager','gm','technician','maintenancetechnician')))
      OR (a.id='750f77bf-7d5d-4ca6-8421-e025edea87ba'::uuid AND lower(btrim(a.email))='maint.cmpri@hawkeyehotels.com'
        AND regexp_replace(lower(a.role::text),'[^a-z0-9]','','g')='systemadmin' AND 'engineer'=ANY(a.secondary_roles))
    )
  ) THEN
    summary := concat(coalesce(NEW.display_id, NEW.id::text), ' (', NEW.room, ') corrected by ', coalesce(actor_name,'submitter'), ': ',
      CASE WHEN changes ? 'room' THEN concat('Room/Location ', OLD.room, ' → ', NEW.room) ELSE '' END,
      CASE WHEN changes ? 'room' AND changes ? 'issue' THEN '; ' ELSE '' END,
      CASE WHEN changes ? 'issue' THEN concat('Reported Issue: ', left(NEW.issue,180)) ELSE '' END);
    INSERT INTO public.cmpri_dashboard_notifications
      (hotel_id,recipient_user_id,notification_key,work_order_id,message,recorded_at,push_requested)
    SELECT NEW.hotel_id,p.id,'report-correction:' || event_id::text,NEW.id,left(summary,500),event_time,true
    FROM public.profiles p
    JOIN public.hotel_members m ON m.user_id=p.id AND m.hotel_id=NEW.hotel_id AND m.active
    WHERE p.active AND p.id <> actor AND (
      EXISTS (SELECT 1 FROM unnest(ARRAY[p.role::text] || coalesce(p.secondary_roles,ARRAY[]::text[])) r(label),
        regexp_split_to_table(r.label,'\s*(/|\+|,|&|\mand\M)\s*') part
        WHERE regexp_replace(lower(part),'[^a-z0-9]','','g')='chiefengineer')
      OR (p.id='750f77bf-7d5d-4ca6-8421-e025edea87ba'::uuid
        AND lower(btrim(p.email))='maint.cmpri@hawkeyehotels.com'
        AND regexp_replace(lower(p.role::text),'[^a-z0-9]','','g')='systemadmin'
        AND 'engineer'=ANY(p.secondary_roles))
    )
    ON CONFLICT (hotel_id,recipient_user_id,notification_key) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.cmpri_log_report_correction() FROM public,anon,authenticated;
CREATE TRIGGER cmpri_report_correction_history
AFTER UPDATE OF room,location_id,issue ON public.work_orders
FOR EACH ROW EXECUTE FUNCTION public.cmpri_log_report_correction();

COMMIT;
