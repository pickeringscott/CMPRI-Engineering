import { NextRequest, NextResponse } from 'next/server';
import { authenticatedUser } from '@/lib/server/request-auth';
import { roleAllows } from '@/lib/server/roles';
import { createSupabaseAdmin } from '@/lib/server/supabase-admin';
import { fetchAllPages } from '@/lib/server/paginated-query';
import { HOTEL_ID } from '@/lib/constants';
export async function GET(request: NextRequest) {
  const auth = await authenticatedUser(request);
  if (!auth) return NextResponse.json({error:'Sign in is required.'},{status:401});
  if (!roleAllows(auth.profile.role,'operate_pool_log')) return NextResponse.json({error:'Pool-log operating permission is required.'},{status:403});
  if (process.env.CMPRI_PO_ENABLED !== 'true') return NextResponse.json({error:'Inventory usage is not enabled.'},{status:409});
  const admin = auth.admin ?? createSupabaseAdmin();
  if (!admin) return NextResponse.json({error:'Inventory is unavailable.'},{status:503});
  const result = await fetchAllPages((from,to) => admin.from('cmpri_inventory_items')
    .select('id,item_name,quantity_on_hand,quantity_reserved,unit_of_measure').eq('hotel_id',HOTEL_ID)
    .eq('active',true).order('item_name').order('id').range(from,to));
  if (result.error) return NextResponse.json({error:'Inventory could not be loaded.'},{status:503});
  return NextResponse.json({items:result.data},{headers:{'Cache-Control':'private, no-store'}});
}
