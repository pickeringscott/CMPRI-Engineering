BEGIN;

-- Read access only. Membership checks include both profile and membership activation.
-- Existing INSERT/UPDATE/DELETE policies and all ticket rows remain unchanged.
DROP POLICY IF EXISTS work_orders_active_or_own_closed_select ON public.work_orders;
DROP POLICY IF EXISTS work_orders_all_active_members_select ON public.work_orders;
CREATE POLICY work_orders_all_active_members_select
  ON public.work_orders FOR SELECT TO authenticated
  USING (public.is_hotel_member(hotel_id));

COMMIT;
