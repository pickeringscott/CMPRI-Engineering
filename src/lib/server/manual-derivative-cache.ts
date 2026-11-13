import type {SupabaseClient} from '@supabase/supabase-js';
import {HOTEL_ID} from '@/lib/constants';
import {inspectManualPdf,manualPdfSha256} from '../manual-pdf-knowledge';
import type {ManualPageQuality} from '../manual-page-quality';
import {manualPreviewReadOnly} from './manual-preview';
import {extractPdfManualStructure} from './pdf-troubleshooting-tables';

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

type PdfStructure = Awaited<ReturnType<typeof extractPdfManualStructure>>;
const structureVersion = 'manual-pdf-structure-v10';
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 25000 && value.every(item => typeof item === 'string' && item.length <= 50000);
const pages = (value: unknown) => Array.isArray(value) && value.length > 0 && value.every(page => Number.isSafeInteger(page) && page > 0 && page <= 10000);
function validStructure(value: unknown): value is PdfStructure {
  if (!value || typeof value !== 'object') return false;
  const s = value as PdfStructure;
  return strings(s.warnings) && Array.isArray(s.symptom_rules) && s.symptom_rules.length <= 25000 && Array.isArray(s.error_codes) && s.error_codes.length <= 25000
    && s.symptom_rules.every(rule => rule && strings(rule.match) && strings(rule.steps) && pages(rule.source_pages)
      && (rule.prerequisites === undefined || strings(rule.prerequisites)) && (rule.reference_only === undefined || typeof rule.reference_only === 'boolean')
      && Object.keys(rule).every(key => ['match','steps','source_pages','prerequisites','reference_only'].includes(key)))
    && s.error_codes.every(code => code && typeof code.code === 'string' && typeof code.problem === 'string' && typeof code.action === 'string' && pages(code.source_pages)
      && (code.subcode === undefined || typeof code.subcode === 'string') && (code.unit_response === undefined || typeof code.unit_response === 'string')
      && Object.keys(code).every(key => ['code','subcode','problem','action','unit_response','source_pages'].includes(key)));
}

/** Reuse only geometry-derived extraction, including across cold function instances.
 * Asset approvals, reviewed corrections and permissions stay outside this cache.
 */
export async function readCachedPdfStructure(admin: SupabaseClient, bytes: Uint8Array, sha: string): Promise<PdfStructure> {
  if (!/^[a-f0-9]{64}$/.test(sha) || manualPdfSha256(bytes) !== sha) throw Error('The PDF structure fingerprint changed.');
  const key = `${structureVersion}-${sha}`;
  try {
    const result = await admin.from('troubleshooting_cache').select('payload,expires_at').eq('hotel_id',HOTEL_ID).eq('cache_type','asset_manual_knowledge').eq('cache_key',key).limit(1);
    const row = result.data?.[0], payload = row?.payload;
    if (row && !result.error && payload?.kind === 'manual-pdf-structure' && payload.version === structureVersion && payload.sha256 === sha
      && Date.parse(row.expires_at) > Date.now() && validStructure(payload.structure)) return payload.structure;
  } catch { /* An unavailable derivative must not prevent reading the source. */ }
  const structure = await extractPdfManualStructure(bytes);
  const payload = {kind:'manual-pdf-structure',version:structureVersion,sha256:sha,structure};
  if (!manualPreviewReadOnly() && validStructure(structure) && JSON.stringify(payload).length <= 1500000) {
    try {
      await admin.from('troubleshooting_cache').upsert({hotel_id:HOTEL_ID,cache_type:'asset_manual_knowledge',cache_key:key,payload,expires_at:new Date(Date.now()+86400000).toISOString()},{onConflict:'hotel_id,cache_type,cache_key'});
    } catch { /* Preserve a usable source result when caching fails. */ }
  }
  return structure;
}
