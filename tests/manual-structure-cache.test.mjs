import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {loadTs} from './helpers/load-ts.mjs';

const bytes = new TextEncoder().encode('%PDF-source');
const hash = value => createHash('sha256').update(value).digest('hex');
const sha = hash(bytes);
const structure = {symptom_rules:[{match:['No heat'],steps:['Supply present? — No: Check the supply.'],source_pages:[25]}],error_codes:[],warnings:[]};
function fixture() {
  const state = {rows:new Map(),calculations:0,writes:0,preview:false,unavailable:false,failCalculation:false};
  const admin = {from() {
    const filters=[];
    const query={select(){return query;},eq(key,value){filters.push(row=>row[key]===value);return query;},async limit(){if(state.unavailable)throw Error('Cache offline');return {data:[...state.rows.values()].filter(row=>filters.every(filter=>filter(row))),error:null};},async upsert(row){state.writes++;if(state.unavailable)throw Error('Cache offline');state.rows.set(row.cache_key,structuredClone(row));return {error:null};}};
    return query;
  }};
  const coldInstance = () => loadTs('src/lib/server/manual-derivative-cache.ts',{
    '@/lib/constants':{HOTEL_ID:'hotel'},'../manual-pdf-knowledge':{manualPdfSha256:hash},'./manual-preview':{manualPreviewReadOnly:()=>state.preview},
    './pdf-troubleshooting-tables':{extractPdfManualStructure:async()=>{state.calculations++;if(state.failCalculation)throw Error('Source unavailable');return structuredClone(structure);}},
  },{Date,JSON,Error});
  return {state,read:(data=bytes,fingerprint=hash(data))=>coldInstance().readCachedPdfStructure(admin,data,fingerprint)};
}

test('new function instances reuse the PDF geometry result while changed bytes require fresh extraction',async()=>{
  const f=fixture();
  assert.deepEqual(await f.read(),structure);assert.deepEqual(await f.read(),structure);
  assert.equal(f.state.calculations,1);assert.equal(f.state.writes,1);
  await f.read(new TextEncoder().encode('%PDF-replacement'));
  assert.equal(f.state.calculations,2);assert.equal(f.state.rows.size,2);
  await assert.rejects(f.read(new TextEncoder().encode('%PDF-changed'),sha),/fingerprint changed/);
  assert.equal(f.state.calculations,2);
});

test('expired, malformed and foreign-source cache rows never substitute instructions',async()=>{
  for(const mutate of [row=>row.expires_at='2000-01-01',row=>row.payload.sha256='b'.repeat(64),row=>row.payload.version='obsolete',row=>row.payload.structure.symptom_rules[0].source_pages=[0],row=>row.payload.structure.symptom_rules[0].source_url='https://other.example/manual.pdf']){
    const f=fixture();await f.read();mutate([...f.state.rows.values()][0]);await f.read();assert.equal(f.state.calculations,2);
  }
});

test('cache outages preserve source reads, extraction failures are retried, and previews never write',async()=>{
  const f=fixture();f.state.unavailable=true;assert.deepEqual(await f.read(),structure);
  f.state.unavailable=false;f.state.failCalculation=true;await assert.rejects(f.read(),/Source unavailable/);assert.equal(f.state.rows.size,0);
  f.state.failCalculation=false;f.state.preview=true;await f.read();assert.equal(f.state.rows.size,0);
  f.state.preview=false;await f.read();await f.read();assert.equal(f.state.calculations,4);assert.equal(f.state.rows.size,1);
});
