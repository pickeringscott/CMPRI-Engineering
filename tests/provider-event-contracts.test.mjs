import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyDriveSheetVersion,gssMondayNoonSlot,validateGssSourceRows} from '../src/lib/integrations/provider-event-contracts.ts';
test('Drive signals cannot select another file and require verified spreadsheet version',()=>{
 assert.equal(verifyDriveSheetVersion('configured',{id:'configured',mimeType:'application/vnd.google-apps.spreadsheet',version:'123'}),'123');
 assert.throws(()=>verifyDriveSheetVersion('configured',{id:'other',mimeType:'application/vnd.google-apps.spreadsheet',version:'123'}));
 assert.throws(()=>verifyDriveSheetVersion('configured',{id:'configured',mimeType:'application/vnd.google-apps.spreadsheet',version:'123',trashed:true}));
});
test('Monday noon gate follows Chicago DST, not a fixed UTC hour',()=>{
 for(const [utc,expected] of [['2026-03-02T18:00Z','2026-03-02'],['2026-03-09T17:00Z','2026-03-09'],['2026-10-26T17:00Z','2026-10-26'],['2026-11-02T18:00Z','2026-11-02'],['2026-11-02T17:00Z',null],['2026-10-27T17:00Z',null]])assert.equal(gssMondayNoonSlot(new Date(utc)),expected);
});
test('GSS input retains all six source metrics, source colors and source arrows',()=>{
 const row={property:'Residence Inn (CMPRI)',sampleSize:11,scores:[54.5,40,63.6,72.7,36.4,11.1],color:'yellow',trend:'down'};
 assert.deepEqual(validateGssSourceRows([row]),[row]);assert.throws(()=>validateGssSourceRows([{...row,scores:[54.5]}]));assert.throws(()=>validateGssSourceRows([{...row,trend:'derived'}]));
});
