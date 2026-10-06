DO $$
DECLARE
  check_definition text;
  check_expression text;
BEGIN
  SELECT pg_get_constraintdef(oid)
    INTO check_definition
  FROM pg_constraint
  WHERE conrelid = 'public.profiles'::regclass
    AND conname = 'profiles_role_check';

  IF check_definition IS NULL THEN
    RAISE EXCEPTION 'Expected public.profiles.profiles_role_check to exist';
  END IF;

  IF position(quote_literal('assistant_manager') IN check_definition) = 0 THEN
    check_expression := substring(check_definition FROM 8 FOR char_length(check_definition) - 8);
    ALTER TABLE public.profiles DROP CONSTRAINT profiles_role_check;
    EXECUTE format(
      'ALTER TABLE public.profiles ADD CONSTRAINT profiles_role_check CHECK (role = %L OR (%s))',
      'assistant_manager',
      check_expression
    );
  END IF;

  ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_secondary_roles_check;
  ALTER TABLE public.profiles
    ADD CONSTRAINT profiles_secondary_roles_check
    CHECK (secondary_roles <@ ARRAY[
      'engineer',
      'manager',
      'senior_management',
      'technician',
      'front_desk',
      'front_desk_manager',
      'assistant_manager',
      'housekeeping'
    ]::text[]);
END $$;

CREATE OR REPLACE FUNCTION public.cmpri_can_view_work_orders(target_hotel_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.hotel_members hm
    JOIN public.profiles p ON p.id = hm.user_id
    CROSS JOIN LATERAL unnest(
      array_cat(ARRAY[p.role], COALESCE(p.secondary_roles, ARRAY[]::text[]))
    ) AS assigned(role_name)
    WHERE hm.user_id = auth.uid()
      AND hm.hotel_id = target_hotel_id
      AND hm.active = true
      AND p.active = true
      AND regexp_replace(lower(assigned.role_name), '[^a-z]', '', 'g') = ANY (ARRAY[
        'engineer',
        'engineers',
        'engineering',
        'chiefengineer',
        'engineeringmanager',
        'regionalmaintenance',
        'regionalengineer',
        'manager',
        'generalmanager',
        'gm',
        'seniormanagement',
        'uppermanagement',
        'vpfacilities',
        'regionaldirectoroperations',
        'districtmanager',
        'technician',
        'maintenancetechnician',
        'assistantgm',
        'assistantgeneralmanager',
        'assistantmanager',
        'frontdeskmanager',
        'systemadmin',
        'sysadmin',
        'systemadministrator',
        'administrator',
        'admin'
      ]::text[])
  );
$$;

CREATE OR REPLACE FUNCTION public.cmpri_can_view_open_work_orders_only(target_hotel_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.hotel_members hm
    JOIN public.profiles p ON p.id = hm.user_id
    CROSS JOIN LATERAL unnest(
      array_cat(ARRAY[p.role], COALESCE(p.secondary_roles, ARRAY[]::text[]))
    ) AS assigned(role_name)
    WHERE hm.user_id = auth.uid()
      AND hm.hotel_id = target_hotel_id
      AND hm.active = true
      AND p.active = true
      AND regexp_replace(lower(assigned.role_name), '[^a-z]', '', 'g') = ANY (ARRAY[
        'manager',
        'generalmanager',
        'gm',
        'assistantgm',
        'assistantgeneralmanager',
        'assistantmanager',
        'frontdeskmanager'
      ]::text[])
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.hotel_members hm
    JOIN public.profiles p ON p.id = hm.user_id
    CROSS JOIN LATERAL unnest(
      array_cat(ARRAY[p.role], COALESCE(p.secondary_roles, ARRAY[]::text[]))
    ) AS assigned(role_name)
    WHERE hm.user_id = auth.uid()
      AND hm.hotel_id = target_hotel_id
      AND hm.active = true
      AND p.active = true
      AND regexp_replace(lower(assigned.role_name), '[^a-z]', '', 'g') = ANY (ARRAY[
        'engineer',
        'engineers',
        'engineering',
        'chiefengineer',
        'engineeringmanager',
        'regionalmaintenance',
        'regionalengineer',
        'technician',
        'maintenancetechnician',
        'seniormanagement',
        'uppermanagement',
        'vpfacilities',
        'regionaldirectoroperations',
        'districtmanager',
        'systemadmin',
        'sysadmin',
        'systemadministrator',
        'administrator',
        'admin'
      ]::text[])
  );
$$;

CREATE OR REPLACE FUNCTION public.cmpri_can_view_pm(target_hotel_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.hotel_members hm
    JOIN public.profiles p ON p.id = hm.user_id
    CROSS JOIN LATERAL unnest(
      array_cat(ARRAY[p.role], COALESCE(p.secondary_roles, ARRAY[]::text[]))
    ) AS assigned(role_name)
    WHERE hm.user_id = auth.uid()
      AND hm.hotel_id = target_hotel_id
      AND hm.active = true
      AND p.active = true
      AND regexp_replace(lower(assigned.role_name), '[^a-z]', '', 'g') = ANY (ARRAY[
        'engineer',
        'engineers',
        'engineering',
        'chiefengineer',
        'engineeringmanager',
        'regionalmaintenance',
        'regionalengineer',
        'manager',
        'generalmanager',
        'gm',
        'seniormanagement',
        'uppermanagement',
        'vpfacilities',
        'regionaldirectoroperations',
        'districtmanager',
        'technician',
        'maintenancetechnician',
        'systemadmin',
        'sysadmin',
        'systemadministrator',
        'administrator',
        'admin'
      ]::text[])
  );
$$;

REVOKE ALL ON FUNCTION public.cmpri_can_view_work_orders(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cmpri_can_view_work_orders(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.cmpri_can_view_open_work_orders_only(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cmpri_can_view_open_work_orders_only(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.cmpri_can_view_pm(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cmpri_can_view_pm(uuid) TO authenticated, service_role;

DROP POLICY IF EXISTS work_orders_scoped_select ON public.work_orders;
CREATE POLICY work_orders_scoped_select
  ON public.work_orders
  FOR SELECT
  TO authenticated
  USING (
    public.is_hotel_member(hotel_id)
    AND (
      created_by = auth.uid()
      OR public.cmpri_can_view_work_orders(hotel_id)
    )
    AND (
      NOT public.cmpri_can_view_open_work_orders_only(hotel_id)
      OR status IN ('Open', 'In Progress')
    )
  );

DROP POLICY IF EXISTS cmpri_pm_proposals_member_read ON public.cmpri_pm_proposals;
CREATE POLICY cmpri_pm_proposals_member_read
  ON public.cmpri_pm_proposals
  FOR SELECT
  TO authenticated
  USING (
    hotel_id = 'c81ad01a-7a9f-4880-ac1c-5e849f30bad6'::uuid
    AND public.cmpri_can_view_pm(hotel_id)
  );
