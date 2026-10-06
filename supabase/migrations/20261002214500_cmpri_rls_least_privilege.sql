CREATE OR REPLACE FUNCTION public.is_hotel_member(target_hotel_id uuid)
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
    WHERE hm.hotel_id = target_hotel_id
      AND hm.user_id = auth.uid()
      AND hm.active = true
      AND p.active = true
  );
$$;

REVOKE ALL ON FUNCTION public.is_hotel_member(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_hotel_member(uuid) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.can_manage_hotel(target_hotel_id uuid)
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
    WHERE hm.hotel_id = target_hotel_id
      AND hm.user_id = auth.uid()
      AND hm.active = true
      AND p.active = true
      AND hm.role IN ('admin', 'manager')
  );
$$;

REVOKE ALL ON FUNCTION public.can_manage_hotel(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_manage_hotel(uuid) TO anon, authenticated, service_role;

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

CREATE OR REPLACE FUNCTION public.cmpri_can_submit_work_orders(target_hotel_id uuid)
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
        'technician',
        'maintenancetechnician',
        'frontdesk',
        'assistantgm',
        'assistantgeneralmanager',
        'assistantmanager',
        'salesmanager',
        'frontdeskmanager',
        'housekeeping',
        'leadhousekeeper',
        'executivehousekeeper',
        'systemadmin',
        'sysadmin',
        'systemadministrator',
        'administrator',
        'admin'
      ]::text[])
  );
$$;

REVOKE ALL ON FUNCTION public.cmpri_can_submit_work_orders(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cmpri_can_submit_work_orders(uuid) TO authenticated, service_role;

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.profiles FROM anon, authenticated;
GRANT SELECT ON TABLE public.profiles TO authenticated;
DROP POLICY IF EXISTS "Authenticated users can read profiles" ON public.profiles;
DROP POLICY IF EXISTS profiles_self_select ON public.profiles;
CREATE POLICY profiles_self_select
  ON public.profiles
  FOR SELECT
  TO authenticated
  USING (id = auth.uid());

ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.role_permissions FROM anon, authenticated;
GRANT SELECT ON TABLE public.role_permissions TO authenticated;
DROP POLICY IF EXISTS "Authenticated users can read role permissions" ON public.role_permissions;
CREATE POLICY "Authenticated users can read role permissions"
  ON public.role_permissions
  FOR SELECT
  TO authenticated
  USING (true);

DO $$
DECLARE
  access_policy record;
BEGIN
  FOR access_policy IN
    SELECT schemaname, tablename, policyname, qual
    FROM pg_policies
    WHERE schemaname = 'public'
      AND policyname LIKE '%member_access'
      AND tablename <> 'work_orders'
  LOOP
    IF access_policy.qual IS NULL THEN
      RAISE EXCEPTION 'Cannot safely narrow policy %.% without a USING expression',
        access_policy.tablename, access_policy.policyname;
    END IF;

    EXECUTE format(
      'DROP POLICY %I ON %I.%I',
      access_policy.policyname,
      access_policy.schemaname,
      access_policy.tablename
    );
    EXECUTE format(
      'CREATE POLICY %I ON %I.%I FOR SELECT TO authenticated USING (%s)',
      access_policy.policyname,
      access_policy.schemaname,
      access_policy.tablename,
      access_policy.qual
    );
    EXECUTE format(
      'REVOKE ALL ON TABLE %I.%I FROM anon, authenticated',
      access_policy.schemaname,
      access_policy.tablename
    );
    EXECUTE format(
      'GRANT SELECT ON TABLE %I.%I TO authenticated',
      access_policy.schemaname,
      access_policy.tablename
    );
    EXECUTE format(
      'ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',
      access_policy.schemaname,
      access_policy.tablename
    );
  END LOOP;
END;
$$;

ALTER TABLE public.work_orders ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.work_orders FROM anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.work_orders TO authenticated;
DROP POLICY IF EXISTS "Authenticated users can read work orders" ON public.work_orders;
DROP POLICY IF EXISTS "Authenticated users can create work orders" ON public.work_orders;
DROP POLICY IF EXISTS work_orders_member_access ON public.work_orders;
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
  );
CREATE POLICY "Authenticated users can create work orders"
  ON public.work_orders
  FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.uid() IS NOT NULL
    AND created_by = auth.uid()
    AND public.cmpri_can_submit_work_orders(hotel_id)
  );
