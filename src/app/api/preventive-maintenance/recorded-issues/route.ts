import { NextRequest, NextResponse } from 'next/server';
import { requireUser } from '@/lib/server/auth';
import { allows } from '@/lib/server/access';
import { loadRecordedIssues } from '@/lib/server/pm-recorded-issues';

export async function GET(request: NextRequest) {
  const auth = await requireUser(request);
  if (!auth || !allows(auth.principal, 'view_pm')) return NextResponse.json({error:'PM access required.'}, {status:403});
  try {
    const records = await loadRecordedIssues(auth.admin, auth.principal.identity.id);
    return NextResponse.json({ records, canConfirm: allows(auth.principal, 'edit_tickets') }, {headers:{'Cache-Control':'no-store'}});
  } catch (cause) {
    return NextResponse.json({error: cause instanceof Error ? cause.message : 'Recorded issues unavailable.'}, {status:503});
  }
}
