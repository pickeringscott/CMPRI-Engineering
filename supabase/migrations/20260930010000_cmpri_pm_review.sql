CREATE TABLE IF NOT EXISTS public.cmpri_pm_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id uuid NOT NULL,
  template_id text NOT NULL,
  period_start date NOT NULL,
  scope_key text NOT NULL,
  payload jsonb NOT NULL,
  proposed_cells jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'approved', 'rejected')),
  submitted_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  submitted_by_name text,
  reviewed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  review_note text,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cmpri_pm_proposals_scope_key_length CHECK (char_length(scope_key) BETWEEN 1 AND 120),
  CONSTRAINT cmpri_pm_proposals_payload_size CHECK (pg_column_size(payload) <= 262144),
  CONSTRAINT cmpri_pm_proposals_cells_size CHECK (pg_column_size(proposed_cells) <= 131072),
  CONSTRAINT cmpri_pm_proposals_review_note_length CHECK (char_length(coalesce(review_note, '')) <= 2000)
);

CREATE UNIQUE INDEX IF NOT EXISTS cmpri_pm_one_pending_proposal_per_scope
  ON public.cmpri_pm_proposals (hotel_id, template_id, period_start, scope_key)
  WHERE status IN ('pending', 'processing');

CREATE INDEX IF NOT EXISTS cmpri_pm_proposals_hotel_period_idx
  ON public.cmpri_pm_proposals (hotel_id, period_start, status);

CREATE INDEX IF NOT EXISTS cmpri_pm_proposals_review_queue_idx
  ON public.cmpri_pm_proposals (hotel_id, status, created_at DESC);

ALTER TABLE public.cmpri_pm_proposals ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.cmpri_pm_proposals FROM anon;
GRANT SELECT, INSERT, UPDATE ON public.cmpri_pm_proposals TO authenticated;
GRANT ALL ON public.cmpri_pm_proposals TO service_role;

DROP POLICY IF EXISTS cmpri_pm_proposals_member_read ON public.cmpri_pm_proposals;
CREATE POLICY cmpri_pm_proposals_member_read ON public.cmpri_pm_proposals
  FOR SELECT TO authenticated
  USING (
    hotel_id = 'c81ad01a-7a9f-4880-ac1c-5e849f30bad6'::uuid
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      JOIN public.hotel_members hm ON hm.user_id = p.id
      WHERE p.id = auth.uid() AND p.active = true
        AND hm.hotel_id = cmpri_pm_proposals.hotel_id AND hm.active = true
    )
  );

DROP POLICY IF EXISTS cmpri_pm_proposals_member_insert ON public.cmpri_pm_proposals;
CREATE POLICY cmpri_pm_proposals_member_insert ON public.cmpri_pm_proposals
  FOR INSERT TO authenticated
  WITH CHECK (
    hotel_id = 'c81ad01a-7a9f-4880-ac1c-5e849f30bad6'::uuid
    AND status = 'pending'
    AND submitted_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      JOIN public.hotel_members hm ON hm.user_id = p.id
      WHERE p.id = auth.uid() AND p.active = true
        AND hm.hotel_id = cmpri_pm_proposals.hotel_id AND hm.active = true
        AND regexp_replace(lower(p.role), '[^a-z]', '', 'g') IN (
          'engineer', 'chiefengineer', 'engineeringmanager', 'regionalmaintenance',
          'technician', 'maintenancetechnician',
          'systemadmin', 'systemadministrator', 'administrator', 'admin'
        )
    )
  );

DROP POLICY IF EXISTS cmpri_pm_proposals_submitter_update ON public.cmpri_pm_proposals;
CREATE POLICY cmpri_pm_proposals_submitter_update ON public.cmpri_pm_proposals
  FOR UPDATE TO authenticated
  USING (
    hotel_id = 'c81ad01a-7a9f-4880-ac1c-5e849f30bad6'::uuid
    AND submitted_by = auth.uid() AND status = 'pending'
  )
  WITH CHECK (
    hotel_id = 'c81ad01a-7a9f-4880-ac1c-5e849f30bad6'::uuid
    AND submitted_by = auth.uid() AND status = 'pending'
  );

DROP POLICY IF EXISTS cmpri_pm_proposals_reviewer_update ON public.cmpri_pm_proposals;
CREATE POLICY cmpri_pm_proposals_reviewer_update ON public.cmpri_pm_proposals
  FOR UPDATE TO authenticated
  USING (
    hotel_id = 'c81ad01a-7a9f-4880-ac1c-5e849f30bad6'::uuid
    AND status IN ('pending', 'processing')
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      JOIN public.hotel_members hm ON hm.user_id = p.id
      WHERE p.id = auth.uid() AND p.active = true
        AND hm.hotel_id = cmpri_pm_proposals.hotel_id AND hm.active = true
        AND regexp_replace(lower(p.role), '[^a-z]', '', 'g') IN (
          'systemadmin', 'systemadministrator', 'administrator', 'admin'
        )
    )
  )
  WITH CHECK (
    hotel_id = 'c81ad01a-7a9f-4880-ac1c-5e849f30bad6'::uuid
    AND status IN ('pending', 'processing', 'approved', 'rejected')
    AND (
      (status IN ('pending', 'processing') AND (reviewed_by IS NULL OR reviewed_by = auth.uid()))
      OR (status IN ('approved', 'rejected') AND reviewed_by = auth.uid())
    )
  );

CREATE OR REPLACE FUNCTION public.cmpri_pm_proposal_stamp()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  IF TG_OP = 'UPDATE' THEN
    NEW.created_at := OLD.created_at;
    NEW.revision := OLD.revision + 1;
  ELSE
    NEW.created_at := coalesce(NEW.created_at, now());
    NEW.revision := 1;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS cmpri_pm_proposal_stamp ON public.cmpri_pm_proposals;
CREATE TRIGGER cmpri_pm_proposal_stamp
  BEFORE INSERT OR UPDATE ON public.cmpri_pm_proposals
  FOR EACH ROW EXECUTE FUNCTION public.cmpri_pm_proposal_stamp();
