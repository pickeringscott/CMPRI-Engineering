-- Harden user_feedback so reviewers can only change status/review fields directly,
-- and allow reviewers to delete feedback (e.g. spam/duplicates/test submissions).

-- Column-level UPDATE grant: even though the reviewer RLS policy allows the row,
-- Postgres will still block changes to any column not explicitly granted here.
REVOKE UPDATE ON public.user_feedback FROM authenticated;
GRANT UPDATE (status, reviewed_at, resolved_at) ON public.user_feedback TO authenticated;

-- Reviewers may delete feedback (e.g. spam/duplicate/test submissions).
GRANT DELETE ON public.user_feedback TO authenticated;

DROP POLICY IF EXISTS user_feedback_delete_reviewers ON public.user_feedback;
CREATE POLICY user_feedback_delete_reviewers ON public.user_feedback
  FOR DELETE TO authenticated
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
