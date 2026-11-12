import { isUuid } from '@/lib/uuid';
import { requireUser } from '@/lib/server/auth';
import { IMPORT_UPLOAD_BUCKET } from '@/lib/server/import-upload';
import { NextRequest, NextResponse } from 'next/server';
import { canEditEquipment } from '@/lib/server/roles';
import { requireCapability } from '@/lib/server/auth';
import { importDescriptor, prepareImportUpload } from '@/lib/server/import-upload';
const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } });
export async function POST(request: NextRequest) {
  try {
    const text = await request.text();
    if (text.length > 2048) return reply({ error: 'Invalid upload descriptor.' }, 400);
    const d = importDescriptor(JSON.parse(text));
    const capability = d.kind === 'guest-report' ? 'edit_tickets' : (d.kind === 'po-pdf' || d.kind === 'asset-documentation') ? 'manage_assets' : 'operate_integrations';
    const auth = await requireCapability(request, capability);
    if (!auth) return reply({ error: 'Upload permission required.' }, 403);
    if (d.kind === 'asset-documentation' && !canEditEquipment(auth.principal.profile.role)) return reply({ error: 'Equipment editing permission required.' }, 403);
    if ((d.kind === 'po-pdf' || d.kind === 'purchasing-history') && process.env.CMPRI_PO_ENABLED !== 'true') return reply({ error: 'Purchasing is not enabled.' }, 409);
    return reply(await prepareImportUpload(auth.admin, auth.principal.hotelId, auth.principal.identity.id, d));
  } catch { return reply({ error: 'The upload could not be prepared. Choose a valid file up to 100 MB and check private import storage.' }, 400); }
}

export async function DELETE(request: NextRequest) {
  const auth = await requireUser(request);
  if (!auth) return reply({ error: 'Sign in required.' }, 401);
  const text = await request.text();
  if (text.length > 512) return reply({ error: 'Invalid result.' }, 400);
  let body;
  try { body = JSON.parse(text || "null"); } catch { return reply({ error: 'Invalid result.' }, 400); }
  if (!isUuid(body?.id) || !Number.isSafeInteger(body.count) || body.count < 1 || body.count > 64) return reply({ error: 'Invalid result.' }, 400);
  const paths = Array.from({ length: body.count }, (_, index) => `${auth.principal.hotelId}/${auth.principal.identity.id}/results/${body.id}-${index}.json`);
  const removed = await auth.admin.storage.from(IMPORT_UPLOAD_BUCKET).remove(paths);
  return reply(removed.error ? { error: 'Private result cleanup will be retried.' } : { ok: true }, removed.error ? 503 : 200);
}
