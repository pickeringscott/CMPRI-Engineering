// Local-only browser -> actual API handlers -> isolated PostgreSQL -> mocked push provider.
import {spawn} from 'node:child_process';
import {once} from 'node:events';
const url='http://127.0.0.1:3127/fixture/state';
let running=false;try{running=(await fetch(url,{signal:AbortSignal.timeout(500)})).ok}catch{}
if(running)throw Error('Port 3127 already serves a fixture. Stop it before starting the isolated Staff Notes verification.');
const backend=spawn(process.execPath,['--import','./tests/helpers/resolve-ts.mjs','--experimental-strip-types','tests/browser/staff_notes_backend.mjs'],{stdio:['ignore','pipe','inherit']});
let ready=false;backend.stdout.on('data',data=>{if(data.toString().includes('"ready":true'))ready=true});
try{
 for(let i=0;i<150&&!ready;i++){if(backend.exitCode!==null)throw Error('The isolated Staff Notes backend failed.');await new Promise(resolve=>setTimeout(resolve,100))}
 if(!ready)throw Error('The isolated Staff Notes backend did not become ready.');
 const browser=spawn('python',['tests/browser/staff_notes_mentions.py'],{stdio:'inherit',env:process.env});
 const [code,signal]=await once(browser,'exit');process.exitCode=signal?1:(code??1);
}finally{
 if(backend.exitCode===null&&backend.signalCode===null){backend.kill('SIGTERM');await once(backend,'exit');}
}
