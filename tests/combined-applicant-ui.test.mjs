import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {employmentHtml} from '../src/app/employment/document.ts';
test('applicant attachment removes and reattaches the same original file without preview or autofill',()=>{
 const dom=new JSDOM(employmentHtml,{url:'https://www.cmpri-engineering.com/employment',runScripts:'outside-only'});
 try{
 const {window:w}=dom;for(const script of w.document.querySelectorAll('script:not([src])'))w.eval(script.textContent);
 w.eval(readFileSync(new URL('../public/employment/applicant.js',import.meta.url),'utf8'));
 const input=w.document.getElementById('resumeFile');const file=new w.File(['%PDF-1.7\noriginal\n%%EOF'],'same.pdf',{type:'application/pdf'});
 Object.defineProperty(input,'files',{configurable:true,value:[file]});input.dispatchEvent(new w.Event('change',{bubbles:true}));
 assert.equal(w.document.getElementById('resumeName').textContent,'same.pdf');assert.equal(w.document.getElementById('resumeSelection').hidden,false);
 w.document.getElementById('removeResume').click();assert.equal(input.value,'');assert.equal(w.document.getElementById('resumeSelection').hidden,true);
 input.dispatchEvent(new w.Event('change',{bubbles:true}));assert.equal(w.document.getElementById('resumeName').textContent,'same.pdf');
 const drop=new w.Event('drop',{bubbles:true,cancelable:true});Object.defineProperty(drop,'dataTransfer',{value:{files:[file],types:['Files']}});w.document.dispatchEvent(drop);assert.equal(drop.defaultPrevented,true);
 assert.equal(w.document.querySelectorAll('iframe,embed,object').length,0);assert.equal(w.document.getElementById('name').value,'');
 const role=w.document.getElementById('role');role.value='front';role.dispatchEvent(new w.Event('change',{bubbles:true}));assert.equal(w.document.querySelectorAll('#skills select').length,3);
 role.value='maintenance';role.dispatchEvent(new w.Event('change',{bubbles:true}));assert.equal(w.document.querySelectorAll('#skills select').length,4);
 }finally{dom.window.close();}
});
