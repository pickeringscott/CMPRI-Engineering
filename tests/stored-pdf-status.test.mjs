import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
function load(path,deps={}){const exports={};vm.runInNewContext(ts.transpileModule(readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require:name=>{assert.ok(name in deps,name);return deps[name];}});return exports;}
const {withStoredPdfStatus}=load('../src/lib/server/stored-pdf-status.ts',{'@/lib/constants':{HOTEL_ID:'hotel'}});
const {storedPdfStatusLabel}=load('../src/lib/stored-pdf-link.ts');
const file=(path)=>({object_id:path,storage_path:path,size:20,title:path});
function admin(rows,error=null){const calls=[];return {calls,from(table){assert.equal(table,'maintenance_documents');const q={select(){return q},eq(key,value){assert.equal(key,'hotel_id');assert.equal(value,'hotel');return q},in(key,paths){assert.equal(key,'storage_path');calls.push(paths);return Promise.resolve({data:rows.filter(row=>paths.includes(row.storage_path)),error});}};return q}};}
test('catalog status distinguishes complete, pending, absent and quarantined without claiming readiness',async()=>{
 const db=admin([{storage_path:'complete',title:'Complete',ingestion_status:'complete'}, {storage_path:'pending',title:'Pending',ingestion_status:'pending'}, {storage_path:'bad',title:'Wrong model',ingestion_status:'content_mismatch',ingestion_error:'Source covers a different model.'}]);
 const input=['complete','pending','absent','bad'].map(file), result=await withStoredPdfStatus(db,input);
 assert.deepEqual(Array.from(result,row=>row.catalog_status),['complete','pending','not_cataloged','content_mismatch']);
 assert.match(result[3].catalog_warnings[0],/different model/);
 assert.equal(input[0].catalog_status,undefined,'metadata enrichment does not mutate original links');
 assert.equal(storedPdfStatusLabel(result[0]),'Catalog processing complete');
 assert.match(storedPdfStatusLabel(result[3]),/Quarantined/);
 assert.equal(storedPdfStatusLabel({...result[0],size:0}),'Empty original');
});
test('a conflicting quarantined catalog row takes precedence over complete rows for the same original',async()=>{
 const db=admin([{storage_path:'same',title:'Good',ingestion_status:'complete'},{storage_path:'same',title:'Bad',ingestion_status:'content_mismatch',ingestion_error:'Wrong contents'}]);
 assert.equal((await withStoredPdfStatus(db,[file('same')]))[0].catalog_status,'content_mismatch');
});
test('status lookup failure fails closed; empty file list needs no catalog access',async()=>{
 await assert.rejects(withStoredPdfStatus(admin([],{}),[file('one')]),/could not be checked/);
 const db=admin([]);assert.equal((await withStoredPdfStatus(db,[])).length,0);assert.equal(db.calls.length,0);
});
test('large stored-file lists are queried in bounded batches without losing entries',async()=>{
 const db=admin([]),files=Array.from({length:205},(_,i)=>file(String(i)));const result=await withStoredPdfStatus(db,files);
 assert.equal(result.length,205);assert.deepEqual(db.calls.map(batch=>batch.length),[100,100,5]);
});
