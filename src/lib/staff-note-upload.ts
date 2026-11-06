import {authorizationHeaders} from '@/lib/auth/client-session';
import {createClient} from '@/lib/supabase/client';
import {STAFF_FILE_BUCKET} from '@/lib/staff-note-media';
export async function uploadStaffNoteFile(file:File,id:string) {
 const headers={...await authorizationHeaders(),'Content-Type':'application/json'};
 const prepared=await fetch('/api/staff-notes/uploads',{method:'POST',headers,body:JSON.stringify({id,name:file.name,type:file.type||'application/octet-stream',size:file.size})});
 const value=await prepared.json();if(!prepared.ok)throw Error(value.error||'The file could not be prepared.');
 // A lost upload response may be retried. Verification, rather than overwriting, decides success.
 await createClient().storage.from(STAFF_FILE_BUCKET).uploadToSignedUrl(value.path,value.token,file,{contentType:file.type||'application/octet-stream',upsert:false});
 const finalized=await fetch('/api/staff-notes/uploads',{method:'PUT',headers,body:JSON.stringify({id})});
 const result=await finalized.json();if(!finalized.ok||!result.ready)throw Error(result.error||'The file could not be verified. Your draft is retained.');
 return id;
}
