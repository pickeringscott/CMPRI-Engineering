import { NextRequest, NextResponse } from 'next/server';
import { NOTEPAD_UUID } from '@/lib/notepad';
import { requireUser } from '@/lib/server/auth';

const headers = { 'Cache-Control': 'private, no-store' };
const pageSize = 5;
const response = (body: unknown, status = 200) => NextResponse.json(body, { status, headers });

export async function GET(request: NextRequest) {
  const auth = await requireUser(request);
  const property = request.headers.get('x-cmpri-property');
  if (!auth || (property && property !== auth.principal.hotelId)) {
    return response({ error: 'Sign in is required.' }, 401);
  }
  const id = request.nextUrl.searchParams.get('id') || '';
  const cursor = request.nextUrl.searchParams.get('before');
  const before = cursor === null ? null : Number(cursor);
  if (!NOTEPAD_UUID.test(id) || (cursor !== null && (!/^\d+$/.test(cursor) || !Number.isSafeInteger(before) || Number(before) < 1))) {
    return response({ error: 'Invalid note or history page.' }, 400);
  }
  const { data, error } = await auth.admin.rpc('cmpri_read_notepad_history', {
    p_hotel: auth.principal.hotelId,
    p_actor: auth.principal.identity.id,
    p_note: id,
    p_before: before,
  });
  if (error || !Array.isArray(data)) return response({ error: 'Edit history could not be loaded.' }, 503);
  const entries = data.slice(0, pageSize).map(row => ({
    revision: Number(row.revision), actorId: row.actor_id, actorName: row.actor_name,
    at: row.edited_at, kind: row.kind, before: row.before_fields, after: row.after_fields,
  }));
  return response({ entries, next: data.length > pageSize ? entries.at(-1)?.revision : null });
}
