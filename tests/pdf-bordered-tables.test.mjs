import test from 'node:test';
import assert from 'node:assert/strict';
import {borderedTableRules} from '../src/lib/server/pdf-bordered-tables.ts';

const ops={constructPath:1,transform:2,save:3,restore:4};
function box(x0,y0,x1,y1){return new Float32Array([0,x0,y1,1,x1,y1,1,x1,y0,1,x0,y0,4]);}
function fixture({splitCause=false,transformed=false}={}) {
 const paths=[box(0,0,600,800),box(20,700,150,720),box(150,700,250,720),box(250,700,580,720),box(20,600,150,700),box(150,600,250,700),box(250,600,580,700),box(20,500,150,600),box(150,500,250,600),box(250,500,580,600)];
 if(splitCause)paths.splice(5,1,box(150,650,250,700),box(150,600,250,650));
 const items=[[30,710,'Error type'],[160,710,'Cause'],[260,710,'Check method'],[30,650,'No hot water from the valve'],[160,650,'Check the pipe'],[260,690,'1. The cold water valve is closed.'],[260,660,'2. Check if the filter is clogged.'],[30,550,'Low pressure'],[160,550,'Pressure regulator'],[260,550,'Inspect regulator.']].map(([x,y,str])=>({str,transform:[1,0,0,1,x,y]}));
 const page={getOperatorList:async()=>({fnArray:transformed?[ops.transform,ops.constructPath]:[ops.constructPath],argsArray:transformed?[[1,0,0,1,0,0],[0,paths]]:[[0,paths]]})};
 return {page,items};
}
test('bordered rows preserve their condition and cause, separating numbered source checks',async()=>{
 const {page,items}=fixture();const rules=await borderedTableRules(page,items,120,ops);const hot=rules.find(rule=>rule.match.includes('no hot water'));
 assert.deepEqual(hot.source_pages,[120]);assert.deepEqual(hot.steps,['No hot water from the valve — Check the pipe — 1. The cold water valve is closed.','No hot water from the valve — Check the pipe — 2. Check if the filter is clogged.']);assert.ok(hot.steps.every(step=>!step.includes('Inspect regulator')));
});
test('subdivided or transformed cells are not combined into a misleading instruction',async()=>{
 const divided=fixture({splitCause:true});const rules=await borderedTableRules(divided.page,divided.items,1,ops);assert.ok(!rules.some(rule=>rule.match.includes('no hot water')));const shifted=fixture({transformed:true});assert.deepEqual(await borderedTableRules(shifted.page,shifted.items,1,ops),[]);
});
