/*
# CMPRI Test-User Purge Function

Adds a controlled way to permanently remove a CMPRI user and every row
attributed to them. Intended for pre-launch and post-launch back-end cleanup
of test accounts created to exercise front-end workflows. Real employee
lifecycle should still use `Deactivate` (profiles.active = false), which
preserves identity, notes, and audit history. This function is the
"nuclear" action reserved for test data.

1. New Functions
- public.purge_cmpri_user(target_id uuid)
  - Deletes all rows the target user authored across work orders,
    drafts, notes, history events, AI events, pool logs, and enseo
    assignments.
  - Null-out attribution on any remaining rows the target user only
    edited (updated_by, creator_account_user_id) so those rows survive.
  - Removes the user from hotel_members and profiles.
  - Runs as SECURITY DEFINER so the service-role admin client can call it
    atomically inside a single transaction.

2. Security
- Function is owned by the postgres role and marked SECURITY DEFINER.
- EXECUTE is REVOKED from PUBLIC and only granted to `service_role`, so
  the anon and authenticated web clients cannot call it directly.
- Callers must still pass through the /api/users DELETE handler, which
  enforces the CMPRI role hierarchy (equal cannot delete equal, superior
  cannot be deleted by a subordinate, self cannot delete self).
- Does NOT touch auth.users. The API layer removes the auth login via
  admin.auth.admin.deleteUser after this function returns, so a failed
  auth deletion cannot leave attribution rows still linked to a live login.

3. Notes
- Safe to re-run: every action is idempotent. Calling with an unknown or
  already-purged uuid is a no-op.
- work_orders rows where `creator_account_user_id` matches (Front Desk
  shared-account attribution) but `created_by` does not are preserved:
  those tickets belong to the real submitter, not the shared account.
*/

CREATE OR REPLACE FUNCTION public.purge_cmpri_user(target_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF target_id IS NULL THEN
    RETURN;
  END IF;

  DELETE FROM public.work_order_notes           WHERE author_id      = target_id;
  DELETE FROM public.cmpri_work_order_history   WHERE actor_user_id  = target_id;
  DELETE FROM public.cmpri_ai_refresh_events    WHERE actor_user_id  = target_id;
  DELETE FROM public.cmpri_work_order_drafts    WHERE created_by     = target_id OR user_id = target_id;
  DELETE FROM public.work_orders                WHERE created_by     = target_id OR submitted_by_user_id = target_id;
  DELETE FROM public.pool_daily_logs            WHERE created_by     = target_id;
  DELETE FROM public.cmpri_enseo_assignments    WHERE created_by     = target_id;

  UPDATE public.pool_daily_logs          SET updated_by              = NULL WHERE updated_by              = target_id;
  UPDATE public.cmpri_enseo_assignments  SET updated_by              = NULL WHERE updated_by              = target_id;
  UPDATE public.work_orders              SET creator_account_user_id = NULL WHERE creator_account_user_id = target_id;

  DELETE FROM public.hotel_members WHERE user_id = target_id;
  DELETE FROM public.profiles       WHERE id      = target_id;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_cmpri_user(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.purge_cmpri_user(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.purge_cmpri_user(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.purge_cmpri_user(uuid) TO service_role;
