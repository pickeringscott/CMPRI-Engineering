import type { NotepadDocument, NotepadNote } from './notepad';
import type { NoteDocument } from './general-notes';
const escape = (v: string) => v.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const emptyDocument = (): NotepadDocument => ({ title:'Untitled',audience:{all:false,roles:[],people:[]},content:'',priority:'Normal',fontSize:16,fontFamily:'Comic Sans MS',titleFontFamily:'Comic Sans MS',ink:[],itemThreads:{},attachments:[] });
export function inlineLegacy(text: string, start: number, doc: Pick<NoteDocument,'mentions'|'textStyles'>) {
  const end = start + text.length;
  const mentions = (doc.mentions || []).filter(m => m.start >= start && m.end <= end && m.end > m.start).sort((a,b) => a.start-b.start);
  const points = [...new Set([start,end,...mentions.flatMap(m => [m.start,m.end]),...(doc.textStyles || []).flatMap(s => [Math.max(start,Math.min(end,s.start)),Math.max(start,Math.min(end,s.end))])])].sort((a,b) => a-b);
  let result = '';
  for (let i=0;i<points.length-1;i++) {
    const a=points[i],b=points[i+1],mention=mentions.find(m=>m.start<=a&&m.end>=b),style=(doc.textStyles || []).find(s=>s.start<=a&&s.end>=b);
    let part=escape(text.slice(a-start,b-start));
    if(style) { const css=[style.fontSize?'font-size:'+style.fontSize+'px':'',style.color&&style.color!=='text'?'color:'+escape(style.color):''].filter(Boolean).join(';'); if(css)part='<span style="'+css+'">'+part+'</span>'; }
    if(mention)part='<span class="mention" contenteditable="false" data-mention-id="'+escape(mention.id)+'" data-mention-kind="'+escape(mention.kind)+'">'+part+'</span>';
    result+=part;
  }
  return result || '<br>';
}
/** Legacy text/ink is projected once into the approved editor representation; source JSON remains untouched. */
export function legacyGeneralNote(id: string, authorId: string, doc: NoteDocument, at: string): NotepadNote {
  let offset=0;
  const content=doc.text.split('\n').map((line,index)=>{
    const item='legacy-'+id+'-'+index,match=/^([ \t]*)([☐☑•]) /.exec(line),level=match?Math.min(3,Math.floor(match[1].replace(/\t/g,'    ').length/4)+1):1;
    const textStart=offset+(match?.[0].length || 0),html=inlineLegacy(line.slice(match?.[0].length || 0),textStart,doc);offset+=line.length+1;
    if(match&&match[2]!=='•')return '<div class="note-check" contenteditable="false" data-item-id="'+item+'" data-task-id="'+item+'" data-list-level="'+level+'"><input type="checkbox"'+(match[2]==='☑'?' checked="checked"':'')+'><span class="task-label" contenteditable="true" role="textbox" spellcheck="true">'+html+'</span></div>';
    return '<p data-item-id="'+item+'" data-list-level="'+level+'">'+(match?'• ':'')+html+'</p>';
  }).join('');
  return {...emptyDocument(),id,title:doc.title,authorId,createdAt:at,updatedAt:at,revision:0,legacySource:'general',content,fontSize:doc.fontSize,ink:doc.strokes};
}
