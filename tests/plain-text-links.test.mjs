import assert from 'node:assert/strict';
import {plainTextParts} from '../src/lib/plain-text-links.ts';
const sample='First https://example.com/path.\nSecond (http://example.org/a_(b)), then HTTPS://example.net?q=1&x=2!';
const parts=plainTextParts(sample);assert.equal(parts.map(p=>p.text).join(''),sample);assert.deepEqual(parts.filter(p=>p.href).map(p=>p.href),['https://example.com/path','http://example.org/a_(b)','HTTPS://example.net?q=1&x=2']);
for(const bad of ['javascript:alert(1)','data:text/html,<script>alert(1)</script>','vbscript:msgbox(1)','javascript:https://example.com','xhttps://example.com','https://bad\\@example.com'])assert.equal(plainTextParts(bad).filter(p=>p.href).length,0,bad);
const html='<img src=x onerror=alert(1)>\nhttps://example.com';assert.equal(plainTextParts(html).map(p=>p.text).join(''),html);assert.equal(plainTextParts(html).filter(p=>p.href).length,1);
assert.deepEqual(plainTextParts('https://example.com/a[1]]').filter(p=>p.href).map(p=>p.href),['https://example.com/a[1]']);
console.log('PASS safe HTTP/HTTPS tokenization, punctuation, balanced delimiters, multiline text, malicious schemes, literal HTML and unchanged source text.');
