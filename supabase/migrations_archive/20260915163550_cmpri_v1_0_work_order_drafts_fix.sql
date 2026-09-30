-- Fix cmpri_work_order_drafts to match source expectations
ALTER TABLE public.cmpri_work_order_drafts ADD COLUMN IF NOT EXISTS created_by uuid;
ALTER TABLE public.cmpri_work_order_drafts ADD COLUMN IF NOT EXISTS staff_first_name text;
ALTER TABLE public.cmpri_work_order_drafts ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 1;

-- Update created_by from user_id where needed
UPDATE public.cmpri_work_order_drafts SET created_by = user_id WHERE created_by IS NULL AND user_id IS NOT NULL;

-- Add RLS policies for drafts
DROP POLICY IF EXISTS cmpri_work_order_drafts_owner_select ON public.cmpri_work_order_drafts;
CREATE POLICY cmpri_work_order_drafts_owner_select ON public.cmpri_work_order_drafts
FOR SELECT USING (
  created_by = auth.uid() AND EXISTS (
    SELECT 1 FROM public.hotel_members m
    WHERE m.user_id = auth.uid() AND m.hotel_id = cmpri_work_order_drafts.hotel_id AND m.active = true
  )
);

DROP POLICY IF EXISTS cmpri_work_order_drafts_owner_write ON public.cmpri_work_order_drafts;
CREATE POLICY cmpri_work_order_drafts_owner_write ON public.cmpri_work_order_drafts
FOR ALL USING (
  created_by = auth.uid() AND EXISTS (
    SELECT 1 FROM public.hotel_members m
    WHERE m.user_id = auth.uid() AND m.hotel_id = cmpri_work_order_drafts.hotel_id AND m.active = true
  )
) WITH CHECK (
  created_by = auth.uid() AND EXISTS (
    SELECT 1 FROM public.hotel_members m
    WHERE m.user_id = auth.uid() AND m.hotel_id = cmpri_work_order_drafts.hotel_id AND m.active = true
  )
);

CREATE INDEX IF NOT EXISTS cmpri_work_order_drafts_owner_idx
  ON public.cmpri_work_order_drafts(hotel_id, created_by, updated_at desc);