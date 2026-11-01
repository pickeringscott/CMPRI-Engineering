import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

const html = readFileSync('public/backgrounds/thanksgiving-animated/index.html', 'utf8');
function mount(reduce=false) {
  let next; const media={matches:reduce};
  const dom=new JSDOM(html,{runScripts:'dangerously',pretendToBeVisual:true,beforeParse(w){
    w.matchMedia=()=>media; w.requestAnimationFrame=fn=>{next=fn;};
    w.Element.prototype.getBoundingClientRect=function(){return {width:390,height:this.id==='art'?158.4375:844};};
  }});
  let clock=1; return {dom,media,step(n){for(let i=0;i<n;i++){clock+=100;next(clock);}},scene:dom.window.document.querySelector('#scene')};
}
test('persistent pile is bounded; falling continues after saturation; pause freezes and reload resets',()=>{
  const a=mount(); a.step(3500);
  assert.equal(+a.scene.dataset.settled,480);
  const landed=+a.scene.dataset.landed; a.step(200);
  assert.ok(+a.scene.dataset.landed>landed);
  assert.ok(a.scene.querySelectorAll('.leaf').length<=528);
  a.dom.window.document.querySelector('#toggle').click();
  const count=a.scene.dataset.landed;a.step(200);assert.equal(a.scene.dataset.landed,count);
  assert.equal(a.dom.window.document.querySelector('#toggle').getAttribute('aria-pressed'),'true');
  const fresh=mount();assert.equal(fresh.scene.querySelectorAll('.leaf').length,0);
  a.dom.window.close();fresh.dom.window.close();
});
test('reduced motion stops falling and runtime preference changes are respected',()=>{
  const a=mount(true);a.step(200);assert.equal(a.scene.querySelectorAll('.leaf').length,80);
  a.media.matches=false;a.step(200);assert.ok(+a.scene.dataset.landed>0);
  a.media.matches=true;const count=a.scene.dataset.landed;a.step(200);assert.equal(a.scene.dataset.landed,count);a.dom.window.close();
});
test('responsive mount shares unchanged artwork across desktop and mobile accounts',()=>{
  const component=readFileSync('src/components/desktop/ThanksgivingBackground.tsx','utf8');
  assert.ok(!component.includes('matchMedia'));assert.ok(!component.includes('return null'));
  assert.match(component,/sandbox="allow-scripts"/);
  const page=readFileSync('src/app/engineering/page.tsx','utf8');assert.match(page,/<ThanksgivingBackground \/>/);
  const css=readFileSync('src/app/globals.css','utf8');assert.match(css,/thanksgiving-mobile\.png/);
  assert.ok(!html.includes('data:image'));assert.ok(!html.includes('Corrected preview'));
});
