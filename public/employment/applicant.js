(()=>{
const $=id=>document.getElementById(id), form=$('application'), input=$('resumeFile');
let file=null, busy=false; let submissionId=crypto.randomUUID();
const error=document.createElement('p'); error.setAttribute('role','alert'); error.style.margin='0'; form.after(error);
function clear(){file=null;input.value='';$('resumeName').textContent='';$('resumeName').removeAttribute('title');$('resumeSelection').hidden=true;error.textContent='';}
function attach(candidate){
 if(!candidate)return;
 if(!/\.pdf$/i.test(candidate.name)||(candidate.type&&candidate.type!=='application/pdf')||!candidate.size||candidate.size>3*1024*1024){clear();error.textContent='Choose a PDF up to 3 MB.';return;}
 file=candidate;$('resumeName').textContent=file.name;$('resumeName').title=file.name;$('resumeSelection').hidden=false;error.textContent='';
}
$('addResume').onclick=()=>input.click(); input.onchange=()=>attach(input.files[0]);
$('removeResume').onclick=()=>{clear();$('addResume').focus();}; form.addEventListener('reset',()=>{clear();submissionId=crypto.randomUUID();});
document.addEventListener('dragover',e=>{if([...e.dataTransfer.types].includes('Files')){e.preventDefault();e.dataTransfer.dropEffect='copy';$('resumeDrop').classList.add('dragging');}});
document.addEventListener('dragleave',e=>{if(!e.relatedTarget)$('resumeDrop').classList.remove('dragging');});
document.addEventListener('drop',e=>{e.preventDefault();$('resumeDrop').classList.remove('dragging');if(e.dataTransfer.files.length!==1){error.textContent='Drop one PDF.';return;}attach(e.dataTransfer.files[0]);});
form.addEventListener('submit',async e=>{
 e.preventDefault();if(busy||!form.reportValidity())return;
 const interview={}; for(const day of document.querySelectorAll('#interviewDays .day-toggle:checked')){interview[day.value]=[...document.querySelectorAll('#interviewDays input:checked')].filter(x=>x.name==='Interview '+day.value).map(x=>x.value);}
 const answers={department:$('role').value,name:$('name').value,email:$('email').value,phone:$('phone').value,history:$('history').value,example:$('example').value,skills:Object.fromEntries([...document.querySelectorAll('#skills select')].map(x=>[x.id,x.value])),workingDays:[...document.querySelectorAll('#days input:checked')].map(x=>x.value),interview};
 const body=new FormData();body.append('answers',JSON.stringify(answers));body.append('submissionId',submissionId);if(file)body.append('resume',file,file.name);
 const button=form.querySelector('[type=submit]');busy=true;button.disabled=true;
 try{const response=await fetch('/api/employment',{method:'POST',body});const result=await response.json();if(!response.ok)throw Error(result.error);let status=$('submissionStatus');if(!status){status=document.createElement('p');status.id='submissionStatus';status.setAttribute('role','status');form.after(status);}status.textContent='Application received for '+(answers.department==='front'?'Front Desk':'Maintenance')+'. Reference: '+result.id;status.tabIndex=-1;status.focus();}
 catch(e){error.textContent=e.message||'Unable to submit application. Please retry.';}
 finally{busy=false;button.disabled=false;}
});
})();
