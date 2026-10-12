"""Only exception names/messages, stack frames and route statuses; no raw app logs."""
import json,re,os
from pathlib import Path
from diagnostics import sanitize,local_secrets
OUT=Path(__file__).resolve().parents[2]/'.sandbox'

def extract(lines,secrets=()):
    errors=[];requests=[];navigation=[];compilation=[];frames=0
    for line in lines:
        line=re.sub(r'\x1b\[[0-9;]*m','',line).strip()
        route=re.search(r'\b(GET|POST|PATCH|DELETE|PUT) (/api/[^\s?]*)[^\s]* (\d{3})\b',line)
        if route:requests.append({'method':route[1],'route':route[2],'status':int(route[3])})
        nav=re.search(r'\b(GET|POST) (/(?:engineering|technician|work-orders)?)(?:\?[^\s]*)? (\d{3})\b',line)
        if nav:navigation.append({'method':nav[1],'route':nav[2],'status':int(nav[3])})
        compiling=re.search(r'Compiling (/(?:engineering|technician|work-orders)?)(?:\s|$)',line)
        if compiling:compilation.append({'route':compiling[1],'event':'compiling'})
        if re.search(r'heap out of memory|FATAL ERROR|SIGKILL|out of memory',line,re.I):errors.append('[runtime memory/process failure observed]')
        is_error=bool(re.search(r'(?:\b\w*Error:|Module not found|Module build failed|unhandledRejection|uncaughtException)',line))
        is_frame=frames>0 and line.startswith('at ')
        if is_error or is_frame:
            if re.search(r'authorization|cookie|password|api[_-]?key|access[_-]?token|refresh[_-]?token|service[_-]?role',line,re.I):
                errors.append('[sensitive diagnostic line omitted]')
            else: errors.append(sanitize(line,secrets)[:1500])
            frames=8 if is_error else frames-1
        elif line: frames=0
    return {'exceptions':errors[-35:],'apiRequests':requests[-25:],'navigationRequests':navigation[-25:],'compilation':compilation[-15:]}

if __name__=='__main__':
    log=OUT/'app.log'
    result={'phase':os.environ.get('CMPRI_SANDBOX_PHASE','unknown'),**extract(log.read_text(errors='replace').splitlines() if log.exists() else [],local_secrets(OUT))}
    (OUT/'server-diagnostics.json').write_text(json.dumps(result,indent=2))
    print(json.dumps({'phase':'sanitized server diagnostics',**result}),flush=True)
    if os.environ.get('CMPRI_SANDBOX_EXIT')!='0' and not (OUT/'summary.json').exists():
        summary={'passed':False,'stoppedAt':result['phase'],'exitCode':os.environ.get('CMPRI_SANDBOX_EXIT'),'dependentMatrixStopped':True}
        (OUT/'summary.json').write_text(json.dumps(summary,indent=2))
