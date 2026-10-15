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
function mount(value='', overrides={}) {
  let cursor=0;
  const slots=[], calls=[];
  const hooks={
    useId:()=> 'test-list',
    useEffect:()=>{},
    useLayoutEffect:()=>{},
    useMemo:fn=>fn(),
    useRef:initial=> {const i=cursor++; return slots[i] ??= {current:initial};},
    useState:initial=> {const i=cursor++; if (!(i in slots)) slots[i]=initial;
      return [slots[i], next=>{slots[i]=typeof next==='function'?next(slots[i]):next;}];},
  };
  const exports={};
  const jsx=(type,props)=>({type,props});
  function findRole(node,role){if(!node || typeof node!=='object')return;
    if(node.props?.role===role)return node;
    for(const child of [node.props?.children].flat(Infinity)){const hit=findRole(child,role);if(hit)return hit;}}
  function findAllRole(node,role,result=[]){if(!node || typeof node!=='object')return result;
    if(node.props?.role===role)result.push(node);
    for(const child of [node.props?.children].flat(Infinity))findAllRole(child,role,result);
    return result;}
  vm.runInNewContext(code, {exports, require:name=> {
    if(name==='react') return hooks;
    if(name==='react/jsx-runtime') return {jsx,jsxs:jsx,Fragment:'fragment'};
    throw new Error(name);
  }, requestAnimationFrame:fn=>fn()});
  let props={value,options,onChange:v=>{calls.push(v); props.value=v;},...overrides};
  function render(){cursor=0; return exports.default(props);}
  function find(node,type){if(!node || typeof node!=='object')return;
    if(node.type===type)return node;
    for(const child of [node.props?.children].flat(Infinity)){const hit=find(child,type);if(hit)return hit;}}
  const input=()=>find(render(),'input').props;
  const key=(name,extra={})=>{let prevented=false; input().onKeyDown({key:name,preventDefault(){prevented=true;},...extra});return prevented;};
  const search=q=>{input().onFocus(); input().onChange({target:{value:q}});};
  return {input,key,search,calls,external:v=>{props.value=v;},findRole:role=>findRole(render(),role),findAllRole:role=>findAllRole(render(),role),getDropdownPosition:exports.getDropdownPosition};
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
test('expanded options use a vertically scrollable touch-friendly listbox',()=>{
  const c=mount();c.input().onFocus();c.key('ArrowDown');
  const listbox=c.findRole('listbox');
  assert.match(listbox.props.className,/max-h-80 overflow-y-auto/);
  assert.match(listbox.props.className,/overscroll-contain touch-pan-y/);
});
test('asset-style selectors show every option in the scrollable list on first open',()=>{
  const assetOptions=Array.from({length:40},(_,index)=>({value:`asset-${index}`,label:`Asset ${index}`}));
  const c=mount('',{options:assetOptions,expandOnOpen:true,showSuggestionsOnOpen:false,topSuggestions:3});
  c.input().onFocus();
  assert.equal(c.input()['aria-expanded'],true);
  assert.equal(c.findAllRole('option').length,assetOptions.length);
  assert.match(c.findRole('listbox').props.className,/max-h-80 overflow-y-auto/);
});
test('dropdown stays inside the modal viewport and opens above when that gives more room',()=>{
  const position=mount().getDropdownPosition;
  const below=position({top:40,bottom:80,left:20,width:280},{width:400,height:600});
  assert.deepEqual({...below},{top:84,left:20,width:280,maxHeight:320});
  const above=position({top:210,bottom:250,left:20,width:280},{width:400,height:300});
  assert.deepEqual({...above},{top:8,left:20,width:280,maxHeight:198});
});
test('dropdown scrollbar has an explicit visible track and thumb',()=>{
  const css=readFileSync(new URL('../src/app/globals.css',import.meta.url),'utf8');
  assert.match(css,/\.cmpri-searchable-select-listbox::-webkit-scrollbar\s*\{\s*width:\s*12px/);
  assert.match(css,/\.cmpri-searchable-select-listbox::-webkit-scrollbar-thumb/);
});
test('blur closes uncommitted search and restores selected label',()=>{
  const c=mount('409');c.search('pool');c.input().onBlur({relatedTarget:null});assert.equal(c.input()['aria-expanded'],false);assert.equal(c.input().value,'Room 409');assert.deepEqual(c.calls,[]);
});


test('typing the exact saved Front Desk label remains a search, not browse-all, until explicit selection',()=>{
 const options=[{value:'desk',label:'Front Desk'},{value:'lobby',label:'Lobby'},{value:'137',label:'Room 137'}];
 const c=mount('desk',{options});c.search('Front Desk');
 assert.equal(c.findAllRole('option').length,1);assert.deepEqual(c.calls,[]);
 c.key('Escape');assert.equal(c.input().value,'Front Desk');assert.deepEqual(c.calls,[]);
});
