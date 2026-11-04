import test from 'node:test';
import assert from 'node:assert/strict';
import {externalCard,searchGiphy} from '../lib/cards.mjs';
const gif={id:'fixture',title:'Fixture',url:'https://giphy.com/gifs/fixture',images:{fixed_width:{url:'https://media.giphy.com/media/fixture/giphy.gif?cid=keep',width:'200',height:'150'}}};
test('direct GIPHY request preserves query, result order and media URL; no proxy or caching',async()=>{
 let called;const value=await searchGiphy({key:'test-only',query:'hi & @name',fetcher:async(url,options)=>{called={url,options};return {ok:true,json:async()=>({data:[gif,{...gif,id:'second'}],pagination:{total_count:3}})};}});
 assert.equal(called.url.origin,'https://api.giphy.com');assert.equal(called.url.searchParams.get('q'),'hi & @name');assert.equal(called.options.cache,'no-store');assert.equal(called.options.credentials,'omit');assert.deepEqual(value.items.map(v=>v.id),['fixture','second']);assert.equal(value.items[0].previewUrl,gif.images.fixed_width.url);assert.equal(value.hasMore,true);
 const card=externalCard(value.items[0]);assert.equal(card.canonicalUrl,gif.url);assert.equal(card.attribution,'GIPHY');assert.equal(card.previewUrl,undefined);
});
test('missing key makes no request; provider errors are actionable',async()=>{
 await assert.rejects(searchGiphy({query:'x',fetcher:()=>assert.fail('no request')}),/approved web API key/);
 await assert.rejects(searchGiphy({key:'test',query:'x',fetcher:async()=>({ok:false,status:429})}),/limit reached/);
});
test('reject other providers and unsafe canonical links',()=>{
 const item={provider:'giphy',id:'fixture',canonicalUrl:gif.url};
 for(const value of ['javascript:alert(1)','blob:test','http://giphy.com/gifs/test','https://giphy.com.evil.test/a','https://name:secret@giphy.com/a'])assert.equal(externalCard({...item,canonicalUrl:value}),null);
 assert.equal(externalCard({...item,provider:'tenor'}),null);
});
