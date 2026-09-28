CREATE OR REPLACE FUNCTION public.cmpri_check_work_order_submitter()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  caller_id uuid := auth.uid();
  caller public.profiles%rowtype;
  caller_membership public.hotel_members%rowtype;
  staff_name text;
  unsupported_name_chars text;
  normalized_role text;
BEGIN
  IF caller_id IS NULL THEN
    IF auth.role() = 'service_role' THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'An authenticated active account is required';
  END IF;

  SELECT * INTO caller FROM public.profiles WHERE id = caller_id;
  IF NOT FOUND OR caller.active IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'An active account is required';
  END IF;

  SELECT * INTO caller_membership
  FROM public.hotel_members
  WHERE user_id = caller_id AND hotel_id = NEW.hotel_id AND active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'An active membership for this property is required';
  END IF;

  normalized_role := regexp_replace(lower(coalesce(caller.role, '')), '[[:space:]_-]', '', 'g');
  NEW.created_by := caller_id;
  NEW.creator_account_user_id := caller_id;
  NEW.submitted_by_user_id := caller_id;

  IF normalized_role = 'frontdesk' THEN
    staff_name := regexp_replace(btrim(coalesce(NEW.submitted_by_name, '')), '[[:space:]]+', ' ', 'g');
    unsupported_name_chars := regexp_replace(staff_name, '[A-Za-z[:space:]''’-]', '', 'g');
    IF length(staff_name) < 2 OR length(staff_name) > 80
      OR unsupported_name_chars ~ '[[:ascii:]]'
      OR staff_name ~ '[0-9]'
      OR (staff_name !~ '[[:space:]]' AND (staff_name ~ '[A-Za-z]' OR octet_length(staff_name) <= char_length(staff_name)))
      OR staff_name ~ '(^|[[:space:]])[A-Za-z]([[:space:]]|$)' THEN
      RAISE EXCEPTION 'Enter your full name before submitting';
    END IF;
    NEW.submitted_by_name := staff_name;
    NEW.creator_name := staff_name;
    NEW.creator_source := 'front_desk_pending_verification';
    NEW.status := 'Pending Verification';
  ELSIF normalized_role IN (
    'assistantgm', 'assistantgeneralmanager', 'assistantmanager',
    'leadhousekeeper', 'executivehousekeeper', 'salesmanager'
  ) THEN
    NEW.submitted_by_name := NULL;
    NEW.creator_name := coalesce(nullif(btrim(caller.full_name), ''), 'Unknown User');
    NEW.creator_source := 'department_pending_verification';
    NEW.status := 'Pending Verification';
  ELSE
    NEW.submitted_by_name := NULL;
    NEW.creator_name := coalesce(nullif(btrim(caller.full_name), ''), 'Unknown User');
    NEW.creator_source := 'signed_in_user';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.cmpri_audit_work_order_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor uuid := coalesce(auth.uid(), NEW.submitted_by_user_id, NEW.creator_account_user_id, NEW.created_by);
  actor_label text := '';
  actor_role text := '';
  changed jsonb := '{}'::jsonb;
  event_name text := 'updated';
BEGIN
  IF actor IS NOT NULL THEN
    SELECT coalesce(nullif(btrim(p.full_name), ''), ''), coalesce(p.role, '') INTO actor_label, actor_role
    FROM public.profiles p WHERE p.id = actor;
  END IF;
  IF actor_label = '' THEN
    actor_label := coalesce(nullif(btrim(NEW.creator_name), ''), 'System');
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF regexp_replace(lower(actor_role), '[^a-z0-9]', '', 'g') IN ('frontdesk', 'assistantgm', 'assistantgeneralmanager') THEN
      actor_label := coalesce(nullif(btrim(NEW.submitted_by_name), ''), actor_label);
    END IF;
    event_name := 'created';
    changed := to_jsonb(NEW);
  ELSE
    IF OLD.status IS DISTINCT FROM NEW.status THEN
      event_name := CASE
        WHEN OLD.status = 'Closed' AND NEW.status IN ('In Progress', 'Completed') THEN 'reopened'
        WHEN NEW.status = 'Closed' THEN 'closed'
        ELSE 'status_changed'
      END;
    END IF;
    changed := jsonb_strip_nulls(jsonb_build_object(
      'issue', CASE WHEN OLD.issue IS DISTINCT FROM NEW.issue THEN to_jsonb(NEW.issue) END,
      'asset_id', CASE WHEN OLD.asset_id IS DISTINCT FROM NEW.asset_id THEN to_jsonb(NEW.asset_id) END,
      'asset_name', CASE WHEN OLD.asset_name IS DISTINCT FROM NEW.asset_name THEN to_jsonb(NEW.asset_name) END,
      'category', CASE WHEN OLD.category IS DISTINCT FROM NEW.category THEN to_jsonb(NEW.category) END,
      'priority', CASE WHEN OLD.priority IS DISTINCT FROM NEW.priority THEN to_jsonb(NEW.priority) END,
      'technician_name', CASE WHEN OLD.technician_name IS DISTINCT FROM NEW.technician_name THEN to_jsonb(NEW.technician_name) END,
      'status', CASE WHEN OLD.status IS DISTINCT FROM NEW.status THEN to_jsonb(NEW.status) END,
      'notes', CASE WHEN OLD.notes IS DISTINCT FROM NEW.notes THEN to_jsonb(NEW.notes) END,
      'action_root_cause', CASE WHEN OLD.action_root_cause IS DISTINCT FROM NEW.action_root_cause THEN to_jsonb(NEW.action_root_cause) END,
      'parts', CASE WHEN OLD.parts IS DISTINCT FROM NEW.parts THEN to_jsonb(NEW.parts) END,
      'cost', CASE WHEN OLD.cost IS DISTINCT FROM NEW.cost THEN to_jsonb(NEW.cost) END,
      'hours', CASE WHEN OLD.hours IS DISTINCT FROM NEW.hours THEN to_jsonb(NEW.hours) END,
      'due_by', CASE WHEN OLD.due_by IS DISTINCT FROM NEW.due_by THEN to_jsonb(NEW.due_by) END
    ));
  END IF;

  INSERT INTO public.cmpri_work_order_history(
    hotel_id, work_order_id, actor_user_id, actor_name, event_type,
    old_status, new_status, changed_fields, snapshot
  ) VALUES (
    NEW.hotel_id, NEW.id, actor, actor_label, event_name,
    CASE WHEN TG_OP = 'UPDATE' THEN OLD.status::text ELSE NULL END,
    NEW.status::text, changed, to_jsonb(NEW)
  );
  RETURN NEW;
END;
$$;
