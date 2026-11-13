import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadTs } from './helpers/load-ts.mjs';

test('restored winter checklist preserves every supplied source word and all 32 item identities',()=>{
  const {WINTER_TASKS,WINTER_TASK_IDS}=loadTs('src/lib/winter-preparedness.ts');
  assert.equal(WINTER_TASKS.length,21);
  assert.equal(WINTER_TASKS[19].children.length,8);
  assert.equal(WINTER_TASKS[20].children.length,3);
  assert.equal(new Set(WINTER_TASK_IDS).size,32);
  const normalize=s=>s.replace(/\u200b/g,'').replace(/\s+/g,' ').trim();
  const source=readFileSync(new URL('./fixtures/winter-preparedness-source.txt',import.meta.url),'utf8').split('Maintenance & IT -> Additional Resources')[1];
  const actual=WINTER_TASKS.flatMap(t=>[t.text,...(t.children||[]).map(c=>c.text)]).join(' ');
  assert.equal(normalize(actual),normalize(source));
});
