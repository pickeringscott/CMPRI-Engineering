import { NextRequest, NextResponse } from 'next/server';
import { HOTEL_ID } from '@/lib/constants';
import { createSupabaseAdmin } from '@/lib/server/supabase-admin';
import { processManualOcrJob } from '@/lib/server/manual-ocr-queue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Process one bounded OCR batch; the scheduled retry recovers interrupted work. */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  const admin = createSupabaseAdmin();
  if (!admin) return NextResponse.json({ error: 'Database unavailable.' }, { status: 503 });
  try { return NextResponse.json({ status: await processManualOcrJob(admin, HOTEL_ID) }, { headers: { 'Cache-Control': 'no-store' } }); }
  catch { return NextResponse.json({ error: 'OCR processing is unavailable.' }, { status: 503 }); }
}
