import { NextRequest, NextResponse } from 'next/server';
import { requireUser } from '@/lib/server/auth';
import history from '@/lib/pm/retained-maintenance-history.json';

export async function GET(request: NextRequest) {
  if (!await requireUser(request)) return NextResponse.json({error:'Sign in is required.'},{status:401});
  return NextResponse.json(history,{headers:{'Cache-Control':'no-store'}});
}
