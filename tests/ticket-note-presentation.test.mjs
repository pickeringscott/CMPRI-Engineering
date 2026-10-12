import test from 'node:test';
import assert from 'node:assert/strict';
import {loadTs} from './helpers/load-ts.mjs';
const {historyLine,parseTicketHistory,noteHeading}=loadTs('src/lib/ticket-note-presentation.ts');
const base={id:'1',timestamp:'2026-10-12T12:00:00Z',actor:'Author',kind:'note',text:'Recorded findings'};
test('note label follows recorded author role across viewers and mixed authors',()=>{
 const roles=['Front Desk Manager','Front Desk','Chief Engineer'];
 const raw=roles.map(authorRole=>historyLine({...base,authorRole})).join('\n');
 for(const viewer of ['technician','front_desk','system_admin']) {
  const entries=parseTicketHistory(raw);
  assert.deepEqual(Array.from(entries,e=>noteHeading(e.authorRole)),roles.map(role=>`${role} Notes`),viewer);
  assert.deepEqual(Array.from(entries,e=>e.actor),roles.map(()=>'Author'));
 }
});
test('old names, imported notes, and unknown roles do not invent attribution; roundtrip preserves old lines',()=>{
 const legacy=historyLine(base);
 assert.equal(legacy,'CMPRI|2026-10-12T12:00:00Z|Author|note|Recorded findings');
 assert.equal(historyLine(parseTicketHistory(legacy)[0]),legacy);
 for(const raw of [legacy,'Imported maintenance record']) assert.equal(noteHeading(parseTicketHistory(raw)[0].authorRole),'Notes');
 assert.equal(noteHeading('unknown imported role'),'Notes');
 assert.equal(noteHeading(),'Notes');
});
test('Spanish role labels and neutral fallback preserve language selection',()=>{
 assert.equal(noteHeading('front_desk_manager','es'),'Notas de Gerente de Recepción');
 assert.equal(noteHeading('chief_engineer','es'),'Notas de Jefe de Ingeniería');
 assert.equal(noteHeading(undefined,'es'),'Notas');
 assert.equal(noteHeading('invented','es'),'Notas');
});
