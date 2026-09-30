CREATE TABLE IF NOT EXISTS public.user_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  user_name text NOT NULL,
  user_role text NOT NULL,
  feedback_type text NOT NULL CHECK (feedback_type IN ('Problem', 'Bug', 'Suggestion')),
  description text NOT NULL CHECK (char_length(btrim(description)) BETWEEN 1 AND 10000),
  page_route text NOT NULL CHECK (char_length(page_route) BETWEEN 1 AND 500),
  app_version text NOT NULL CHECK (char_length(app_version) BETWEEN 1 AND 100),
  status text NOT NULL DEFAULT 'New' CHECK (status IN ('New', 'Reviewed', 'Planned', 'Resolved')),
  reviewed_at timestamptz,
  resolved_at timestamptz
);

CREATE INDEX IF NOT EXISTS user_feedback_hotel_created_at_idx
  ON public.user_feedback (hotel_id, created_at DESC);

CREATE INDEX IF NOT EXISTS user_feedback_hotel_status_created_at_idx
  ON public.user_feedback (hotel_id, status, created_at DESC);

REVOKE ALL ON public.user_feedback FROM anon;
GRANT SELECT, UPDATE ON public.user_feedback TO authenticated;
GRANT ALL ON public.user_feedback TO service_role;

ALTER TABLE public.user_feedback ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_feedback_read_own ON public.user_feedback;
CREATE POLICY user_feedback_read_own ON public.user_feedback
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    AND hotel_id = 'c81ad01a-7a9f-4880-ac1c-5e849f30bad6'::uuid
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      JOIN public.hotel_members hm ON hm.user_id = p.id
      WHERE p.id = auth.uid() AND p.active = true
        AND hm.hotel_id = user_feedback.hotel_id AND hm.active = true
    )
  );

DROP POLICY IF EXISTS user_feedback_read_reviewers ON public.user_feedback;
CREATE POLICY user_feedback_read_reviewers ON public.user_feedback
  FOR SELECT TO authenticated
  USING (
    hotel_id = 'c81ad01a-7a9f-4880-ac1c-5e849f30bad6'::uuid
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      JOIN public.hotel_members hm ON hm.user_id = p.id
      WHERE p.id = auth.uid() AND p.active = true AND hm.hotel_id = user_feedback.hotel_id AND hm.active = true
        AND regexp_replace(lower(p.role), '[^a-z]', '', 'g') IN (
          'engineer', 'chiefengineer',
          'systemadmin', 'systemadministrator', 'administrator', 'admin'
        )
    )
  );

DROP POLICY IF EXISTS user_feedback_submit_own ON public.user_feedback;

DROP POLICY IF EXISTS user_feedback_update_reviewers ON public.user_feedback;
CREATE POLICY user_feedback_update_reviewers ON public.user_feedback
  FOR UPDATE TO authenticated
  USING (
    hotel_id = 'c81ad01a-7a9f-4880-ac1c-5e849f30bad6'::uuid
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      JOIN public.hotel_members hm ON hm.user_id = p.id
      WHERE p.id = auth.uid() AND p.active = true AND hm.hotel_id = user_feedback.hotel_id AND hm.active = true
        AND regexp_replace(lower(p.role), '[^a-z]', '', 'g') IN (
          'engineer', 'chiefengineer',
          'systemadmin', 'systemadministrator', 'administrator', 'admin'
        )
    )
  )
  WITH CHECK (
    hotel_id = 'c81ad01a-7a9f-4880-ac1c-5e849f30bad6'::uuid
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      JOIN public.hotel_members hm ON hm.user_id = p.id
      WHERE p.id = auth.uid() AND p.active = true AND hm.hotel_id = user_feedback.hotel_id AND hm.active = true
        AND regexp_replace(lower(p.role), '[^a-z]', '', 'g') IN (
          'engineer', 'chiefengineer',
          'systemadmin', 'systemadministrator', 'administrator', 'admin'
        )
    )
  );
