import test from 'node:test';
import assert from 'node:assert/strict';
import {guideSourcePages} from '../src/lib/work-orders/guide-source-pages.ts';

const source={registered_file_id:'dryer',sha256:'a'.repeat(64)};
const passage=(page,document='dryer',hash=source.sha256)=>({page,text:'Dryer heat error diagram',kind:'reference',source_document_id:document,source_sha256:hash});
const step=(page,document='dryer',hash=source.sha256)=>({label:'Check source instruction',sourcePages:[page],source_document_id:document,source_sha256:hash});
test('displayed pages follow the narrowed checklist and retain document fingerprints',()=>{
 const knowledge={source,source_passages:[passage(3),passage(25),passage(26),passage(25,'programming'),passage(25,'dryer','b'.repeat(64))]};
 assert.deepEqual(guideSourcePages(knowledge,'Heat error on dryer','',[step(25),step(26)]).map(p=>p.page),[25,26]);
 assert.deepEqual(guideSourcePages(knowledge,'Heat error on dryer','',[step(26)]).map(p=>p.page),[26]);
});
test('reference-only manuals remain searchable without appliance nouns matching the whole document',()=>{
 const knowledge={source,source_passages:[{...passage(1),text:'Dryer operating instructions'},{...passage(2),text:'Dryer errors'},{...passage(3),text:'Heat error diagnostic diagram'}]};
 assert.deepEqual(guideSourcePages(knowledge,'Heat errors on dryer','',[]).map(p=>p.page),[3]);
});
