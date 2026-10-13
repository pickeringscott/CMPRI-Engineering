// Local Chromium fixtures only. Requires Playwright, esbuild, and Chromium.
// Optional CMPRI_ESBUILD_MODULE / CMPRI_CHROMIUM_PATH locate those local tools.
import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const {build}=require(process.env.CMPRI_ESBUILD_MODULE || 'esbuild');
const {chromium}=require('playwright');
const postcss=require('postcss');
const tailwind=require('@tailwindcss/postcss');
const root=resolve(new URL('..',import.meta.url).pathname);
const output=process.env.CMPRI_UI_OUTPUT || '/tmp/cmpri-phone-test-ui';
await mkdir(output,{recursive:true});
const user='00000000-0000-0000-0000-000000000002';
const result=await build({absWorkingDir:root,stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import ProfilePage from './src/app/profile/page';createRoot(document.getElementById('root')).render(<ProfilePage/>);`,resolveDir:root,loader:'tsx'},bundle:true,write:false,jsx:'automatic',format:'iife',plugins:[{
  name:'fixture-auth',setup(b){
    b.onResolve({filter:/^@\/lib\/supabase\/client$/},()=>({path:'fixture-session',namespace:'fixture'}));
    b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`export async function getValidSession(){return {access_token:'local-fixture',user:{id:'${user}'}}};export async function signOutDevice(){}` ,loader:'js'}));
    b.onResolve({filter:/^@\//},args=>({path:resolve(root,'src',args.path.slice(2)+(args.path.endsWith('use-embedded-modal') || args.path.endsWith('account-display') || args.path.endsWith('roles') || args.path.endsWith('schedule') || args.path.endsWith('installed-mobile') || args.path.endsWith('push-test-status') ? '.ts':'.tsx'))}));
  },
}]});
const css=(await postcss([tailwind({base:root})]).process('@import "tailwindcss";',{from:resolve(root,'src/app/globals.css')})).css;
const html=`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script>${result.outputFiles[0].text}</script></body></html>`;
const server=createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end(html);});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const url=`http://127.0.0.1:${server.address().port}/profile`;
const browser=await chromium.launch({executablePath:process.env.CMPRI_CHROMIUM_PATH || '/usr/bin/chromium',headless:true,args:['--no-sandbox']});
const summary=[];
try {
  const baseline=execFileSync('git',['show','86ab90c:src/app/profile/page.tsx'],{cwd:root,encoding:'utf8'});
  const current=await readFile(resolve(root,'src/app/profile/page.tsx'),'utf8');
  const chat=text=>text.slice(text.indexOf('{canManageChatgptConnection &&'),text.indexOf('{phoneSettings && <section'));
  assert.ok(chat(baseline).length>100); assert.equal(chat(current),chat(baseline),'ChatGPT section must remain byte-for-byte unchanged');
  for(const config of [
    {name:'s23-installed',width:412,mobile:true,standalone:true},
    {name:'narrow-installed',width:360,mobile:true,standalone:true},
    {name:'phone-browser',width:412,mobile:true,standalone:false},
    {name:'desktop-browser',width:1280,mobile:false,standalone:false},
    {name:'desktop-installed',width:1280,mobile:false,standalone:true},
  ]) {
    const context=await browser.newContext({viewport:{width:config.width,height:915},isMobile:config.mobile,hasTouch:config.mobile,userAgent:config.mobile?'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36'});
    const page=await context.newPage();
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(({standalone,mobile})=>{
      const match=window.matchMedia.bind(window);
      window.matchMedia=query=>query==='(display-mode: standalone)'?{matches:standalone,media:query,addEventListener(){},removeEventListener(){}}:match(query);
      Object.defineProperty(navigator,'userAgentData',{value:{mobile},configurable:true});
      Object.defineProperty(navigator,'serviceWorker',{value:{getRegistration:async()=>({pushManager:{getSubscription:async()=>({endpoint:'https://push.example.invalid/current'})}})},configurable:true});
      window.PushManager=class{};
    },config);
    let job=null;let loseNextSendResponse=false;const requests=[];
    await page.route('**/api/**',async route=>{
      const request=route.request();const path=new URL(request.url()).pathname;
      let payload;
      if(path==='/api/profile') payload={profile:{id:user,email:'fixture@example.invalid',full_name:'Fixture Engineer',role:'system_admin'},preferences:{language:'en',appearance:'dark',notification_mode:'in_app',notifications:{new_work_orders:true,status_changes:true,mentions:true}},profile_settings_available:true,can_manage_users:false,chatgpt_connection:null};
      else if(path==='/api/profile/phone-notifications') payload={public_key:'local-fixture-public',subscribed_on_this_device:true,configured:true,settings:{timezone:'America/Chicago',schedule:Object.fromEntries(['monday','tuesday','wednesday','thursday','friday','saturday','sunday'].map(day=>[day,{enabled:true,start:'08:45',end:'17:30'}]))}};
      else if(path==='/api/profile/phone-notifications/test') {
        const body=request.postDataJSON();requests.push(body);
        if(body.action==='send')job={id:body.id,status:'pending',due_at:new Date(Date.now()+body.delay_seconds*1000).toISOString(),expires_at:new Date(Date.now()+100000).toISOString()};
        if(body.action==='send' && loseNextSendResponse) { loseNextSendResponse=false;await route.abort('failed');return; }
        if(body.action==='cancel') job={...job,status:'cancelled'};
        payload={test:job};
      } else throw new Error('Unexpected request '+path);
      await route.fulfill({json:payload});
    });
    await page.goto(url);await page.getByText('Enabled on this device',{exact:true}).waitFor();
    const now=page.getByRole('button',{name:'Send test notification now'});
    if(config.mobile&&config.standalone) {
      await now.waitFor();
      const buttons=await page.getByLabel('Phone notification controls').locator('button').all();
      assert.equal(buttons.length,3);assert.deepEqual(await Promise.all(buttons.map(b=>b.innerText())),['Disable','Send now','Send in 10 seconds']);
      const boxes=await Promise.all(buttons.map(b=>b.boundingBox()));
      await page.screenshot({path:resolve(output,`${config.name}.png`),fullPage:true});
      assert.ok(boxes.every(b=>b.height===40));
      assert.ok(boxes.every(b=>b.x>=0&&b.x+b.width<=config.width));
      if(config.width>=412) assert.ok(boxes[1].x>=boxes[0].x+boxes[0].width&&boxes[2].x>=boxes[1].x+boxes[1].width);
      else assert.ok(boxes[2].y>=boxes[1].y);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      await page.screenshot({path:resolve(output,`${config.name}.png`),fullPage:true});
      await page.getByRole('button',{name:'Send test notification in 10 seconds'}).click();
      await page.getByText(/Test scheduled for this device/).waitFor();
      assert.equal(requests.filter(r=>r.action==='send').length,1);
      assert.equal(requests.find(r=>r.action==='send').delay_seconds,10);
      assert.equal(await now.isDisabled(),true);
      await page.getByRole('button',{name:'Cancel test',exact:true}).click();
      await page.getByText('Test cancelled.',{exact:true}).waitFor();
      await now.click();await page.getByText(/Test scheduled for this device/).waitFor();
      assert.equal(requests.filter(r=>r.action==='send')[1].delay_seconds,0);
      // Closing and reopening the page loads server status without sending another test.
      await page.reload();await page.getByText(/Test scheduled for this device/).waitFor();
      assert.equal(requests.filter(r=>r.action==='send').length,2);
      await page.getByRole('button',{name:'Cancel test',exact:true}).click();
      await page.getByText('Test cancelled.',{exact:true}).waitFor();
      loseNextSendResponse=true;
      await now.click();
      await page.getByRole('button',{name:'Check test status',exact:true}).click();
      await page.getByText(/Test scheduled for this device/).waitFor();
      assert.equal(requests.filter(r=>r.action==='send').length,3);
      assert.equal(await now.isDisabled(),true);
      summary.push({context:config.name,buttonHeights:boxes.map(b=>b.height),noOverflow:true,sendAndCancel:true,restoredWithoutResend:true,lostResponseRecoveredWithoutResend:true});
    } else {
      await page.waitForTimeout(100);
      assert.equal(await now.count(),0);
      assert.equal(requests.length,0);
      summary.push({context:config.name,testButtons:0,testRequests:0});
    }
    assert.deepEqual(errors,[]);await context.close();
  }
  await writeFile(resolve(output,'verification.json'),JSON.stringify(summary,null,2)+'\n');
  console.log(JSON.stringify(summary,null,2));
} finally {await browser.close();server.close();}
