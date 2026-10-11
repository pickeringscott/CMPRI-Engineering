const https=require('node:https');
const allowed=new Set(['localhost','127.0.0.1','::1']);
const fetchOriginal=globalThis.fetch;
globalThis.fetch=(input,init)=>{const u=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(!allowed.has(u.hostname))throw Error('QA blocked external fetch: '+u.hostname);return fetchOriginal(input,init);};
const original=https.request;
https.request=function(input,...args){let hostname=typeof input==='string'||input instanceof URL?new URL(input).hostname:input.hostname||input.host;if(!allowed.has(hostname))throw Error('QA blocked external HTTPS: '+hostname);return original.call(this,input,...args);};
