-- Add missing columns to work_orders
ALTER TABLE public.work_orders ADD COLUMN IF NOT EXISTS last_assigned_technician_name text NOT NULL DEFAULT '';
ALTER TABLE public.work_orders ADD COLUMN IF NOT EXISTS action_root_cause text;
ALTER TABLE public.work_orders ADD COLUMN IF NOT EXISTS parts text;
ALTER TABLE public.work_orders ADD COLUMN IF NOT EXISTS cost numeric(10,2);
ALTER TABLE public.work_orders ADD COLUMN IF NOT EXISTS hours numeric(5,1);

-- Add missing columns to existing cmpri_work_order_history table
ALTER TABLE public.cmpri_work_order_history ADD COLUMN IF NOT EXISTS actor_user_id uuid;
ALTER TABLE public.cmpri_work_order_history ADD COLUMN IF NOT EXISTS actor_name text NOT NULL DEFAULT '';
ALTER TABLE public.cmpri_work_order_history ADD COLUMN IF NOT EXISTS event_type text;
ALTER TABLE public.cmpri_work_order_history ADD COLUMN IF NOT EXISTS old_status text;
ALTER TABLE public.cmpri_work_order_history ADD COLUMN IF NOT EXISTS new_status text;
ALTER TABLE public.cmpri_work_order_history ADD COLUMN IF NOT EXISTS changed_fields jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.cmpri_work_order_history ADD COLUMN IF NOT EXISTS snapshot jsonb;
ALTER TABLE public.cmpri_work_order_history ADD COLUMN IF NOT EXISTS recorded_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS cmpri_work_order_history_ticket_idx
  ON public.cmpri_work_order_history(hotel_id, work_order_id, recorded_at);

-- Add RLS policy for history reads
DROP POLICY IF EXISTS cmpri_work_order_history_member_read ON public.cmpri_work_order_history;
CREATE POLICY cmpri_work_order_history_member_read ON public.cmpri_work_order_history
FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM public.hotel_members m
    JOIN public.profiles p ON p.id = auth.uid()
    WHERE m.user_id = auth.uid()
      AND m.hotel_id = cmpri_work_order_history.hotel_id
      AND m.active = true
      AND p.active = true
      AND lower(regexp_replace(p.role, '[^a-z0-9]', '', 'g')) IN (
        'chiefengineer','engineeringmanager',
        'maintenancetechnician','technician','engineer','engineering',
        'regionalmaintenance','regionalengineer',
        'generalmanager','gm',
        'seniormanagement','uppermanagement','vpfacilities','regionaldirectoroperations','districtmanager',
        'systemadmin','systemadministrator','administrator','admin'
      )
  )
);

-- Assignment memory trigger
CREATE OR REPLACE FUNCTION public.cmpri_record_work_order_history()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF coalesce(new.technician_name,'') <> '' THEN
      new.last_assigned_technician_name := new.technician_name;
    END IF;
    RETURN new;
  END IF;

  IF coalesce(new.technician_name,'') <> '' THEN
    new.last_assigned_technician_name := new.technician_name;
  ELSIF new.status = 'In Progress' AND coalesce(old.last_assigned_technician_name,'') <> '' THEN
    new.technician_name := old.last_assigned_technician_name;
    new.last_assigned_technician_name := old.last_assigned_technician_name;
  ELSE
    new.last_assigned_technician_name := old.last_assigned_technician_name;
  END IF;
  RETURN new;
END;
$$;

DROP TRIGGER IF EXISTS cmpri_work_order_assignment_memory ON public.work_orders;
CREATE TRIGGER cmpri_work_order_assignment_memory
BEFORE INSERT OR UPDATE ON public.work_orders
FOR EACH ROW EXECUTE FUNCTION public.cmpri_record_work_order_history();

-- Audit trigger
CREATE OR REPLACE FUNCTION public.cmpri_audit_work_order_history()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  actor uuid := coalesce(auth.uid(), new.submitted_by_user_id, new.creator_account_user_id, new.created_by);
  actor_label text := '';
  changed jsonb := '{}'::jsonb;
  event_name text := 'updated';
BEGIN
  IF actor IS NOT NULL THEN
    SELECT coalesce(nullif(btrim(p.full_name),''), '') INTO actor_label
    FROM public.profiles p WHERE p.id = actor;
  END IF;
  IF actor_label = '' THEN
    actor_label := coalesce(nullif(btrim(new.creator_name),''), 'System');
  END IF;

  IF TG_OP = 'INSERT' THEN
    event_name := 'created';
    changed := to_jsonb(new);
  ELSE
    IF old.status IS DISTINCT FROM new.status THEN
      event_name := CASE
        WHEN old.status = 'Closed' AND new.status IN ('In Progress','Completed') THEN 'reopened'
        WHEN new.status = 'Closed' THEN 'closed'
        ELSE 'status_changed'
      END;
    END IF;
    changed := jsonb_strip_nulls(jsonb_build_object(
      'issue', CASE WHEN old.issue IS DISTINCT FROM new.issue THEN to_jsonb(new.issue) END,
      'asset_id', CASE WHEN old.asset_id IS DISTINCT FROM new.asset_id THEN to_jsonb(new.asset_id) END,
      'asset_name', CASE WHEN old.asset_name IS DISTINCT FROM new.asset_name THEN to_jsonb(new.asset_name) END,
      'category', CASE WHEN old.category IS DISTINCT FROM new.category THEN to_jsonb(new.category) END,
      'priority', CASE WHEN old.priority IS DISTINCT FROM new.priority THEN to_jsonb(new.priority) END,
      'technician_name', CASE WHEN old.technician_name IS DISTINCT FROM new.technician_name THEN to_jsonb(new.technician_name) END,
      'status', CASE WHEN old.status IS DISTINCT FROM new.status THEN to_jsonb(new.status) END,
      'notes', CASE WHEN old.notes IS DISTINCT FROM new.notes THEN to_jsonb(new.notes) END,
      'action_root_cause', CASE WHEN old.action_root_cause IS DISTINCT FROM new.action_root_cause THEN to_jsonb(new.action_root_cause) END,
      'parts', CASE WHEN old.parts IS DISTINCT FROM new.parts THEN to_jsonb(new.parts) END,
      'cost', CASE WHEN old.cost IS DISTINCT FROM new.cost THEN to_jsonb(new.cost) END,
      'hours', CASE WHEN old.hours IS DISTINCT FROM new.hours THEN to_jsonb(new.hours) END,
      'due_by', CASE WHEN old.due_by IS DISTINCT FROM new.due_by THEN to_jsonb(new.due_by) END
    ));
  END IF;

  INSERT INTO public.cmpri_work_order_history(
    hotel_id, work_order_id, actor_user_id, actor_name, event_type,
    old_status, new_status, changed_fields, snapshot
  ) VALUES (
    new.hotel_id, new.id, actor, actor_label, event_name,
    CASE WHEN TG_OP='UPDATE' THEN old.status::text ELSE NULL END,
    new.status::text, changed, to_jsonb(new)
  );
  RETURN new;
END;
$$;

DROP TRIGGER IF EXISTS cmpri_work_order_history_audit ON public.work_orders;
CREATE TRIGGER cmpri_work_order_history_audit
AFTER INSERT OR UPDATE ON public.work_orders
FOR EACH ROW EXECUTE FUNCTION public.cmpri_audit_work_order_history();