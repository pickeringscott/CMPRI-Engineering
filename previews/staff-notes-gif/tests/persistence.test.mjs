import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {openStore,saveNote,listNotes,saveMedia,readLimited,assertLocal,mediaType,MAX_MEDIA} from '../lib/local-store.mjs';
import {GET,POST} from '../app/api/notes/route.js';import {POST as upload} from '../app/api/media/route.js';import {GET as download} from '../app/api/media/[id]/route.js';
const gif=Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64');
test('actual routes upload bytes, save canonical-link note, reopen database and download unchanged bytes',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'cmpri-persist-'));process.env.CMPRI_PREVIEW_LOCAL_DATA_DIR=directory;
 try{
 const result=await upload(new Request('http://localhost:3218/api/media',{method:'POST',headers:{'x-file-name':'test.gif'},body:gif}));assert.equal(result.status,200);const {media}=await result.json();
 const input={requestId:'test-note-0001',body:'Saved 😀',attachments:[{provider:'giphy',id:'fixture',canonicalUrl:'https://giphy.com/gifs/fixture',previewUrl:'https://media.giphy.com/fixture.gif',title:'GIF'}],mediaIds:[media.id]};
 const req=()=>new Request('http://localhost:3218/api/notes',{method:'POST',body:JSON.stringify(input)});
 assert.equal((await POST(req())).status,200);assert.equal((await POST(req())).status,200);
 const saved=await (await GET(new Request('http://localhost:3218/api/notes'))).json();assert.equal(saved.notes.length,1);assert.equal(saved.notes[0].body,'Saved 😀');assert.equal(saved.notes[0].attachments[0].previewUrl,undefined);assert.equal(saved.notes[0].local[0].saved,true);
 const file=await download(new Request('http://localhost:3218/api/media/'+media.id),{params:Promise.resolve({id:media.id})});assert.deepEqual(Buffer.from(await file.arrayBuffer()),gif);assert.equal(file.headers.get('content-type'),'image/gif');
 input.body='changed';assert.equal((await POST(req())).status,409);
 const db=openStore(directory);assert.equal(listNotes(db).length,1);db.close();
 }finally{delete process.env.CMPRI_PREVIEW_LOCAL_DATA_DIR;rmSync(directory,{recursive:true,force:true});}
});
test('unconfigured, Vercel, remote hosts and cross-origin requests fail closed',()=>{
 assert.throws(()=>assertLocal(new Request('http://localhost/api/notes')),/unavailable/);process.env.CMPRI_PREVIEW_LOCAL_DATA_DIR='/tmp/test';
 try{assert.throws(()=>assertLocal(new Request('https://cmpri-engineering.com/api/notes')),/unavailable/);assert.throws(()=>assertLocal(new Request('http://localhost/api/notes',{headers:{origin:'https://evil.test'}})),/Cross-origin/);process.env.VERCEL='1';assert.throws(()=>assertLocal(new Request('http://localhost/api/notes')),/unavailable/);}finally{delete process.env.VERCEL;delete process.env.CMPRI_PREVIEW_LOCAL_DATA_DIR;}
});
test('size limits enforced on actual bytes as well as claimed length; active files are download-only',async()=>{
 await assert.rejects(readLimited(new Request('http://localhost',{method:'POST',body:'12345'}),4),/size limit/);
 await assert.rejects(readLimited(new Request('http://localhost',{method:'POST',headers:{'content-length':String(MAX_MEDIA+1)},body:'a'}),MAX_MEDIA),/size limit/);
 assert.equal(mediaType(Buffer.from('<svg onload="alert(1)">')),'application/octet-stream');assert.equal(mediaType(Buffer.from('<html>')),'application/octet-stream');
});
test('unsaved attachment IDs and unsafe GIF URLs cannot create notes',()=>{
 const directory=mkdtempSync(join(tmpdir(),'cmpri-invalid-')),db=openStore(directory);
 try{const input={requestId:'invalid-note-0001',body:'x',attachments:[],mediaIds:['missing']};assert.throws(()=>saveNote(db,input),/not finished/);input.mediaIds=[];input.attachments=[{provider:'giphy',id:'test',canonicalUrl:'https://evil.test'}];assert.throws(()=>saveNote(db,input),/Invalid GIF/);assert.equal(listNotes(db).length,0);}finally{db.close();rmSync(directory,{recursive:true,force:true});}
});
