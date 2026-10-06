BEGIN;

DROP POLICY IF EXISTS work_orders_scoped_select ON public.work_orders;
CREATE POLICY work_orders_scoped_select
  ON public.work_orders
  FOR SELECT
  TO authenticated
  USING (
    public.is_hotel_member(hotel_id)
    AND public.cmpri_can_view_work_orders(hotel_id)
    AND (
      NOT public.cmpri_can_view_open_work_orders_only(hotel_id)
      OR status IN ('Open', 'In Progress')
    )
  );

COMMIT;
