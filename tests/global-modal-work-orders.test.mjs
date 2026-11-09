import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import {JSDOM} from 'jsdom';
import * as registry from '../src/lib/open-work-orders.ts';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {url:'https://cmpri.test', pretendToBeVisual:true});
dom.window.HTMLDialogElement.prototype.showModal=function(){this.dataset.testModal='true';this.setAttribute('open','');};
dom.window.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');this.dispatchEvent(new dom.window.Event('close'));};
Object.assign(globalThis, {window:dom.window, document:dom.window.document, HTMLElement:dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT:true});
Object.defineProperty(globalThis, 'navigator', {value:dom.window.navigator, configurable:true});
const React = await import('react');
const {createRoot} = await import('react-dom/client');
const require = createRequire(import.meta.url);
const code = ts.transpileModule(readFileSync('src/components/GlobalModalHost.tsx','utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
let nextId = 0;
let pathname = '/';
const empty = () => null;
const globals = {exports:{}, window, document, URL, URLSearchParams, HTMLElement:dom.window.HTMLElement, HTMLAnchorElement:dom.window.HTMLAnchorElement,
  Element:dom.window.Element, HTMLDialogElement:dom.window.HTMLDialogElement, Event:dom.window.Event, MutationObserver:dom.window.MutationObserver,
  CSS:{escape:value=>value}, crypto:{randomUUID:()=>`id-${++nextId}`},
  require(name) {
    if (['react','react/jsx-runtime','react-dom'].includes(name)) return require(name);
    if (name === 'next/navigation') return {usePathname:()=>pathname};
    if (name === '@/lib/open-work-orders') return registry;
    if (name === '@/lib/ui/header-palette') return {modalActionForRoute:()=>'',modalThemeStyle:()=>({}),modalTitleStyle:()=>({}),modalDisplayTitle:(_path,title)=>title,hasBonvoyTierHelp:()=>false};
    if (['./WorkOrderTierKey','./RoomRankerKey','./WorkOrderTitleGuest'].includes(name)) return {default:empty};
    if (name === '@/lib/auth/client-session') return {loadCmpriSession:async()=>({capabilities:['view_work_orders']})};
    if (name === './desktop/WorkOrderListWindow') return {default:({onOpenWorkOrder})=>React.createElement('div',{},
      React.createElement('button',{onClick:()=>onOpenWorkOrder({id:'one',display_id:'1',room:'101'})},'Open first'),
      React.createElement('button',{onClick:()=>onOpenWorkOrder({id:'two',display_id:'2',room:'102'})},'Open second'),
      ...['three','four','five','six'].map(id=>React.createElement('button',{key:id,onClick:()=>onOpenWorkOrder({id,display_id:id})},`Open ${id}`)))};
    throw Error(`Unexpected import: ${name}`);
  }};
vm.runInNewContext(code,globals);
const Component = globals.exports.default;
const click = async element => { assert.ok(element); await React.act(async()=>element.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true,cancelable:true}))); };
const button = label => Array.from(document.querySelectorAll('button')).find(item=>item.textContent===label && !item.closest('[inert]'));
const openProfile = async()=>React.act(async()=>window.dispatchEvent(new dom.window.CustomEvent('cmpri-open-modal',{detail:{href:'/profile',title:'Profile'}})));

test('switching among a generic modal and work orders preserves mounted frames and guarded drafts',async()=>{
  const root = createRoot(document.getElementById('root'));
  await React.act(async()=>root.render(React.createElement(Component)));
  try {
    await openProfile();
    const profile=document.querySelector('iframe[title="Profile"]');assert.ok(profile);
    await click(button('Work orders'));await click(button('Open first'));
    const first=document.querySelector('iframe[title="Work Order 1 · 101"]');assert.ok(first);
    first.contentWindow.draft='unsaved';
    await click(button('Work orders'));await click(button('Open second'));
    const second=document.querySelector('iframe[title="Work Order 2 · 102"]');assert.ok(second);
    await click(button('Work Order 1 · 101'));
    assert.equal(document.querySelector('iframe[title="Profile"]'),profile);
    assert.equal(document.querySelector('iframe[title="Work Order 1 · 101"]'),first);
    assert.equal(first.contentWindow.draft,'unsaved');
    first.contentDocument.addEventListener('cmpri-modal-cancel-request',event=>event.preventDefault());
    await click(document.querySelector('[data-modal-entry]:not([aria-hidden="true"]) button[aria-label="Close Work Order 1 · 101"]'));
    assert.equal(document.querySelector('iframe[title="Work Order 1 · 101"]'),first,'guarded close retains the draft');
    const secondToken=new URL(second.src).searchParams.get('modalToken');
    await React.act(async()=>window.dispatchEvent(new dom.window.MessageEvent('message',{origin:window.location.origin,source:second.contentWindow,data:{type:'cmpri-work-order-saved',modalToken:secondToken}})));
    assert.equal(document.querySelector('iframe[title="Work Order 2 · 102"]'),null,'background completion removes only its own entry');
    assert.equal(document.querySelector('iframe[title="Work Order 1 · 101"]'),first);
  } finally {await React.act(async()=>root.unmount());}
});

test('a native modal can open a separate work-order stack that survives the original modal closing',async()=>{
  const query = document.querySelectorAll.bind(document);
  document.querySelectorAll = selector => query(selector === 'dialog:modal, [role="dialog"][aria-modal="true"]' ? 'dialog[data-test-modal="true"][open], [role="dialog"][aria-modal="true"]' : selector);
  const dialogPrototype=dom.window.HTMLDialogElement.prototype;
  const previousShow=dialogPrototype.showModal, previousClose=dialogPrototype.close;
  dialogPrototype.showModal=function(){this.dataset.testModal='true';this.setAttribute('open','');};
  dialogPrototype.close=function(){this.removeAttribute('open');this.dispatchEvent(new dom.window.Event('close'));};
  const original=document.createElement('dialog');original.getClientRects=()=>[{}];document.body.appendChild(original);original.showModal();
  const root = createRoot(document.getElementById('root'));
  try {
    await React.act(async()=>root.render(React.createElement(Component)));
    await click(original.querySelector('button'));
    const shell=document.querySelector('dialog[data-cmpri-global-modal-shell]');assert.ok(shell?.hasAttribute('open'));
    await click(button('Open first'));
    const frame=shell.querySelector('iframe[title="Work Order 1 · 101"]');assert.ok(frame);
    frame.contentWindow.draft='unsaved';
    await React.act(async()=>{original.close();original.remove();});
    assert.equal(shell.querySelector('iframe[title="Work Order 1 · 101"]'),frame);
    assert.equal(frame.contentWindow.draft,'unsaved');
    await click(button('Work orders'));await click(button('Open first'));
    assert.equal(shell.querySelectorAll('iframe[title="Work Order 1 · 101"]').length,1,'reopening raises the same work order');
    frame.contentDocument.addEventListener('cmpri-modal-cancel-request',event=>event.preventDefault());
    await React.act(async()=>shell.dispatchEvent(new dom.window.Event('cancel',{cancelable:true})));
    assert.equal(shell.querySelector('iframe[title="Work Order 1 · 101"]'),frame,'native Escape respects the editor guard');
  } finally {
    await React.act(async()=>root.unmount());
    document.querySelectorAll=query;
    dialogPrototype.showModal=previousShow;dialogPrototype.close=previousClose;
    original.remove();
  }
});

test('an accessible custom modal also exposes the work-order launcher',async()=>{
  const query = document.querySelectorAll.bind(document);
  document.querySelectorAll = selector => query(selector === 'dialog:modal, [role="dialog"][aria-modal="true"]' ? 'dialog[data-test-modal="true"][open], [role="dialog"][aria-modal="true"]' : selector);
  const dialogPrototype=dom.window.HTMLDialogElement.prototype;
  const previousShow=dialogPrototype.showModal, previousClose=dialogPrototype.close;
  dialogPrototype.showModal=function(){this.dataset.testModal='true';this.setAttribute('open','');};
  dialogPrototype.close=function(){this.removeAttribute('open');};
  const original=document.createElement('div');original.setAttribute('role','dialog');original.setAttribute('aria-modal','true');original.getClientRects=()=>[{}];document.body.appendChild(original);
  const root=createRoot(document.getElementById('root'));
  try {
    await React.act(async()=>root.render(React.createElement(Component)));
    await click(original.querySelector('button'));
    const shell=document.querySelector('dialog[data-cmpri-global-modal-shell]');assert.ok(shell?.hasAttribute('open'));
    await click(button('Open first'));
    const frame=shell.querySelector('iframe[title="Work Order 1 · 101"]');assert.ok(frame);
    await React.act(async()=>original.remove());
    assert.equal(shell.querySelector('iframe[title="Work Order 1 · 101"]'),frame);
  } finally {
    await React.act(async()=>root.unmount());
    document.querySelectorAll=query;dialogPrototype.showModal=previousShow;dialogPrototype.close=previousClose;original.remove();
  }
});

test('a native dialog opened later offers a launcher without remounting the existing work-order draft',async()=>{
  const root=createRoot(document.getElementById('root'));
  const late=document.createElement('dialog');late.getClientRects=()=>[{}];
  const matches=late.matches.bind(late);late.matches=selector=>selector==='dialog:modal' ? late.hasAttribute('open') : matches(selector);
  try {
    await React.act(async()=>root.render(React.createElement(Component)));
    await openProfile();await click(button('Work orders'));await click(button('Open first'));
    const frame=document.querySelector('iframe[title="Work Order 1 · 101"]');assert.ok(frame);
    frame.contentWindow.draft='still here';
    await React.act(async()=>{document.body.appendChild(late);late.showModal();});
    assert.equal(late.querySelector('button')?.textContent,'Work orders');
    await click(late.querySelector('button'));
    assert.equal(document.querySelector('iframe[title="Work Order 1 · 101"]'),frame);
    assert.equal(frame.contentWindow.draft,'still here');
  } finally {await React.act(async()=>root.unmount());late.remove();}
});

test('five distinct work orders is the limit; existing orders still open and closing frees a place',async()=>{
  const root=createRoot(document.getElementById('root'));
  try {
    await React.act(async()=>root.render(React.createElement(Component)));
    await openProfile();
    for (const label of ['Open first','Open second','Open three','Open four','Open five']) {
      await click(button('Work orders'));await click(button(label));
    }
    assert.equal(document.querySelectorAll('iframe[src*="/work-orders/"]').length,5);
    const first=document.querySelector('iframe[title="Work Order 1 · 101"]');first.contentWindow.draft='preserved';
    await click(button('Work orders'));await click(button('Open six'));
    assert.match(document.querySelector('[role="alert"]').textContent,/five work orders.*Close one/i);
    assert.equal(document.querySelectorAll('iframe[src*="/work-orders/"]').length,5);
    await click(button('Open first'));
    assert.equal(document.querySelector('iframe[title="Work Order 1 · 101"]'),first);
    assert.equal(first.contentWindow.draft,'preserved');
    await click(document.querySelector('[data-modal-entry]:not([aria-hidden="true"]) button[aria-label="Close Work Order 1 · 101"]'));
    await click(button('Work orders'));await click(button('Open six'));
    assert.equal(document.querySelectorAll('iframe[src*="/work-orders/"]').length,5);
    assert.ok(document.querySelector('iframe[title="Work Order six"]'));
  } finally {await React.act(async()=>root.unmount());}
});

test('activating a work order owned by the desktop temporarily reveals it and can restore the original native modal',async()=>{
  const query=document.querySelectorAll.bind(document);
  document.querySelectorAll=selector=>query(selector === 'dialog:modal, [role="dialog"][aria-modal="true"]' ? 'dialog[data-test-modal="true"][open], [role="dialog"][aria-modal="true"]' : selector === 'dialog:modal' ? 'dialog[data-test-modal="true"][open]' : selector);
  const original=document.createElement('dialog');original.getClientRects=()=>[{}];document.body.appendChild(original);original.showModal();
  let closed=0, activated=0;original.addEventListener('close',()=>closed++);
  assert.equal(registry.claimWorkOrder('one','desktop',()=>activated++),'claimed');
  const root=createRoot(document.getElementById('root'));
  try {
    await React.act(async()=>root.render(React.createElement(Component)));
    await click(original.querySelector('button'));await click(button('Open first'));
    const shell=document.querySelector('dialog[data-cmpri-global-modal-shell]');
    assert.equal(activated,1);assert.equal(shell.open,false);assert.equal(original.open,false);
    assert.equal(closed,0,'temporary suspension does not invoke the original close handler');
    assert.equal(document.querySelectorAll('iframe[src*="/work-orders/"]').length,0);
    await click(button('Open screens'));
    assert.equal(original.open,true);assert.equal(shell.open,true);
  } finally {
    await React.act(async()=>root.unmount());registry.releaseWorkOrder('one','desktop');original.remove();document.querySelectorAll=query;
  }
});

test('revealing an existing desktop order hides and restores the entire custom-modal backdrop',async()=>{
  const query=document.querySelectorAll.bind(document);
  document.querySelectorAll=selector=>query(selector === 'dialog:modal, [role="dialog"][aria-modal="true"]' ? 'dialog[data-test-modal="true"][open], [role="dialog"][aria-modal="true"]' : selector === 'dialog:modal' ? 'dialog[data-test-modal="true"][open]' : selector);
  const backdrop=document.createElement('div');Object.assign(backdrop.style,{position:'absolute',top:'0px',right:'0px',bottom:'0px',left:'0px',visibility:'visible'});
  const original=document.createElement('div');original.setAttribute('role','dialog');original.setAttribute('aria-modal','true');original.getClientRects=()=>[{}];backdrop.appendChild(original);document.body.appendChild(backdrop);
  assert.equal(registry.claimWorkOrder('one','desktop-custom',()=>{}),'claimed');
  const root=createRoot(document.getElementById('root'));
  try {
    await React.act(async()=>root.render(React.createElement(Component)));
    await click(original.querySelector('button'));await click(button('Open first'));
    assert.equal(backdrop.style.visibility,'hidden');
    await click(button('Open screens'));
    assert.equal(backdrop.style.visibility,'visible');
  } finally {
    await React.act(async()=>root.unmount());registry.releaseWorkOrder('one','desktop-custom');backdrop.remove();document.querySelectorAll=query;
  }
});

test('a standalone work order occupies one shared slot until the route changes',async()=>{
  const root=createRoot(document.getElementById('root'));pathname='/work-orders/standalone';
  const previousFocus=window.focus;let focused=0;window.focus=()=>focused++;
  try {
    await React.act(async()=>root.render(React.createElement(Component)));
    for(let i=0;i<4;i++) assert.equal(registry.claimWorkOrder(`other-${i}`,'other',()=>{}),'claimed');
    assert.equal(registry.claimWorkOrder('extra','other',()=>{}),'limit');
    assert.equal(registry.claimWorkOrder('standalone','other',()=>{}),'existing');assert.equal(focused,1);
    pathname='/profile';await React.act(async()=>root.render(React.createElement(Component)));
    assert.equal(registry.claimWorkOrder('extra','other',()=>{}),'claimed');
  } finally {
    await React.act(async()=>root.unmount());pathname='/';window.focus=previousFocus;
    for(let i=0;i<4;i++)registry.releaseWorkOrder(`other-${i}`,'other');registry.releaseWorkOrder('extra','other');
  }
});
