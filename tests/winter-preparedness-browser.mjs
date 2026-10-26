// Run against an isolated dev server configured with https://fixture.invalid.
// BROWSER_TOOLS_MODULE points to playwright's index.mjs outside the application dependencies.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { winterFixture, actor, hotel, principal } from './helpers/winter-fixture.mjs';
const { chromium } = await import(pathToFileURL(process.env.BROWSER_TOOLS_MODULE).href);
const origin = process.env.WINTER_TEST_ORIGIN || 'http://localhost:3013';
assert.match(origin, /^http:\/\/(localhost|127\.0\.0\.1):\d+$/);
const f = await winterFixture();
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true });
const output = process.env.WINTER_TEST_OUTPUT || '../winter-test-output'; mkdirSync(output, { recursive:true });
let failNext = false;
let page;
try {
  const context = await browser.newContext({viewport:{width:1280,height:900}});
  await context.addInitScript(({actor}) => {
    localStorage.setItem('cmpri:remember','true');
    localStorage.setItem('cmpri:auth:v1',JSON.stringify({access_token:'fixture-token',refresh_token:'fixture-refresh',expires_at:Math.floor(Date.now()/1000)+3600,token_type:'bearer',user:{id:actor,email:'fixture@example.invalid',aud:'authenticated'}}));
  }, {actor});
  await context.route('**/*',async route => {
    const request = route.request(), url = new URL(request.url());
    if(url.origin !== origin) return route.fulfill({status:200,json:{}});
    if(url.pathname === '/api/session') return route.fulfill({json:{user:{id:actor,name:f.auth.principal.profile.full_name,email:'fixture@example.invalid',role:f.auth.principal.profile.role},hotelId:hotel,landing:'/engineering',capabilities:['view_dashboard','view_engineering_operations','view_work_orders','view_profiles']}});
    if(url.pathname === '/api/winter-preparedness') {
      if(failNext && request.method()==='PATCH') {failNext=false;return route.fulfill({status:503,json:{error:'Fixture save unavailable. Reload before retrying.'}});}
      const response = request.method()==='PATCH' ? await f.route.PATCH(new Request(request.url(),{method:'PATCH',body:request.postData()})) : await f.route.GET();
      return route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()});
    }
    if(url.pathname.startsWith('/api/')) return route.fulfill({json:{work_orders:[],drafts:[],notifications:[],notes:[],mentions:[],unread:0,connected:false}});
    return route.continue();
  });
  page = await context.newPage();
  page.on('pageerror', error => console.log('Browser error:',error.message));
  await page.goto(origin+'/engineering');
  const launcher = page.locator('[data-cmpri-desktop-launch="/engineering/winter-preparedness"]:visible');
  if(!await launcher.isVisible()) await page.getByRole('button',{name:/^Ops$|^Operations$/}).first().click();
  await launcher.click();
  let frame = page.frameLocator('iframe[title="Winter Preparedness 2026"]');
  await frame.locator('input[type=checkbox]').first().waitFor();
  assert.equal(await frame.locator('input[type=checkbox]').count(),32);
  assert.equal(await frame.locator('input:checked').count(),0);
  await Promise.all([page.waitForResponse(response=>response.url().endsWith('/api/winter-preparedness')&&response.request().method()==='PATCH'),frame.getByLabel('Shovels',{exact:true}).click()]);
  await frame.locator('input:checked').waitFor();
  await frame.getByRole('status').filter({hasText:'All changes saved.'}).waitFor();
  assert.equal(await frame.getByLabel('Shovels',{exact:true}).isChecked(),true);
  await frame.getByText(/Last changed by Fixture Engineer/).waitFor();
  await page.screenshot({path:output+'/desktop-modal.png'});
  await frame.getByRole('button',{name:'Close',exact:true}).click();
  await page.locator('iframe[title="Winter Preparedness 2026"]').waitFor({state:'detached'});
  if(!await launcher.isVisible()) await page.getByRole('button',{name:/^Ops$|^Operations$/}).first().click();
  await launcher.click();
  frame = page.frameLocator('iframe[title="Winter Preparedness 2026"]');
  await frame.getByLabel('Shovels',{exact:true}).waitFor();
  assert.equal(await frame.getByLabel('Shovels',{exact:true}).isChecked(),true);
  await page.reload();
  if(!await launcher.isVisible()) await page.getByRole('button',{name:/^Ops$|^Operations$/}).first().click();
  await launcher.click();
  frame = page.frameLocator('iframe[title="Winter Preparedness 2026"]');
  await frame.getByLabel('Shovels',{exact:true}).waitFor();
  assert.equal(await frame.getByLabel('Shovels',{exact:true}).isChecked(),true);
  console.log('PASS actual Ops modal, 32 controls, persisted close/reopen and full reload');
  // Print the same production component standalone; iframe Print invokes its own window.print().
  await page.goto(origin+'/engineering/winter-preparedness');
  await page.getByLabel('Shovels',{exact:true}).waitFor();
  await page.evaluate(()=>{window.print=()=>{window.__printed=true;};});
  await page.getByRole('button',{name:'Print',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.__printed),true);
  await page.emulateMedia({media:'print'});
  assert.equal(await page.getByRole('button',{name:'Print',exact:true}).isVisible(),false);
  assert.equal(await page.getByText(/Last changed by Fixture Engineer/).isVisible(),false);
  await page.pdf({path:output+'/winter-print.pdf',format:'Letter',printBackground:true});
  await page.screenshot({path:output+'/print-layout.png',fullPage:true});
  await page.emulateMedia({media:'screen'});
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
  await page.screenshot({path:output+'/mobile.png',fullPage:true});
  failNext=true;
  await page.getByLabel('Extra blankets',{exact:true}).click();
  await page.locator('main [role="alert"]').waitFor();
  assert.equal(await page.getByLabel('Extra blankets',{exact:true}).isChecked(),false);
  assert.equal(await page.getByRole('button',{name:'Print',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'Reload',exact:true}).click();
  await page.getByRole('status').filter({hasText:'Latest saved progress loaded.'}).waitFor();
  await f.route.PATCH(new Request(origin+'/api/winter-preparedness',{method:'PATCH',body:JSON.stringify({item_id:'shovels',checked:false,revision:1})}));
  await page.getByLabel('Shovels',{exact:true}).click();
  await page.getByRole('alert').filter({hasText:'changed elsewhere'}).waitFor();
  await page.getByRole('button',{name:'Reload',exact:true}).click();
  await page.getByRole('status').filter({hasText:'Latest saved progress loaded.'}).waitFor();
  assert.equal(await page.getByLabel('Shovels',{exact:true}).isChecked(),false);
  console.log('PASS print hides attribution/chrome; mobile fits; failed saves and conflicts recover');
  for (const role of ['General Manager','Assistant General Manager','Front Desk Manager']) {
    f.auth.principal=principal(role);
    await page.goto(origin+'/engineering/winter-preparedness');
    await page.getByLabel('Shovels',{exact:true}).waitFor();
    assert.equal(await page.locator('input[type=checkbox]').count(),32);
  }
  f.auth.principal=principal('front_desk');
  await page.goto(origin+'/engineering/winter-preparedness');
  await page.locator('main [role="alert"]').waitFor(); assert.equal(await page.locator('input[type=checkbox]').count(),0);
  console.log('PASS GM/AGM/FDM page access and ordinary Front Desk denial; all data isolated in PGlite');
} catch (error) { if (page) { console.log((await page.locator('body').innerText()).slice(0,4000)); await page.screenshot({path:output+'/failure.png'}); } throw error; }
finally { await browser.close(); await f.close(); }
