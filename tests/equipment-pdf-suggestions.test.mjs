import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {extractEquipmentSuggestions,withAssetManufacturer,pdfReviewSuggestions} from '../src/lib/equipment-pdf-suggestions.ts';
import {preservePdfReview} from '../src/lib/stored-pdf-link.ts';
test('manufacturer prose and component references are never brand labels',()=>{
 for(const text of ['manufacturers. Ratings may vary by manufacturer.','Manufacturer Nominal Signal','drive component manufacturer’s model number.'])assert.equal(extractEquipmentSuggestions(text),null);
 assert.equal(extractEquipmentSuggestions('Manufacturer: GE Model: AZ95E12DACK1').manufacturer,'GE');
});
test('primary model table preserves exact variants without first-model selection',()=>{
 const r=extractEquipmentSuggestions('Model Number KGC180S4M KGC210S4M KGC240S4M KGC300S4M\nModel No. KGC240S4');
 assert.deepEqual(r.model_candidates,['KGC180S4M','KGC210S4M','KGC240S4M','KGC300S4M']);assert.equal(r.model_number,undefined);
 const review=pdfReviewSuggestions('manual',r);assert.equal(review.selected_model,'');assert.equal(review.applicability,'reference');assert(!review.models.includes('KGC240S4MS1Y'));
});
test('single models and supported explicit fields map into review inputs',()=>{
 const s=extractEquipmentSuggestions('Manufacturer: Example\nModel: ABC123\nEquipment type: Packaged unit\nModel family: ABC\nGeneration: 2\nSerial Number: SN123\nInstallation year: 2023');
 const r=pdfReviewSuggestions('Manual',s);assert.deepEqual(r.models,['ABC123']);assert.deepEqual(r.extracted_fields,{asset_type:'Packaged unit',model_family:'ABC',serial_number:'SN123',generation:'2',install_year:'2023'});assert.equal(r.selected_model,'');
 assert.deepEqual(pdfReviewSuggestions('Manual',{model_number:'ABC123'}).models,['ABC123']);
});
test('copyright, service dates and general prose do not invent serial or install year',()=>{
 const s=extractEquipmentSuggestions('Copyright 2023. Installed in 2019. Refer to serial number label. Models: ABC123, ABC456');assert.equal(s.serial_number,undefined);assert.equal(s.install_year,undefined);
});
test('current asset brand is explicitly sourced, never changes equipment or overrides document brand',()=>{
 const s=withAssetManufacturer({model_candidates:['KGC240S4M']},'Lennox');assert.equal(s.manufacturer,'Lennox');assert.equal(s.manufacturer_source,'asset');assert.equal(withAssetManufacturer({manufacturer:'Other',manufacturer_source:'document'},'Lennox').manufacturer,'Other');assert.equal(withAssetManufacturer(null,null),null);
});
test('saved overrides and in-progress edits still take priority over fresh suggestions',()=>{
 const fresh=pdfReviewSuggestions('Manual',{manufacturer:'Lennox',model_candidates:['KGC240S4M']});const edited={...fresh,manufacturer:'User correction',notes:'Keep my work'};
 assert.equal(preservePdfReview('same','same',edited,null,fresh),edited);assert.equal(preservePdfReview(null,'same',fresh,edited,fresh).manufacturer,'User correction');
});
test('actual100070 PDF extraction returns full table and no bogus brand, serial or year',{skip:!process.env.LENNOX_TEXT_TEST_PATH},()=>{
 const text=fs.readFileSync(process.env.LENNOX_TEXT_TEST_PATH,'utf8');assert.equal(text.length,168547);const s=extractEquipmentSuggestions(text);assert.deepEqual(s.model_candidates,['KGC180S4M','KGC210S4M','KGC240S4M','KGC300S4M']);assert.equal(s.manufacturer,undefined);assert.equal(s.serial_number,undefined);assert.equal(s.install_year,undefined);const r=pdfReviewSuggestions('100070.pdf',withAssetManufacturer(s,'Lennox'));assert.equal(r.manufacturer,'Lennox');assert(r.models.includes('KGC240S4M'));assert.equal(r.selected_model,'');console.log(JSON.stringify({suggestions:s,review:r}));
});
