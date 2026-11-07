import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {normalizePrintedTime} from '../src/lib/room-operations-reports.ts';
import {roomStatusBadge} from '../src/lib/room-availability.ts';
const source=readFileSync(new URL('../src/components/desktop/WorkOrderListWindow.tsx',import.meta.url),'utf8');
const ast=ts.createSourceFile('list.tsx',source,99,true,4);
const fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='listCheckoutLabel');
const exports={};
vm.runInNewContext(ts.transpileModule(fn.getText(ast)+'\nexports.label=listCheckoutLabel;', {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,normalizePrintedTime,roomStatusBadge,hotelDate:()=> '2026-11-06'});
const label=exports.label;
test('today shows the checkout date and defaults absent or invalid time to 11 a.m.',()=>{
 for(const time of [null,'','invalid'])assert.equal(label('2026-11-06',time).label,'C/O Nov 6 · 11:00 a.m.');
});
test('report time overrides the default, including midnight, noon and afternoon',()=>{
 for(const [time,display] of [['10:30:00','10:30 a.m.'],['2:15 PM','2:15 p.m.'],['00:00:00','12:00 a.m.'],['12:00:00','12:00 p.m.']])assert.equal(label('2026-11-06',time).label,`C/O Nov 6 · ${display}`);
});
test('other dates show C/O and date without a time; missing dates have no pill',()=>{
 for(const date of ['2026-11-05','2026-11-07','2027-01-02'])assert.doesNotMatch(label(date,'14:00:00').label,/a\.m\.|p\.m\./);
 assert.equal(label(null),null);
 assert.equal(label('invalid'),null);
 for(const date of ['2026-02-30','2026-11-06T12:00:00Z','11/06/2026'])assert.equal(label(date),null);
});
test('checkout pill uses the same palette as the room status',()=>{
 for(const status of ['Occupied','Vacant Ready','Vacant Dirty','Out of Order'])assert.equal(label('2026-11-06',null,status).className,roomStatusBadge(status).className);
});
