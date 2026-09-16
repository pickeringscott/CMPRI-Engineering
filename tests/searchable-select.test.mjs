// Runs the real component handlers with a deterministic hook harness.
// These are component logic tests, not browser/layout verification.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const code = ts.transpileModule(readFileSync(new URL('../src/components/SearchableSelect.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
}).outputText;
const options = [
  {value:'hall', label:'4th Floor Hallway', group:'Fourth Floor'},
  {value:'409', label:'Room 409', group:'Guest Rooms'},
  {value:'410', label:'Room 410', group:'Guest Rooms'},
  {value:'pump', label:'Pool Pump Room'},
  {value:'pool', label:'Pool Room'},
];
function mount(value='') {
  let cursor=0;
  const slots=[], calls=[];
  const hooks={
    useId:()=> 'test-list',
    useEffect:()=>{},
    useMemo:fn=>fn(),
    useRef:initial=> {const i=cursor++; return slots[i] ??= {current:initial};},
    useState:initial=> {const i=cursor++; if (!(i in slots)) slots[i]=initial;
      return [slots[i], next=>{slots[i]=typeof next==='function'?next(slots[i]):next;}];},
  };
  const exports={};
  const jsx=(type,props)=>({type,props});
  vm.runInNewContext(code, {exports, require:name=> {
    if(name==='react') return hooks;
    if(name==='react/jsx-runtime') return {jsx,jsxs:jsx,Fragment:'fragment'};
    throw new Error(name);
  }, requestAnimationFrame:fn=>fn()});
  let props={value,options,onChange:v=>{calls.push(v); props.value=v;}};
  function render(){cursor=0; return exports.default(props);}
  function find(node,type){if(!node || typeof node!=='object')return;
    if(node.type===type)return node;
    for(const child of [node.props?.children].flat(Infinity)){const hit=find(child,type);if(hit)return hit;}}
  const input=()=>find(render(),'input').props;
  const key=(name,extra={})=>{let prevented=false; input().onKeyDown({key:name,preventDefault(){prevented=true;},...extra});return prevented;};
  const search=q=>{input().onFocus(); input().onChange({target:{value:q}});};
  return {input,key,search,calls,external:v=>{props.value=v;}};
}
test('409 + Tab selects Room 409, leaves Tab navigation unblocked, closes menu',()=>{
  const c=mount();c.search('409');assert.equal(c.key('Tab'),false);
  assert.deepEqual(c.calls,['409']);assert.equal(c.input().value,'Room 409');assert.equal(c.input()['aria-expanded'],false);
});
test('pool + ArrowDown + Enter selects the second pool location',()=>{
  const c=mount();c.search('pool');c.key('ArrowDown');assert.equal(c.key('Enter'),true);assert.deepEqual(c.calls,['pool']);
});
test('a changed search resets the highlighted result',()=>{
  const c=mount();c.search('room');c.key('ArrowDown');c.input().onChange({target:{value:'pool'}});c.key('Tab');assert.deepEqual(c.calls,['pump']);
});
for(const key of ['Escape','Tab'])test(`${key} with no match preserves the saved room`,()=>{
  const c=mount('409');c.search('99999');c.key(key);assert.deepEqual(c.calls,[]);assert.equal(c.input().value,'Room 409');
});
test('Shift+Tab exits without committing a tentative match',()=>{
  const c=mount('409');c.search('410');c.key('Tab',{shiftKey:true});assert.deepEqual(c.calls,[]);assert.equal(c.input().value,'Room 409');
});
test('Tab through a saved selection preserves it',()=>{
  const c=mount('410');c.input().onFocus();c.key('Tab');assert.deepEqual(c.calls,[]);assert.equal(c.input().value,'Room 410');
});
test('closed field reflects parent changes and clearing without an effect',()=>{
  const c=mount('409');c.external('410');assert.equal(c.input().value,'Room 410');c.external('');assert.equal(c.input().value,'');
});
test('blur closes uncommitted search and restores selected label',()=>{
  const c=mount('409');c.search('pool');c.input().onBlur({relatedTarget:null});assert.equal(c.input()['aria-expanded'],false);assert.equal(c.input().value,'Room 409');assert.deepEqual(c.calls,[]);
});
