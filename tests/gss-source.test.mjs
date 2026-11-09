import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gssSourceDate, marriottImageParts, safeGssPng } from '../src/lib/integrations/gss-source.ts';
import { fetchLatestGssSource } from '../src/lib/integrations/email-provider.ts';
import vm from 'node:vm';
import ts from 'typescript';

const section = '<div><span style="font-size:37px">Marriott</span><br></div><div><img src="cid:first" width="1518"><br></div><div><img src="cid:second"><br></div><div><span style="font-size:37px">Hilton</span><br></div><img src="cid:secret">';
const part = id => ({ mimeType:'image/png', headers:[{name:'Content-ID',value:`<${id}>`}],body:{attachmentId:id} });
const payload = { parts:[part('secret'),part('first'),part('second')] };
const png = Buffer.alloc(32); Buffer.from([137,80,78,71,13,10,26,10]).copy(png); png.write('IHDR',12); png.writeUInt32BE(1200,16); png.writeUInt32BE(650,20);

test('source identification rejects wrong senders, replies and invalid dates', () => {
  assert.equal(gssSourceDate('Taylor Johnson <taylor.johnson@hawkeyehotels.com>', 'Hawkeye Hotel Weekly GSS Update - 11/9/2026'), '2026-11-09');
  for (const [from, subject] of [['not-taylor.johnson@hawkeyehotels.com','Hawkeye Hotel Weekly GSS Update - 11/9/2026'],['taylor.johnson@hawkeyehotels.com','Re: Hawkeye Hotel Weekly GSS Update - 11/9/2026'],['taylor.johnson@hawkeyehotels.com','Hawkeye Hotel Weekly GSS Update - 2/30/2026']]) assert.equal(gssSourceDate(from,subject),null);
});

test('only the two unambiguous Marriott inline PNGs are selected', () => {
  assert.deepEqual(marriottImageParts(section,payload).map(p=>p.body.attachmentId),['first','second']);
  for (const html of [section.replace('>Hilton</span>', '>Other</span>'), section.replace('<img src="cid:second">','<img src="cid:secret"><img src="cid:second">'), section+section, section.replace('cid:second','cid:first')]) assert.throws(()=>marriottImageParts(html,payload));
  assert.throws(()=>marriottImageParts(section,{parts:[...payload.parts,part('first')]}));
  assert.match(safeGssPng(png), /^data:image\/png;base64,/);
  assert.throws(()=>safeGssPng(Buffer.alloc(32)));
  const huge=Buffer.from(png); huge.writeUInt32BE(5000,16); assert.throws(()=>safeGssPng(huge));
});

test('provider fetches only the selected images and fails closed on a changed layout', async () => {
  const env = { CMPRI_EMAIL_PROVIDER:'gmail', CMPRI_GMAIL_CLIENT_ID:'id',CMPRI_GMAIL_CLIENT_SECRET:'secret',CMPRI_GMAIL_REFRESH_TOKEN:'token',CMPRI_GMAIL_ADDRESS:'work@example.com' };
  const saved=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]])); const fetchBefore=globalThis.fetch;
  const requests=[]; let html=section;
  try {
    Object.assign(process.env,env);
    globalThis.fetch=async url=>{
      const value=String(url); requests.push(value);
      if(value.includes('oauth2.googleapis.com')) return Response.json({access_token:'token'});
      if(value.includes('/attachments/')) return Response.json({data:png.toString('base64url')});
      if(value.includes('?format=full') || value.includes('?format=metadata')) return Response.json({payload:{headers:[{name:'From',value:'Taylor Johnson <taylor.johnson@hawkeyehotels.com>'},{name:'Subject',value:`Hawkeye Hotel Weekly GSS Update - ${value.includes('/old?')?'11/2/2026':'11/9/2026'}`}],parts:[{mimeType:'text/html',body:{data:Buffer.from(html).toString('base64url')}},...payload.parts]}});
      return Response.json({messages:[{id:'old'},{id:'message'}]});
    };
    const source=await fetchLatestGssSource();
    assert.equal(source.date,'2026-11-09');
    assert.deepEqual(source.images.map(i=>i.period),['First ranking','Second ranking']);
    assert.equal(requests.filter(s=>s.includes('/attachments/')).length,2);
    assert.ok(requests.some(s=>s.endsWith('/attachments/first')));
    assert.ok(requests.some(s=>s.endsWith('/attachments/second')));
    assert.ok(requests.filter(s=>s.includes('/attachments/')).every(s=>s.includes('/messages/message/')));
    assert.equal(requests.filter(s=>s.includes('?format=full')).length,1);
    assert.ok(!requests.some(s=>s.endsWith('/attachments/secret')));
    html=section.replace('>Hilton</span>','>Other</span>');
    await assert.rejects(fetchLatestGssSource(),/layout/);
  } finally { globalThis.fetch=fetchBefore; for(const k of Object.keys(env)) if(saved[k]===undefined) delete process.env[k]; else process.env[k]=saved[k]; }
});

test('source endpoint enforces authorization and hides upstream errors', async () => {
  const route=readFileSync(new URL('../src/app/api/engineering/gss/source/route.ts',import.meta.url),'utf8');
  let user=null, permitted=false, sourceCalls=0;
  const deps={
    'next/server':{NextResponse:{json:(body,opts)=>({body,...opts})}},
    '@/lib/server/access':{allows:(_principal,cap)=>cap==='view_engineering_operations' && permitted},
    '@/lib/server/auth':{requireUser:async()=>user},
    '@/lib/integrations/email-provider':{fetchLatestGssSource:async()=>{sourceCalls++;throw new Error('private mailbox data');}},
  };
  const exports={};
  vm.runInNewContext(ts.transpileModule(route,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{exports,require:name=>deps[name]});
  const unauthorized=await exports.GET({}); assert.equal(unauthorized.status,401); assert.equal(sourceCalls,0);
  user={principal:{}}; const forbidden=await exports.GET({}); assert.equal(forbidden.status,403); assert.equal(sourceCalls,0);
  permitted=true; const unavailable=await exports.GET({}); assert.equal(unavailable.status,503); assert.equal(sourceCalls,1);
  assert.equal(unavailable.body.error,'The latest GSS source report is unavailable.');
  assert.equal(unavailable.headers['Cache-Control'],'private, no-store');
});
