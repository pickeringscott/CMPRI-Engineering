BEGIN;

-- Add only the approved shared reads. The existing engineering policy remains
-- intact; drafts, pending verification, and other terminal states are not active.
-- No INSERT/UPDATE/DELETE grants, storage policies, or ticket data are changed.
DROP POLICY IF EXISTS work_orders_active_or_own_closed_select ON public.work_orders;
CREATE POLICY work_orders_active_or_own_closed_select
  ON public.work_orders
  FOR SELECT
  TO authenticated
  USING (
    public.is_hotel_member(hotel_id)
    AND (
      status IN ('Open', 'In Progress')
      OR (status = 'Closed' AND created_by = (SELECT auth.uid()))
    )
  );

COMMIT;
