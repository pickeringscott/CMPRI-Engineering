import {plainTextParts} from '../src/lib/plain-text-links.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {loadTs} from './helpers/load-ts.mjs';
import * as references from '../src/lib/work-order-reference.js';
const policy=loadTs('src/lib/work-order-mentions.ts',{'./plain-text-links':{plainTextParts}});
const links={plainTextParts};
const mentions=policy.workOrderMentionDirectory([{id:'scott',full_name:'Scott Pickering',role:'Chief Engineer'},{id:'dana',full_name:'Dana Reed',role:'Front Desk Manager'}]);
const nodes=(tree,predicate)=>{const out=[];function visit(n){if(!n||typeof n!=='object')return;if(Array.isArray(n)){n.forEach(visit);return;}if(predicate(n))out.push(n);visit(n.props?.children);}visit(tree);return out;};
function harness(){
 let states=[],cursor=0,value='';
 const react={useState(initial){const i=cursor++;if(!(i in states))states[i]=initial;return [states[i],v=>states[i]=typeof v==='function'?v(states[i]):v]},useRef(initial){const i=cursor++;if(!(i in states))states[i]={current:initial};return states[i]},useCallback:f=>f,useEffect(){},useLayoutEffect(){}};
 const jsx=(type,props)=>({type,props:props||{}}),exports={};
 vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/components/WorkOrderNoteComposer.tsx',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,require(name){return ({react,'react/jsx-runtime':{jsx,jsxs:jsx},'@/lib/work-order-mentions':policy,'@/lib/work-order-reference.js':references,'@/lib/plain-text-links':links})[name]||(()=>{throw Error(name)})()},requestAnimationFrame:fn=>fn()});
 const render=()=>{cursor=0;return exports.default({value,onChange:v=>value=v,mentions,tickets:[{id:'abcdef12-0000-4000-8000-000000000001',display_id:'123',room:'Room 209',issue:'Fan'}]})};
 const input=t=>nodes(t,n=>n.type==='textarea')[0];
 return {render,input,type(text,caret=text.length){let t=render();input(t).props.onFocus();input(t).props.onChange({target:{value:text,selectionStart:caret}});return render()},value:()=>value};
}
test('actual work-order composer shows first names and complete role titles while typing and accepts keyboard/touch at the caret',()=>{
 for(const [typed,label,key] of [['Sc','Scott','Tab'],['Front Desk M','Front Desk Manager','Enter'],['Chief E','Chief Engineer','touch'],['WO#1','WO#123','Tab']]){
  const h=harness();const draft='😀 before\n@'+typed+' after';let tree=h.type(draft,draft.indexOf(' after'));
  const option=nodes(tree,n=>n.props?.role==='option'&&n.props.children[0].props.children[1]===label)[0];assert.ok(option,label);
  assert.ok(!nodes(tree,n=>n.props?.role==='option').some(n=>JSON.stringify(n).includes('Pickering')));
  if(key==='touch')option.props.onClick();else { // Select the requested option, then accept using the actual keyboard handler.
   const all=nodes(tree,n=>n.props?.role==='option');const index=all.indexOf(option);
   for(let n=0;n<index;n++){h.input(tree).props.onKeyDown({key:'ArrowDown',nativeEvent:{},preventDefault(){}});tree=h.render();}
   h.input(tree).props.onKeyDown({key,nativeEvent:{},preventDefault(){}});
  }
  tree=h.render();assert.equal(h.value(),'😀 before\n@'+label+'  after');
  assert.ok(nodes(tree,n=>n.props?.['data-composer-mention']!==undefined).length);
 }
});
test('typed and pasted mentions remain visible and blue with exact native text; IME, Escape and Shift+Enter keep draft intact',()=>{
 const h=harness();
 for(const text of ['@Scott, ask @Front Desk Manager','😀 @Chief Engineer\nSee @WO#123']){
  const tree=h.type(text);assert.equal(h.input(tree).props.value,text);
  const tokens=nodes(tree,n=>n.props?.['data-composer-mention']!==undefined);assert.ok(tokens.length>=2);assert.ok(tokens.every(n=>n.props.className.includes('text-sky-300')));
 }
 let tree=h.type('@Sc');h.input(tree).props.onKeyDown({key:'Tab',nativeEvent:{isComposing:true},preventDefault(){throw Error('IME')}});assert.equal(h.value(),'@Sc');
 h.input(tree).props.onKeyDown({key:'Enter',shiftKey:true,nativeEvent:{},preventDefault(){throw Error('newline')}});assert.equal(h.value(),'@Sc');
 h.input(tree).props.onKeyDown({key:'Escape',nativeEvent:{}});tree=h.render();assert.equal(nodes(tree,n=>n.props?.role==='option').length,0);
});
test('saved notes render staff and full roles, preserve URLs, and keep numeric and legacy ticket navigation',()=>{
 const jsx=(type,props)=>({type,props:props||{}});const exports={};
 vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/components/WorkOrderMentionText.tsx',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,require:name=>({'react/jsx-runtime':{jsx,jsxs:jsx},'@/components/PlainTextLinks':{default:'links'},'@/lib/work-order-mentions':policy})[name]});
 const text='@Scott ask @Front Desk Manager. https://example.test/@Scott';
 const rendered=exports.default({text,mentions});
 const highlights=nodes(rendered,n=>n.props?.['data-work-order-mention']);assert.equal(highlights.length,2);assert.equal(highlights[1].props.children,'@Front Desk Manager');
 const source=readFileSync(new URL('../src/app/work-orders/[id]/page.tsx',import.meta.url),'utf8');const ast=ts.createSourceFile('page.tsx',source,99,true,4);let fn;
 function visit(n){if(ts.isFunctionDeclaration(n)&&n.name?.text==='renderHistoryText')fn=n.getText(ast);ts.forEachChild(n,visit)}visit(ast);assert.ok(fn);
 const tickets=[{id:'abcdef12-0000-4000-8000-000000000001',display_id:null,room:'Room 209'},{id:'other-legacy',display_id:null},{id:'ticket-number',display_id:'123'}];const opened=[];const e={};
 const program=ts.transpileModule(fn+'\nexports.run=renderHistoryText',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 vm.runInNewContext(program,{exports:e,require:()=>({jsx,jsxs:jsx}),plainTextParts:links.plainTextParts,...references,referencePrefixes:{abcdef12:tickets[0].id},referenceTickets:tickets,referenceError:'',mentionDirectory:mentions,ticketMentionLabel:t=>references.formatWorkOrder(t.display_id,`WO-${t.id.slice(0,8)}`),openMentionedTicket:t=>opened.push(t.id),PlainTextLinks:'links',WorkOrderMentionText:'mentions'});
 const result=e.run('@Scott @WO#123 @WO-abcdef12');const buttons=nodes(result,n=>n.type==='button');assert.equal(buttons.length,2);buttons.forEach(b=>b.props.onClick());assert.deepEqual(opened,['ticket-number',tickets[0].id]);
});


test('fully typed first names, full role titles and ticket labels close suggestions so posting stays accessible',()=>{
 const h=harness();
 for(const value of ['@Scott','@Scott ','@Front Desk Manager','@Front Desk Manager ','@WO#123']){
  const tree=h.type(value);assert.equal(h.input(tree).props.value,value);assert.equal(nodes(tree,n=>n.props?.role==='option').length,0,value);assert.ok(nodes(tree,n=>n.props?.['data-composer-mention']!==undefined).length,value);
 }
 const partial=h.type('@Front Desk M');assert.ok(nodes(partial,n=>n.props?.role==='option').length>0);
});
