import { NextRequest, NextResponse } from 'next/server';
import { requireUser } from '@/lib/server/auth';

/** Retired scan import/read surface. Operational forms and history use their own routes. */
async function retired(request: NextRequest) {
  if (!await requireUser(request)) return NextResponse.json({error:'Sign in is required.'},{status:401});
  return NextResponse.json({error:'Scanned evidence access is retired. Recorded maintenance history and current inspections remain available.'},{status:410,headers:{'Cache-Control':'no-store'}});
}
export const GET = retired;
export const POST = retired;
