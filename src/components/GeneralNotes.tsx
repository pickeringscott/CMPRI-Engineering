"use client";
import {useEffect,useRef,useState,type FormEvent,type ReactNode} from 'react';
import GeneralNotesInk from './GeneralNotesInk';
import {applyNoteTextEdit,noteInputEdit,noteLine,noteListInfo,noteStorageKey,noteToggleList,parseGeneralNotes,saveGeneralNote,NOTE_FONT_SIZES,type GeneralNote,type InkStroke,type NoteScope,type TextEdit} from '@/lib/general-notes';
import {sitePalette,paletteToken} from '@/lib/ui/site-palette-defaults';
import '@/app/notes/notes.css';
const colors=[{name:'Text',value:'var(--cmpri-modal-text)'},...sitePalette.accents.map(accent=>({name:accent.name,value:`rgb(${paletteToken(accent.name+'-rgb',accent.rgb)})`}))];
const paths:Record<string,ReactNode>={
 text:<><rect x="2" y="5" width="20" height="14" rx="3"/><path d="M5 9h1m3 0h1m3 0h1m3 0h1M5 12h1m3 0h1m3 0h1m3 0h1M7 16h10"/></>,
 pen:<path d="m4 16 11-11 4 4L8 20l-5 1zM13 7l4 4M4 16l4 4"/>,
 eraser:<path d="m4 12 9-9 8 8-9 10H8l-6-6zM8 8l8 8M12 21h9"/>,
 check:<><rect x="3" y="3" width="18" height="18" rx="4"/><path d="m7 12 3 3 7-7"/></>,
 bullet:<><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/><path d="M9 6h12M9 12h12M9 18h12"/></>,
 done:<path d="m5 12 4 4L20 5"/>,
 undo:<path d="M9 5 3 11l6 6M3 11h11a6 6 0 0 1 6 6"/>,
 redo:<path d="m15 5 6 6-6 6M21 11H10a6 6 0 0 0-6 6"/>,
 download:<path d="M12 3v13m-5-5 5 5 5-5M4 16v5h16v-5"/>,
 trash:<path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/>,
};
function Icon({name}:{name:string}){return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>}
function Tool({name,label,onClick,pressed,disabled,preserveFocus}:{name:string;label:string;onClick:()=>void;pressed?:boolean;disabled?:boolean;preserveFocus:boolean}){return <button type="button" title={label} aria-label={label} aria-pressed={pressed} disabled={disabled} onPointerDown={event=>{if(preserveFocus)event.preventDefault()}} onClick={onClick}><Icon name={name}/></button>}
export default function GeneralNotes({scope,authorize}:{scope:NoteScope;authorize:()=>Promise<void>}){
 const [notes,setNotes]=useState<GeneralNote[]>([]),[current,setCurrent]=useState<string|null>(null),[revision,setRevision]=useState<number|null>(null);
 const [title,setTitle]=useState(''),[text,setText]=useState(''),[fontSize,setFontSize]=useState(16),[strokes,setStrokes]=useState<InkStroke[]>([]);
 const [mode,setMode]=useState<'text'|'pen'|'eraser'>('text'),[inkColor,setInkColor]=useState(colors[0].value),[width,setWidth]=useState(4);
 const [history,setHistory]=useState<InkStroke[][]>([]),[future,setFuture]=useState<InkStroke[][]>([]),[dirty,setDirty]=useState(false),[message,setMessage]=useState('Loading notebook…'),[ready,setReady]=useState(false),[saving,setSaving]=useState(false),[query,setQuery]=useState(''),[caret,setCaret]=useState(0);
 const textarea=useRef<HTMLTextAreaElement>(null),titleInput=useRef<HTMLInputElement>(null),scroller=useRef<HTMLDivElement>(null),pendingInput=useRef<{value:string;edit:TextEdit}|null>(null);
 const key=noteStorageKey(scope),dirtyRef=useRef(dirty);useEffect(()=>{dirtyRef.current=dirty},[dirty]);
 useEffect(()=>{
  let live=true;
  Promise.resolve().then(()=>{try{const data=parseGeneralNotes(localStorage.getItem(key));if(live){setNotes(data);setReady(true);setMessage('Notes save on this device only.')}}catch(error){if(live)setMessage(error instanceof Error?error.message:'Notebook could not be loaded.')}});
  const sync=(event:StorageEvent)=>{if(event.key!==key)return;try{setNotes(parseGeneralNotes(event.newValue));setMessage('Saved notebook changed in another window. Unsaved edits are retained.')}catch{setMessage('Saved notebook could not be refreshed. Your draft is retained.')}};
  const beforeUnload=(event:BeforeUnloadEvent)=>{if(dirtyRef.current){event.preventDefault();event.returnValue=''}};
  const cancel=(event:Event)=>{if(dirtyRef.current&&!confirm('Discard your unsaved note? Cancel to return and save or download it.'))event.preventDefault()};
  window.addEventListener('storage',sync);window.addEventListener('beforeunload',beforeUnload);document.addEventListener('cmpri-modal-cancel-request',cancel);
  return()=>{live=false;window.removeEventListener('storage',sync);window.removeEventListener('beforeunload',beforeUnload);document.removeEventListener('cmpri-modal-cancel-request',cancel)};
 },[key]);
 function mark(){setDirty(true);dirtyRef.current=true;setMessage('Unsaved changes')}
 function keyboard(){const field=textarea.current;if(!field)return;field.focus({preventScroll:true});try{(navigator as Navigator&{virtualKeyboard?:{show:()=>void}}).virtualKeyboard?.show()}catch{}}
 function chooseMode(next:typeof mode,focus=true){setMode(next);if(next==='text'&&focus)keyboard();else if(next!=='text'){const field=document.activeElement;if(field instanceof HTMLElement)field.blur()}}
 function load(note:GeneralNote|null){if(saving)return;if(dirtyRef.current&&!confirm('Discard unsaved changes? Cancel to return and save.'))return;
  setCurrent(note?.id||null);setRevision(note?.revision||null);setTitle(note?.title||'');setText(note?.text||'');setFontSize(note?.fontSize||16);setStrokes(structuredClone(note?.strokes||[]));setHistory([]);setFuture([]);setDirty(false);dirtyRef.current=false;setCaret(0);setMode('text');setMessage(note?'Saved on this device':'New note');if(scroller.current)scroller.current.scrollTop=0;if(!note)titleInput.current?.focus();
 }
 function changeInk(next:InkStroke[]){setHistory(prior=>[...prior,strokes]);setFuture([]);setStrokes(next);mark()}
 async function save(){if(!ready||saving)return;if(!title.trim()){setMessage('Add a title before saving.');titleInput.current?.focus();return}setSaving(true);
  try{await authorize();const note:GeneralNote={id:current||crypto.randomUUID(),title:title.trim(),text,fontSize,strokes:structuredClone(strokes),revision:revision||1,updated:Date.now()},next=saveGeneralNote(localStorage,scope,note,revision),saved=next.find(item=>item.id===note.id)!;setNotes(next);setCurrent(saved.id);setRevision(saved.revision);setDirty(false);dirtyRef.current=false;setMessage('Saved on this device')}
  catch(error){setMessage(error instanceof Error?error.message:'Could not save. Download your draft before closing.')}
  finally{setSaving(false)}
 }
 async function remove(){if(!current||saving||!confirm('Delete this saved note from this device?'))return;setSaving(true);
  try{await authorize();const saved=parseGeneralNotes(localStorage.getItem(key));if(saved.find(note=>note.id===current)?.revision!==revision)throw Error('This note changed in another window. Reopen it before deleting.');const next=saved.filter(note=>note.id!==current);localStorage.setItem(key,JSON.stringify(next));setNotes(next);setCurrent(null);setRevision(null);setTitle('');setText('');setStrokes([]);setHistory([]);setFuture([]);setDirty(false);dirtyRef.current=false;setMessage('Deleted note')}
  catch(error){setMessage(error instanceof Error?error.message:'Could not delete note.')}
  finally{setSaving(false)}
 }
 function download(){const payload={format:'CMPRI general notes',version:1,notes,draft:dirty?{title,text,fontSize,strokes}:null};const url=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'})),anchor=document.createElement('a');anchor.href=url;anchor.download='cmpri-notes-'+new Date().toISOString().slice(0,10)+'.json';anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
 function editText(edit:TextEdit,source=textarea.current?.value||text){const changed=applyNoteTextEdit(source,edit);setText(changed.value);setCaret(changed.caret);if(textarea.current){textarea.current.value=changed.value;textarea.current.setSelectionRange(changed.caret,changed.caret)}mark()}
 function list(kind:'check'|'bullet'){const field=textarea.current;if(!field)return;const edit=noteToggleList(field.value,field.selectionStart,field.selectionEnd,kind);editText(edit);keyboard()}
 function check(){const field=textarea.current;if(!field)return;const line=noteLine(field.value,field.selectionStart),info=noteListInfo(line.text);if(!info||info.marker==='•')return;const at=line.start+info.indent.length;editText({start:at,end:at+1,insert:info.marker==='☐'?'☑':'☐',caret:field.selectionStart});keyboard()}
 function beforeInput(event:InputEvent){pendingInput.current=null;const field=textarea.current;if(!field||mode!=='text')return;const kind=event.inputType==='deleteContentBackward'?'backspace':['insertLineBreak','insertParagraph'].includes(event.inputType)||(event.inputType==='insertText'&&event.data==='\n')?'return':null;if(!kind)return;const edit=noteInputEdit(field.value,field.selectionStart,field.selectionEnd,kind);if(!edit)return;if(event.cancelable){event.preventDefault();editText(edit,field.value)}else pendingInput.current={value:field.value,edit}}
 // Native beforeinput is required for Android keyboards which omit Enter/Backspace keydown.
 const beforeRef=useRef(beforeInput);useEffect(()=>{beforeRef.current=beforeInput});
 useEffect(()=>{const field=textarea.current;if(!field)return;const listener=(event:Event)=>beforeRef.current(event as InputEvent);field.addEventListener('beforeinput',listener);return()=>field.removeEventListener('beforeinput',listener)},[]);
 function changedText(event:FormEvent<HTMLTextAreaElement>){if(pendingInput.current){const pending=pendingInput.current;pendingInput.current=null;editText(pending.edit,pending.value);return}setText(event.currentTarget.value);setCaret(event.currentTarget.selectionStart);mark()}
 const listState=noteListInfo(noteLine(text,caret).text),sorted=[...notes].sort((a,b)=>b.updated-a.updated),filtered=sorted.filter(note=>(note.title+' '+note.text).toLocaleLowerCase().includes(query.toLocaleLowerCase()));
 return <section className="general-notes" aria-label="General notebook">
  <aside className="general-notes-library" aria-label="Saved general notes"><button type="button" onClick={()=>load(null)} disabled={!ready||saving}>＋ New note</button><input type="search" aria-label="Search saved notes" placeholder="Search notes" value={query} onChange={event=>setQuery(event.target.value)}/><div className="general-notes-list">{filtered.map(note=><button key={note.id} type="button" aria-current={current===note.id?'true':undefined} disabled={saving} onClick={()=>load(note)}><strong>{note.title}</strong><small>{new Date(note.updated).toLocaleString()}{note.strokes.length?' · Ink':''}</small></button>)}{ready&&!notes.length&&<p>Your saved notes will appear here.</p>}{ready&&notes.length>0&&!filtered.length&&<p>No matching notes.</p>}</div><p>Saved on this device, for your CMPRI account and property. Download a backup before clearing browser data.</p></aside>
  <div className="general-notes-editor"><div className="general-notes-top"><div className="general-notes-mobile-library"><select aria-label="Open saved note" value={current||''} disabled={!ready||saving} onChange={event=>load(notes.find(note=>note.id===event.target.value)||null)}><option value="">New note</option>{sorted.map(note=><option key={note.id} value={note.id}>{note.title}</option>)}</select><button type="button" aria-label="Create another note" onClick={()=>load(null)} disabled={!ready||saving}>＋</button></div><label htmlFor="general-note-title">Title</label><input ref={titleInput} id="general-note-title" placeholder="Note title" maxLength={120} value={title} disabled={!ready||saving} onChange={event=>{setTitle(event.target.value);mark()}}/><div className="general-notes-save"><span role="status" aria-live="polite">{message}</span><button type="button" onClick={()=>void save()} disabled={!ready||saving}>{saving?'Saving…':'Save note'}</button></div></div>
   <div className="general-notes-scroll" ref={scroller}><div className={'general-notes-paper '+(mode==='text'?'is-text':'')}>
    <textarea ref={textarea} aria-label="Note text" inputMode="text" spellCheck value={text} disabled={!ready||saving} tabIndex={mode==='text'?0:-1} style={{fontSize}} onChange={changedText} onSelect={event=>setCaret(event.currentTarget.selectionStart)} onClick={()=>{if(mode==='text')keyboard()}} onKeyDown={event=>{if(event.nativeEvent.isComposing)return;if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)){event.preventDefault();check();return}if(event.key==='Enter'&&event.shiftKey)return;const kind=event.key==='Enter'?'return':event.key==='Backspace'&&!event.ctrlKey&&!event.metaKey?'backspace':null;if(!kind)return;const field=event.currentTarget,edit=noteInputEdit(field.value,field.selectionStart,field.selectionEnd,kind);if(edit){event.preventDefault();editText(edit,field.value)}}}/>
    <GeneralNotesInk strokes={strokes} mode={!ready||saving?'text':mode} color={inkColor} width={width} scroller={scroller} onChange={changeInk} onType={()=>chooseMode('text')}/>
    {!text&&!strokes.length&&<span className="general-notes-hint">Type, or select the pen to write…</span>}
   </div></div>
   <div className="general-notes-tools" role="toolbar" aria-label="Note controls">
    <Tool name="text" label="Text and keyboard handwriting" onClick={()=>chooseMode('text')} pressed={mode==='text'} disabled={!ready||saving} preserveFocus={mode==='text'}/><Tool name="pen" label="Handwritten ink" onClick={()=>chooseMode('pen')} pressed={mode==='pen'} disabled={!ready||saving} preserveFocus={mode==='text'}/><Tool name="eraser" label="Erase ink stroke" onClick={()=>chooseMode('eraser')} pressed={mode==='eraser'} disabled={!ready||saving} preserveFocus={mode==='text'}/>
    {mode==='text'?<><Tool name="check" label="Checklist" onClick={()=>list('check')} pressed={!!listState&&listState.marker!=='•'} disabled={!ready||saving} preserveFocus/><Tool name="bullet" label="Bullet list" onClick={()=>list('bullet')} pressed={listState?.marker==='•'} disabled={!ready||saving} preserveFocus/><Tool name="done" label="Check or uncheck item" onClick={check} disabled={!ready||saving||!listState||listState.marker==='•'} preserveFocus/><select aria-label="Text size" value={fontSize} disabled={!ready||saving} onChange={event=>{setFontSize(+event.target.value);mark()}}>{NOTE_FONT_SIZES.map(size=><option key={size} value={size}>{size}</option>)}</select></>:<><select aria-label="Ink color" value={inkColor} disabled={!ready||saving} onChange={event=>setInkColor(event.target.value)}>{colors.map(color=><option value={color.value} key={color.name}>{color.name}</option>)}</select><input type="range" aria-label="Pen width" min="1" max="12" step="1" value={width} onChange={event=>setWidth(+event.target.value)} disabled={!ready||saving}/></>}
    <Tool name="undo" label="Undo ink" onClick={()=>{if(!history.length)return;setFuture(prior=>[...prior,strokes]);setStrokes(history.at(-1)!);setHistory(prior=>prior.slice(0,-1));mark()}} disabled={!ready||saving||!history.length} preserveFocus={mode==='text'}/><Tool name="redo" label="Redo ink" onClick={()=>{if(!future.length)return;setHistory(prior=>[...prior,strokes]);setStrokes(future.at(-1)!);setFuture(prior=>prior.slice(0,-1));mark()}} disabled={!ready||saving||!future.length} preserveFocus={mode==='text'}/><Tool name="download" label="Download notes and draft" onClick={download} disabled={!ready||saving} preserveFocus={mode==='text'}/><Tool name="trash" label="Delete saved note" onClick={()=>void remove()} disabled={!ready||saving||!current} preserveFocus={mode==='text'}/>
   </div><p className="general-notes-help">Finger tap: keyboard · Finger swipe: scroll · Pen icon: ink · Text mode keeps Gboard handwriting active</p>
  </div>
 </section>;
}
