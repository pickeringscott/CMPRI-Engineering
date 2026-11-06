import { NextRequest, NextResponse } from 'next/server';
import { requireUser } from '@/lib/server/auth';
import { roleKey } from '@/lib/server/roles';
import { normalizeHeaderLayout } from '@/lib/header-layout';

const headers = { 'Cache-Control': 'private, no-store' };
export async function GET(request: NextRequest) {
  const auth = await requireUser(request);
  if (!auth || roleKey(auth.principal.profile.role) === 'unknown') return NextResponse.json({ error: 'Sign in is required.' }, { status: 401 });
  const { data, error } = await auth.admin.from('cmpri_header_layouts').select('layout').eq('hotel_id', auth.principal.hotelId).eq('user_id', auth.principal.identity.id).maybeSingle();
  if (error) return NextResponse.json({ error: 'Your layout could not be loaded.' }, { status: 503, headers });
  return NextResponse.json({ layout: normalizeHeaderLayout(data?.layout) }, { headers });
}
export async function PUT(request: NextRequest) {
  const auth = await requireUser(request);
  if (!auth || roleKey(auth.principal.profile.role) === 'unknown') return NextResponse.json({ error: 'Sign in is required.' }, { status: 401 });
  const text = await request.text();
  if (text.length > 40_000) return NextResponse.json({ error: 'Layout is too large.' }, { status: 413 });
  let body;
  try { body = JSON.parse(text); } catch { return NextResponse.json({ error: 'A valid layout is required.' }, { status: 400 }); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'layout')) return NextResponse.json({ error: 'Supply only your layout.' }, { status: 400 });
  const layout = normalizeHeaderLayout(body.layout);
  const { error } = await auth.admin.from('cmpri_header_layouts').upsert({ hotel_id: auth.principal.hotelId, user_id: auth.principal.identity.id, layout, updated_at: new Date().toISOString() }, { onConflict: 'hotel_id,user_id' });
  if (error) return NextResponse.json({ error: 'Your layout could not be saved.' }, { status: 503, headers });
  return NextResponse.json({ layout }, { headers });
}
