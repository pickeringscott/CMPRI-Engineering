import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as core from '../src/lib/hours-tracker.ts';

function fixture(initial=null,requirePersonalSetup=true) {
 const slots=[];let cursor=0,tree;const saves=[];
 const react={useState(initial){const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return [slots[i],value=>{slots[i]=typeof value==='function'?value(slots[i]):value;}];},useRef(initial){const i=cursor++;return slots[i]??(slots[i]={current:initial});},useEffect(){}};
 const jsx=(type,props)=>({type,props});const exports={};
 const deps={react,'react/jsx-runtime':{jsx,jsxs:jsx},'@/lib/hours-tracker':core,'./hours.module.css':{default:{}}};
 const source=readFileSync(new URL('../src/app/engineering/hours-tracker/HoursTracker.tsx',import.meta.url),'utf8');
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,structuredClone,require:name=>{assert.ok(name in deps,name);return deps[name];}});
 const render=()=>{cursor=0;tree=exports.default({owner:'Synthetic person',initial,requirePersonalSetup,today:'2026-10-14',onClose(){},persist:async body=>{saves.push(body);return {revision:1,document:{version:1,anchor:core.PAYROLL_ANCHOR,periods:[body.period],leaveConfigurations:[]}};}});return tree;};
 const nodes=()=>{const result=[];function walk(node){if(!node||typeof node!=='object')return;if(Array.isArray(node)){node.forEach(walk);return;}result.push(node);walk(node.props?.children);}walk(tree);return result;};
 const text=node=>Array.isArray(node)?node.map(text).join(''):node&&typeof node==='object'?text(node.props?.children):String(node??'');
 const button=label=>nodes().find(n=>n.type==='button'&&text(n)===label);
 const input=label=>nodes().find(n=>n.type==='input'&&n.props['aria-label']===label);
 const commit=(label,value)=>{const buttonLabel=label==='Hourly rate'?'$0.00/h\u00a0 edit':'0%\u00a0 edit';button(buttonLabel).props.onClick();render();input(label).props.onChange({target:{value}});render();input(label).props.onKeyDown({key:'Enter'});render();};
 render();return {render,nodes,text:()=>text(tree),button,input,commit,saves};
}
test('new personal tracker cannot save illustrative pay settings; own values and blank days persist',async()=>{
 const f=fixture();assert.match(f.text(),/\$0\.00/);assert.doesNotMatch(f.text(),/22\.29|31\.88|17\.61/);
 const save=()=>f.nodes().find(n=>n.type==='button'&&/^Save/.test(String(n.props.children))).props.onClick();
 await save();f.render();assert.equal(f.saves.length,0);assert.match(f.text(),/Enter and confirm your own rate/);
 f.commit('Hourly rate','19.75');await save();f.render();assert.equal(f.saves.length,0);
 f.commit('Deduction percent','14');await save();f.render();assert.equal(f.saves.length,1);
 assert.equal(f.saves[0].period.rateCents,1975);assert.equal(f.saves[0].period.deductionPercent,14);
 assert.ok(f.saves[0].period.days.every(day=>day.attendance.state==='blank'&&day.leave.length===0));
});
test('existing owner pay settings are preserved without a new setup requirement',async()=>{
 const p={start:'2026-10-02',days:core.emptyPeriod('2026-10-02'),rateCents:1875,deductionPercent:12};
 const f=fixture({revision:4,document:{version:1,anchor:core.PAYROLL_ANCHOR,periods:[p],leaveConfigurations:[]}});
 assert.match(f.text(),/18\.75/);const save=f.nodes().find(n=>n.type==='button'&&/^Save/.test(String(n.props.children)));await save.props.onClick();assert.equal(f.saves.length,1);assert.equal(f.saves[0].period.rateCents,1875);
});
