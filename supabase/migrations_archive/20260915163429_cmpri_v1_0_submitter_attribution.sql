-- Add missing provenance columns and submitter trigger
ALTER TABLE public.work_orders ADD COLUMN IF NOT EXISTS submitted_by_user_id uuid;
ALTER TABLE public.work_orders ADD COLUMN IF NOT EXISTS creator_account_user_id uuid;

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
  normalized_role text;
BEGIN
  IF caller_id IS NULL THEN
    IF auth.role() = 'service_role' THEN
      RETURN new;
    END IF;
    RAISE EXCEPTION 'An authenticated active account is required';
  END IF;

  SELECT * INTO caller FROM public.profiles WHERE id = caller_id;
  IF NOT found OR caller.active IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'An active account is required';
  END IF;

  SELECT * INTO caller_membership FROM public.hotel_members
  WHERE user_id = caller_id AND hotel_id = new.hotel_id AND active = true;
  IF NOT found THEN
    RAISE EXCEPTION 'An active membership for this property is required';
  END IF;

  normalized_role := regexp_replace(lower(coalesce(caller.role, '')), '[[:space:]_-]', '', 'g');
  new.created_by := caller_id;
  new.creator_account_user_id := caller_id;
  new.submitted_by_user_id := caller_id;

  IF normalized_role = 'frontdesk' THEN
    staff_name := btrim(coalesce(new.submitted_by_name, ''));
    IF length(staff_name) < 1 OR length(staff_name) > 80 OR staff_name !~ '^[[:alpha:]][[:alpha:] ''-]*$' THEN
      RAISE EXCEPTION 'Enter your first name before submitting';
    END IF;
    new.submitted_by_name := staff_name;
    new.creator_name := staff_name;
    new.creator_source := 'front_desk_pending_verification';
    new.status := 'Pending Verification';
  ELSIF normalized_role IN ('assistantgm','assistantgeneralmanager','assistantmanager','leadhousekeeper','executivehousekeeper','salesmanager') THEN
    new.submitted_by_name := NULL;
    new.creator_name := coalesce(nullif(btrim(caller.full_name), ''), 'Unknown User');
    new.creator_source := 'department_pending_verification';
    new.status := 'Pending Verification';
  ELSE
    new.submitted_by_name := NULL;
    new.creator_name := coalesce(nullif(btrim(caller.full_name), ''), 'Unknown User');
    new.creator_source := 'signed_in_user';
  END IF;

  RETURN new;
END;
$$;

DROP TRIGGER IF EXISTS cmpri_work_order_submitter ON public.work_orders;
CREATE TRIGGER cmpri_work_order_submitter
BEFORE INSERT ON public.work_orders
FOR EACH ROW EXECUTE FUNCTION public.cmpri_check_work_order_submitter();