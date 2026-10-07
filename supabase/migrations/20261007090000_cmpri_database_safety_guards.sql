CREATE OR REPLACE FUNCTION public.cmpri_update_user_access(
  p_user_id uuid,
  p_hotel_id uuid,
  p_expected_role text,
  p_expected_active boolean,
  p_full_name text,
  p_update_full_name boolean,
  p_new_role text,
  p_new_active boolean,
  p_expected_membership_role public.hotel_role,
  p_expected_membership_active boolean,
  p_new_membership_role public.hotel_role,
  p_new_membership_active boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_membership_role public.hotel_role;
  v_membership_active boolean;
  v_updated_id uuid;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required';
  END IF;
  IF p_user_id IS NULL OR p_hotel_id IS NULL OR p_expected_role IS NULL
    OR p_expected_active IS NULL OR p_expected_membership_role IS NULL
    OR p_expected_membership_active IS NULL THEN
    RAISE EXCEPTION 'Complete account revision details are required';
  END IF;
  IF p_update_full_name AND p_full_name IS NULL THEN
    RAISE EXCEPTION 'Full name cannot be null';
  END IF;

  SELECT hm.role, hm.active
    INTO v_membership_role, v_membership_active
    FROM public.hotel_members AS hm
    WHERE hm.hotel_id = p_hotel_id AND hm.user_id = p_user_id
    FOR UPDATE;

  IF NOT FOUND
    OR v_membership_role IS DISTINCT FROM p_expected_membership_role
    OR v_membership_active IS DISTINCT FROM p_expected_membership_active THEN
    RAISE EXCEPTION 'Account membership changed; reload and retry';
  END IF;

  UPDATE public.profiles AS p
    SET full_name = CASE WHEN p_update_full_name THEN p_full_name ELSE p.full_name END,
        role = COALESCE(p_new_role, p.role),
        active = COALESCE(p_new_active, p.active)
    WHERE p.id = p_user_id
      AND p.role = p_expected_role
      AND p.active = p_expected_active
    RETURNING p.id INTO v_updated_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Account changed; reload and retry';
  END IF;

  UPDATE public.hotel_members AS hm
    SET role = COALESCE(p_new_membership_role, hm.role),
        active = COALESCE(p_new_membership_active, hm.active)
    WHERE hm.hotel_id = p_hotel_id AND hm.user_id = p_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.cmpri_update_user_access(
  uuid, uuid, text, boolean, text, boolean, text, boolean,
  public.hotel_role, boolean, public.hotel_role, boolean
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cmpri_update_user_access(
  uuid, uuid, text, boolean, text, boolean, text, boolean,
  public.hotel_role, boolean, public.hotel_role, boolean
) TO service_role;

CREATE OR REPLACE FUNCTION public.cmpri_verify_asset_documentation(
  p_asset_id uuid,
  p_hotel_id uuid,
  p_expected_updated_at timestamptz,
  p_actor_id uuid
)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_verified_at timestamptz;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required';
  END IF;
  IF p_asset_id IS NULL OR p_hotel_id IS NULL
    OR p_expected_updated_at IS NULL OR p_actor_id IS NULL THEN
    RAISE EXCEPTION 'Complete equipment verification details are required';
  END IF;

  UPDATE public.assets AS a
    SET documentation_verified_at = pg_catalog.now(),
        documentation_verified_by = p_actor_id
    WHERE a.id = p_asset_id
      AND a.hotel_id = p_hotel_id
      AND a.updated_at = p_expected_updated_at
      AND a.documentation_verified_at IS NULL
    RETURNING a.documentation_verified_at INTO v_verified_at;

  IF FOUND THEN
    RETURN v_verified_at;
  END IF;

  SELECT a.documentation_verified_at
    INTO v_verified_at
    FROM public.assets AS a
    WHERE a.id = p_asset_id AND a.hotel_id = p_hotel_id;

  IF v_verified_at IS NOT NULL THEN
    RETURN v_verified_at;
  END IF;

  RAISE EXCEPTION 'Equipment changed during documentation verification';
END;
$$;

REVOKE ALL ON FUNCTION public.cmpri_verify_asset_documentation(uuid, uuid, timestamptz, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cmpri_verify_asset_documentation(uuid, uuid, timestamptz, uuid)
  TO service_role;

ALTER TABLE public.assets
  ADD COLUMN IF NOT EXISTS documentation_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS documentation_verified_by uuid;

CREATE OR REPLACE FUNCTION public.cmpri_protect_verified_asset()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF OLD.documentation_verified_at IS NOT NULL THEN
    IF (pg_catalog.to_jsonb(NEW) - ARRAY['updated_at'])
      IS DISTINCT FROM
      (pg_catalog.to_jsonb(OLD) - ARRAY['updated_at']) THEN
      RAISE EXCEPTION 'Verified equipment is locked against changes';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW.documentation_verified_at IS DISTINCT FROM OLD.documentation_verified_at
      OR NEW.documentation_verified_by IS DISTINCT FROM OLD.documentation_verified_by)
    AND current_user <> 'postgres' THEN
    RAISE EXCEPTION 'Equipment verification must use the verification procedure';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS cmpri_protect_verified_asset ON public.assets;
CREATE TRIGGER cmpri_protect_verified_asset
  BEFORE UPDATE ON public.assets
  FOR EACH ROW
  EXECUTE FUNCTION public.cmpri_protect_verified_asset();

CREATE OR REPLACE FUNCTION public.cmpri_prevent_hotel_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF current_user IN ('postgres', 'supabase_admin') THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Hotel records cannot be deleted through the application database role';
END;
$$;

DROP TRIGGER IF EXISTS cmpri_prevent_hotel_delete ON public.hotels;
CREATE TRIGGER cmpri_prevent_hotel_delete
  BEFORE DELETE ON public.hotels
  FOR EACH ROW
  EXECUTE FUNCTION public.cmpri_prevent_hotel_delete();

CREATE OR REPLACE FUNCTION public.cmpri_prevent_work_order_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF current_user IN ('postgres', 'supabase_admin') THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Work orders cannot be permanently deleted through the application database role; cancel the ticket instead';
END;
$$;

DROP TRIGGER IF EXISTS cmpri_prevent_work_order_delete ON public.work_orders;
CREATE TRIGGER cmpri_prevent_work_order_delete
  BEFORE DELETE ON public.work_orders
  FOR EACH ROW
  EXECUTE FUNCTION public.cmpri_prevent_work_order_delete();

DROP FUNCTION IF EXISTS public.purge_cmpri_user(uuid);
