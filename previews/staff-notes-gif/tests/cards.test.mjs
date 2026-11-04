import test from 'node:test';
import assert from 'node:assert/strict';
import {externalCard,mergeResults} from '../lib/cards.mjs';
import {providerStatus} from '../lib/provider-status.mjs';
import {GET as giphy} from '../app/api/gifs/giphy/route.js';
import {GET as tenor} from '../app/api/gifs/tenor/route.js';
const item={provider:'giphy',id:'synthetic-test',title:'Test fixture',canonicalUrl:'https://giphy.com/gifs/synthetic-test',previewUrl:'https://media.giphy.com/media/synthetic-test/giphy.gif?cid=preserve',width:200,height:150};
test('external card retains canonical URL, metadata and attribution without blob conversion',()=>{
  const card=externalCard(item);assert.equal(card.kind,'external-link');assert.equal(card.canonicalUrl,item.canonicalUrl);assert.equal(card.previewUrl,item.previewUrl);assert.equal(card.attribution,'GIPHY');assert.equal(card.height,150);
});
test('reject unsafe or mismatched URLs and credentials',()=>{
  for(const value of ['javascript:alert(1)','blob:test','http://giphy.com/gifs/test','https://giphy.com.evil.test/a','https://giphy.com@evil.test/a','https://name:secret@giphy.com/a'])assert.equal(externalCard({...item,canonicalUrl:value}),null);
  assert.equal(externalCard({...item,provider:'other'}),null);assert.equal(externalCard({...item,previewUrl:'https://tracking.test/a.gif'}),null);
});
test('UI contract merges test-only results fairly and removes duplicates',()=>{
  const other={...item,provider:'tenor',id:'other',canonicalUrl:'https://tenor.com/view/test',previewUrl:'https://media.tenor.com/test.gif'};
  assert.deepEqual(mergeResults([{items:[item,item]},{items:[other]}]).map(c=>c.provider),['giphy','tenor']);
});
test('providers remain blocked even when a key exists; retirement is not misreported as empty results',()=>{
  assert.equal(providerStatus('giphy',false).code,'NOT_CONFIGURED');assert.equal(providerStatus('giphy',true).code,'INTEGRATION_NOT_APPROVED');assert.equal(providerStatus('tenor',true).status,410);
});
test('actual server routes expose no credentials and perform no upstream calls',async()=>{
  const previous=process.env.GIPHY_API_KEY,oldFetch=global.fetch;
  process.env.GIPHY_API_KEY='test-only-never-expose';global.fetch=()=>{throw Error('No external call allowed');};
  try{const a=giphy(),b=tenor();assert.equal(a.status,503);assert.equal(b.status,410);const body=await a.text();assert.ok(!body.includes(process.env.GIPHY_API_KEY));assert.equal(a.headers.get('cache-control'),'private, no-store');}finally{global.fetch=oldFetch;if(previous===undefined)delete process.env.GIPHY_API_KEY;else process.env.GIPHY_API_KEY=previous;}
});
