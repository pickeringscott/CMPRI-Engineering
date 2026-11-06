import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllPages } from './paginated-query';
import { staffMentionDirectory, type StaffProfile, type StaffLocation, type StaffDisplayName } from '../staff-notes';
export async function staffNoteDirectory(admin:SupabaseClient,hotelId:string){
  const members=await fetchAllPages<{user_id:string}>((from,to)=>admin.from('hotel_members').select('user_id').eq('hotel_id',hotelId).eq('active',true).order('user_id').range(from,to));
  if(members.error)throw Error('Staff could not be loaded.');
  const profiles:StaffProfile[]=[];
  for(let start=0;start<(members.data||[]).length;start+=200){
    const ids=members.data!.slice(start,start+200).map(m=>m.user_id);
    const result=await admin.from('profiles').select('id,full_name,role,secondary_roles').eq('active',true).in('id',ids);
    if(result.error)throw Error('Staff could not be loaded.');profiles.push(...(result.data||[]));
  }
  const [names,locations]=await Promise.all([
    fetchAllPages<StaffDisplayName>((from,to)=>admin.from('cmpri_staff_note_names').select('id,name').eq('hotel_id',hotelId).order('id').range(from,to)),
    fetchAllPages<StaffLocation>((from,to)=>admin.from('locations').select('id,name,room_number,area').eq('hotel_id',hotelId).eq('active',true).order('id').range(from,to)),
  ]);
  if(names.error||locations.error)throw Error('Mention targets could not be loaded.');
  return {profiles,mentions:staffMentionDirectory(profiles,names.data||[],locations.data||[])};
}
