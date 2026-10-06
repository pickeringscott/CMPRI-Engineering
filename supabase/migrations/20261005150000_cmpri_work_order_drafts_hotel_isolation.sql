ALTER TABLE public.cmpri_work_order_drafts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cmpri_work_order_drafts_owner_select ON public.cmpri_work_order_drafts;
CREATE POLICY cmpri_work_order_drafts_owner_select
  ON public.cmpri_work_order_drafts
  FOR SELECT
  TO authenticated
  USING (
    created_by = auth.uid()
    AND EXISTS (
      SELECT 1
      FROM public.hotel_members AS membership
      WHERE membership.user_id = auth.uid()
        AND membership.hotel_id = cmpri_work_order_drafts.hotel_id
        AND membership.active = true
    )
  );

DROP POLICY IF EXISTS cmpri_work_order_drafts_owner_write ON public.cmpri_work_order_drafts;
CREATE POLICY cmpri_work_order_drafts_owner_write
  ON public.cmpri_work_order_drafts
  FOR ALL
  TO authenticated
  USING (
    created_by = auth.uid()
    AND EXISTS (
      SELECT 1
      FROM public.hotel_members AS membership
      WHERE membership.user_id = auth.uid()
        AND membership.hotel_id = cmpri_work_order_drafts.hotel_id
        AND membership.active = true
    )
  )
  WITH CHECK (
    created_by = auth.uid()
    AND EXISTS (
      SELECT 1
      FROM public.hotel_members AS membership
      WHERE membership.user_id = auth.uid()
        AND membership.hotel_id = cmpri_work_order_drafts.hotel_id
        AND membership.active = true
    )
  );
