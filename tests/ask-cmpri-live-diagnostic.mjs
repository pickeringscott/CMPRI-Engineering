if(process.env.VERCEL_ENV!=='preview') throw new Error('Diagnostic requires Vercel Preview');
import fs from 'node:fs';
const file='tests/ask-cmpri-provider.test.mjs';
let source=fs.readFileSync(file,'utf8').replace("import test from 'node:test';","const test=()=>{};");
const original='return respond(call, requests.length);';
if(!source.includes(original)) throw new Error('Diagnostic fixture not found');
source=source.replace(original,`
  const key=process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim()||process.env.GEMINI_API_KEY?.trim();
  if(!key) throw new Error('Preview Gemini credential unavailable');
  const safeUrl=new URL(url);
  if(safeUrl.origin!=='https://generativelanguage.googleapis.com') throw new Error('Unexpected provider origin');
  call.headers.set('x-goog-api-key',key);
  const response=await fetch(url,{...init,headers:call.headers,signal:AbortSignal.timeout(20000)});
  if(!response.ok){
    const err=(await response.clone().json().catch(()=>null))?.error;
    const clean=value=>String(value??'').replaceAll(key,'[redacted]').replace(/AIza[0-9A-Za-z_-]{20,}/g,'[redacted]').slice(0,1300);
    console.log('CMPRI_GEMINI_DIAGNOSTIC '+JSON.stringify({step:requests.length,model:safeUrl.pathname,mode:call.body.toolConfig?.functionCallingConfig?.mode,status:response.status,message:clean(err?.message),fields:err?.details?.flatMap(d=>Array.isArray(d.fieldViolations)?d.fieldViolations.slice(0,12).map(v=>({field:clean(v.field),description:clean(v.description)})):[])}));
  }else console.log('CMPRI_GEMINI_DIAGNOSTIC '+JSON.stringify({step:requests.length,model:safeUrl.pathname,status:response.status}));
  return response;`);
source=source.replace('process: { env: {} }', 'process: { env: { CMPRI_GEMINI_MODEL: '+JSON.stringify(process.env.CMPRI_GEMINI_MODEL??'')+' } }');
source+="\nconst diagnostic=fixture(); await diagnostic.run('What can Ask CMPRI help with?').catch(e=>console.log('CMPRI_GEMINI_DIAGNOSTIC_END '+e.name));\n";
const scratch='tests/.ask-cmpri-live-diagnostic.mjs';
fs.writeFileSync(scratch,source);
try { await import('./.ask-cmpri-live-diagnostic.mjs'); } finally { fs.unlinkSync(scratch); }
