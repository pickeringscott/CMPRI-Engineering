-- Keep the profile role and property membership role in the same capability boundary.
UPDATE public.hotel_members hm
SET role = 'technician'
FROM public.profiles p
CROSS JOIN LATERAL unnest(
  array_cat(ARRAY[p.role], COALESCE(p.secondary_roles, ARRAY[]::text[]))
) AS assigned(role_name)
WHERE hm.user_id = p.id
  AND hm.role = 'viewer'
  AND regexp_replace(lower(assigned.role_name), '[^a-z]', '', 'g') = ANY (ARRAY[
    'frontdesk',
    'assistantgm',
    'assistantgeneralmanager',
    'assistantmanager',
    'salesmanager',
    'frontdeskmanager',
    'housekeeping',
    'leadhousekeeper',
    'executivehousekeeper'
  ]::text[]);

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
      AND hm.role IN ('admin', 'manager', 'technician', 'viewer')
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
      AND hm.role IN ('admin', 'manager', 'technician')
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

REVOKE ALL ON FUNCTION public.cmpri_can_view_work_orders(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cmpri_can_view_work_orders(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.cmpri_can_submit_work_orders(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cmpri_can_submit_work_orders(uuid) TO authenticated, service_role;
