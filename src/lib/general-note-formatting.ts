export type NoteTextStyle={start:number;end:number;color?:string;fontSize?:number};
export type NoteTextFormat=Pick<NoteTextStyle,'color'|'fontSize'>;
const sizes=[8,10,12,14,16,18,20,22,24];
export function validNoteColor(value:unknown):value is string{
 if(value==='text')return true;if(typeof value!=='string')return false;
 const rgb=value.match(/^rgb\((\d{1,3}), ?(\d{1,3}), ?(\d{1,3})\)$/);return !!rgb&&rgb.slice(1).every(n=>Number(n)<=255);
}
export function validNoteStyles(text:string,value:unknown):boolean{
 if(value===undefined)return true;if(!Array.isArray(value)||value.length>2000)return false;
 let end=0;for(const run of value){if(!run||Object.keys(run).some(k=>!['start','end','color','fontSize'].includes(k))||!Number.isSafeInteger(run.start)||!Number.isSafeInteger(run.end)||run.start<end||run.end<=run.start||run.end>text.length||(run.color===undefined&&run.fontSize===undefined)||(run.color!==undefined&&!validNoteColor(run.color))||(run.fontSize!==undefined&&!sizes.includes(run.fontSize)))return false;end=run.end}return true;
}
const same=(a:NoteTextFormat,b:NoteTextFormat)=>a.color===b.color&&a.fontSize===b.fontSize;
export function normalizeNoteStyles(runs:NoteTextStyle[]){const output:NoteTextStyle[]=[];for(const run of runs.filter(r=>r.end>r.start&&(r.color!==undefined||r.fontSize!==undefined)).sort((a,b)=>a.start-b.start)){const prior=output.at(-1);if(prior&&prior.end===run.start&&same(prior,run))prior.end=run.end;else output.push({...run})}return output}
export function noteStyleAt(runs:NoteTextStyle[],offset:number):NoteTextFormat{const run=runs.find(r=>r.start<=offset&&offset<r.end);return run?{...(run.color!==undefined?{color:run.color}:{}),...(run.fontSize!==undefined?{fontSize:run.fontSize}:{})}:{}}
/** Split at selection boundaries; changing size must preserve an existing color. */
export function formatNoteRange(runs:NoteTextStyle[],start:number,end:number,patch:NoteTextFormat){
 if(start>=end)return runs;const points=[...new Set([start,end,...runs.flatMap(r=>[r.start,r.end])])].sort((a,b)=>a-b),output:NoteTextStyle[]=[];
 for(let i=0;i<points.length-1;i++){const a=points[i],b=points[i+1],format=noteStyleAt(runs,a);output.push({start:a,end:b,...format,...(a>=start&&b<=end?patch:{})})}return normalizeNoteStyles(output);
}
/** Preserve surviving styled fragments around an edit, including partial deletes. */
export function rebaseNoteStyles(before:string,after:string,runs:NoteTextStyle[],typing?:NoteTextFormat){
 if(before===after)return runs;let start=0,suffix=0;while(start<before.length&&start<after.length&&before[start]===after[start])start++;while(suffix<before.length-start&&suffix<after.length-start&&before[before.length-1-suffix]===after[after.length-1-suffix])suffix++;
 const end=before.length-suffix,insertEnd=after.length-suffix,delta=after.length-before.length,output:NoteTextStyle[]=[];
 for(const run of runs){if(run.start<start)output.push({...run,end:Math.min(run.end,start)});if(run.end>end)output.push({...run,start:Math.max(run.start,end)+delta,end:run.end+delta})}
 if(insertEnd>start)output.push({start,end:insertEnd,...noteStyleAt(runs,start<end?start:Math.max(0,start-1)),...typing});return normalizeNoteStyles(output);
}
