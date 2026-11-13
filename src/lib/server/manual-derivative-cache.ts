import type {SupabaseClient} from '@supabase/supabase-js';
import {HOTEL_ID} from '@/lib/constants';
import {inspectManualPdf} from '../manual-pdf-knowledge';
import type {ManualPageQuality} from '../manual-page-quality';
import {manualPreviewReadOnly} from './manual-preview';

const version='manual-reader-v4';
const prefix=(sha:string)=>`${version}-${sha}-`;
/** Byte-derived pages are reusable; association/permissions must still be checked by every caller. */
export async function inspectCachedManualPdf(admin:SupabaseClient,bytes:Uint8Array,sha:string){
  const pages:ManualPageQuality[]=[];
  try{
    const result=await admin.from('troubleshooting_cache').select('cache_key,payload,expires_at').eq('hotel_id',HOTEL_ID).eq('cache_type','asset_manual_knowledge').like('cache_key',`${prefix(sha)}%`).limit(1000);
    if(!result.error)for(const row of result.data||[]){
      const p=row.payload;
      if(p?.kind!=='manual-pdf-inspection'||p.sha256!==sha||p.version!==version||!Array.isArray(p.pages)||p.pages.length>25||!Number.isFinite(Date.parse(row.expires_at))||Date.parse(row.expires_at)<Date.now())continue;
      for(const page of p.pages)if(Number.isSafeInteger(page.page)&&page.page>0&&page.page<=10000&&typeof page.text==='string'&&page.text.length<=500000&&typeof page.needs_ocr==='boolean')pages.push(page);
    }
  }catch{/* Derivative availability cannot prevent reading the original. */}
  return inspectManualPdf(bytes,{includeEmptyPages:true,cachedPages:pages,onBatch:async batch=>{
    if(manualPreviewReadOnly()||!batch.length)return;
    const payload={kind:'manual-pdf-inspection',version,sha256:sha,pages:batch};
    if(JSON.stringify(payload).length>1500000)return;
    // A stopped request leaves completed batches reusable on the next read.
    try{await admin.from('troubleshooting_cache').upsert({hotel_id:HOTEL_ID,cache_type:'asset_manual_knowledge',cache_key:`${prefix(sha)}${batch[0].page}`,payload,expires_at:new Date(Date.now()+86400000).toISOString()},{onConflict:'hotel_id,cache_type,cache_key'});}catch{/* The original is still usable when caching is unavailable. */}
  }});
}
