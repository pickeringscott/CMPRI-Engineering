import { NextRequest, NextResponse } from 'next/server';
import { requireUser } from '@/lib/server/auth';

/** Retired page-bound importer; normal PM saves retain their existing workflow. */
export async function POST(request: NextRequest) {
  if (!await requireUser(request)) return NextResponse.json({error:'Sign in is required.'},{status:401});
  return NextResponse.json({error:'Scan-page answer imports are retired. Use the existing inspection save/review workflow.'},{status:410,headers:{'Cache-Control':'no-store'}});
}
