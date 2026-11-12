import type { createSupabaseAdmin } from './supabase-admin';

// Event-driven only: each new upload attempt retires at most ten abandoned
// uploads. No background schedule is required; the database also hard-caps
// unfinished admissions at 100, even if cleanup fails or there is no activity.
export async function cleanupExpiredEmploymentUploads(admin: NonNullable<ReturnType<typeof createSupabaseAdmin>>) {
  // Upload capabilities last two hours and can be reissued until admission
  // expiry. Three additional hours prevent a still-valid URL recreating an object.
  const cutoff = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  let removed = 0;
  try {
    const expired = await admin.from('employment_resume_uploads').select('id,sha256')
      .is('completed_at', null).lt('expires_at', cutoff).order('expires_at').limit(10);
    if (expired.error) return removed;
    for (const item of expired.data || []) {
      const result = await admin.storage.from('employment-resumes').remove([`${item.id}/${item.sha256}.pdf`]);
      if (result.error) continue; // Keep the private record to retry on a later attempt.
      const deleted = await admin.from('employment_resume_uploads').delete().eq('id', item.id).is('completed_at', null).lt('expires_at', cutoff);
      if (!deleted.error) removed++;
    }
  } catch { /* Cleanup is best effort; the hard admission cap still fails closed. */ }
  return removed;
}
