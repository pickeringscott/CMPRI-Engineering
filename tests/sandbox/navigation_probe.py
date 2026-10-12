"""Bounded RSC/asset evidence. Never retain payloads, headers, cookies or tokens."""
import hashlib,json,re

def rsc_summary(body):
    text=body.decode('utf-8',errors='replace')
    records=re.findall(r'^([0-9a-f]+):([A-Z]*)',text,re.M)
    root=None
    for line in text.splitlines():
        if line.startswith('0:'):
            try:root=json.loads(line[2:])
            except ValueError:pass
    build=root.get('b') if isinstance(root,dict) else None
    return {'bytes':len(body),'sha256':hashlib.sha256(body).hexdigest(),
        'recordCount':len(records),'rootRecordPresent':any(i=='0' for i,_ in records),
        'rootJsonObject':isinstance(root,dict),'moduleRecords':sum(t=='I' for _,t in records),
        'errorRecords':sum(t=='E' for _,t in records),'endsWithNewline':text.endswith('\n'),
        'buildId':build if isinstance(build,str) and re.fullmatch(r'[A-Za-z0-9_-]{1,100}',build) else None,
        'staticModules':sorted(set(re.findall(r'(?<![\w/])static/chunks/[\w/.-]+\.js',text)))[:60]}

RUNTIME_SNAPSHOT='''()=>{
 const path=u=>{try{return new URL(u,location.href).pathname}catch{return null}};
 const asset=u=>{const p=path(u);return p?.startsWith('/_next/static/')?p:null};
 let session=null;try{session=JSON.parse(sessionStorage.getItem('cmpri:auth:v1')||localStorage.getItem('cmpri:auth:v1')||'null')}catch{}
 return {
   nextRuntimePresent:!!window.next,appRouterHistory:history.state?.__NA===true,
   pendingRoute:window.next?.__pendingUrl?path(window.next.__pendingUrl):null,
   sessionExpiresInSeconds:typeof session?.expires_at==='number'?Math.round(session.expires_at-Date.now()/1000):null,
   rememberDevice:localStorage.getItem('cmpri:remember')==='true',
   sessionInTemporaryStorage:!!sessionStorage.getItem('cmpri:auth:v1'),
   sessionInPersistentStorage:!!localStorage.getItem('cmpri:auth:v1'),
   visibleCookieCount:document.cookie?document.cookie.split(';').length:0,
   scriptPaths:Array.from(document.scripts).map(e=>asset(e.src)).filter(Boolean).slice(-60),
   resources:performance.getEntriesByType('resource').filter(e=>asset(e.name)).slice(-80).map(e=>({path:asset(e.name),type:e.initiatorType,durationMs:Math.round(e.duration),transferSize:e.transferSize})),
   registeredChunkCount:Array.isArray(window.webpackChunk_N_E)?window.webpackChunk_N_E.length:null
 };
}'''
