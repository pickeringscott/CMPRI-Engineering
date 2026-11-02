import 'server-only';
import type {SupabaseClient} from '@supabase/supabase-js';
import type {Principal} from './access';
import {allows} from './access';
import {canReadEquipment} from './roles';
import {HOTEL_ID} from '@/lib/constants';
import {fetchAllPages} from './paginated-query';
import {PM_TEMPLATES} from '@/lib/pm/catalog';
import {buildLocationEquipment,type EquipmentAsset,type SourceLog} from '@/lib/location-equipment';
import type {Location,RoomHistory} from '@/lib/location-records';

export async function loadLocationActivity(admin:SupabaseClient,principal:Principal,locations:Location[]){
 if(!allows(principal,'view_pm'))return {room_history:[],pm_logs:[]};
 const [history,logs,assets]=await Promise.all([
  fetchAllPages<RoomHistory>((from,to)=>admin.from('cmpri_room_pm_history').select('hotel_id,room,period_start,completed_on,source_name,source_reference').eq('hotel_id',HOTEL_ID).order('room').order('period_start').range(from,to)),
  fetchAllPages<SourceLog>((from,to)=>admin.from('cmpri_pm_proposals').select('id,template_id,period_start,scope_key,status,updated_at,payload').eq('hotel_id',HOTEL_ID).order('id').range(from,to)),
  canReadEquipment(principal.profile.role)?fetchAllPages<EquipmentAsset>((from,to)=>admin.from('assets').select('id,name,asset_type,location_id').eq('hotel_id',HOTEL_ID).order('id').range(from,to)):Promise.resolve({data:[],error:null}),
 ]);
 if(history.error||logs.error||assets.error)throw new Error('Location PM source records could not be loaded.');
 const equipment=buildLocationEquipment(locations,assets.data||[],logs.data||[],PM_TEMPLATES);
 return {room_history:history.data||[],pm_logs:logs.data||[],equipment};
}
