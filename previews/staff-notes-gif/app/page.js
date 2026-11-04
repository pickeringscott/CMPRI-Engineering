'use client';
import {useEffect,useRef,useState} from 'react';
import {mergeResults} from '../lib/cards.mjs';

function Icon({name}) {
  const paths={image:<><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1"/><path d="m3 17 6-6 4 4 3-3 5 5"/></>,film:<><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/></>,clip:<path d="m8 12 7-7a4 4 0 0 1 6 6L11 21a6 6 0 0 1-8-8L13 3m-7 12 9-9a2 2 0 0 1 3 3l-9 9"/>,send:<><path d="m3 11 18-8-8 18-2-8-8-2Z"/><path d="m11 13 10-10"/></>};
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}
function LinkCard({card}) {
  return <a className="link-card" href={card.canonicalUrl} target="_blank" rel="noopener noreferrer" data-kind="external-link">
    {/* Provider URLs are kept intact, never fetched into local blobs. */}
    <img src={card.previewUrl} alt={card.title} loading="lazy" width={card.width} height={card.height}/>
    <span><strong>{card.title}</strong><small>View on {card.attribution} ↗</small></span>
  </a>;
}
function LocalCard({file}) {
  return <div className="local-card">{file.type.startsWith('image/') ? <img src={file.url} alt={file.name}/> : file.type.startsWith('video/') ? <video controls playsInline src={file.url}/> : <Icon name="clip"/>}<span>{file.name}<small>Local preview · {(file.size/1024/1024).toFixed(1)} MB</small></span></div>;
}
export default function Preview() {
  const [open,setOpen]=useState(true),[menu,setMenu]=useState(false),[gif,setGif]=useState(false);
  const [query,setQuery]=useState(''),[busy,setBusy]=useState(false),[results,setResults]=useState([]),[providerErrors,setProviderErrors]=useState([]);
  const [body,setBody]=useState(''),[attachments,setAttachments]=useState([]),[local,setLocal]=useState([]),[error,setError]=useState('');
  const [notes,setNotes]=useState([
    {id:'a',name:'Alex',time:'9:12 AM',body:'Morning team — the supply delivery is ready in the back office.'},
    {id:'b',name:'Jordan',time:'9:15 AM',body:'Thanks! I’ll pick it up after the morning walk-through.'},
    {id:'c',name:'Front Desk · Sam',time:'9:18 AM',body:'Please leave a note here when it’s been collected. 🙂'}
  ]);
  const fileInput=useRef(null),mediaButton=useRef(null),searchInput=useRef(null),commentInput=useRef(null),dialog=useRef(null),menuRef=useRef(null);
  const controller=useRef(null),sequence=useRef(0),urls=useRef(new Set());
  useEffect(()=>()=>{controller.current?.abort();urls.current.forEach(url=>URL.revokeObjectURL(url));},[]);
  useEffect(()=>{
    if (!menu) return;
    const outside=event=>{if(!menuRef.current?.contains(event.target)&&!mediaButton.current?.contains(event.target))setMenu(false);};
    document.addEventListener('pointerdown',outside);return()=>document.removeEventListener('pointerdown',outside);
  },[menu]);
  useEffect(()=>{if(gif)searchInput.current?.focus();},[gif]);
  useEffect(()=>{if(open)dialog.current?.focus();},[open]);
  const stopSearch=()=>{sequence.current++;controller.current?.abort();setBusy(false);};
  function closePicker(){stopSearch();setGif(false);mediaButton.current?.focus();}
  function keyboard(event){
    if(event.key==='Escape'){event.preventDefault();if(gif)closePicker();else if(menu){setMenu(false);mediaButton.current?.focus();}else setOpen(false);}
    if(event.key==='Tab'){
      const controls=[...dialog.current.querySelectorAll('button:not(:disabled),a[href],input:not([hidden]),textarea,[tabindex="0"]')].filter(el=>el.offsetParent!==null);
      if(!controls.length)return;
      const first=controls[0],last=controls.at(-1);
      if(event.shiftKey&&(document.activeElement===first||document.activeElement===dialog.current)){event.preventDefault();last.focus();}
      if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
    }
  }
  async function search(event){
    event?.preventDefault();
    if(!query.trim())return;
    controller.current?.abort();controller.current=new AbortController();
    const current=++sequence.current,signal=controller.current.signal;
    setBusy(true);setResults([]);setProviderErrors([]);
    const responses=await Promise.all(['giphy','tenor'].map(async provider=>{
      try{
        const response=await fetch(`/api/gifs/${provider}?q=${encodeURIComponent(query)}`,{signal,cache:'no-store'});
        const data=await response.json();
        if(!response.ok)return {...data,provider,items:[],message:data.message||`${provider} is unavailable.`};
        return {...data,provider};
      }catch{return {provider,items:[],message:`${provider==='giphy'?'GIPHY':'Tenor'} could not be reached. Try again.`};}
    }));
    if(current!==sequence.current||signal.aborted)return;
    setResults(mergeResults(responses));setProviderErrors(responses.filter(r=>r.message));setBusy(false);
  }
  function select(card){setAttachments(prev=>[...prev.filter(p=>p.canonicalUrl!==card.canonicalUrl),card]);closePicker();commentInput.current?.focus();}
  function chooseFiles(files){
    const accepted=[];let rejected=false;
    for(const file of files){if(file.size>100*1024*1024){rejected=true;continue;}const url=URL.createObjectURL(file);urls.current.add(url);accepted.push({name:file.name,type:file.type,size:file.size,url});}
    setLocal(prev=>[...prev,...accepted]);setError(rejected?'Files over 100 MB were skipped.':'');setMenu(false);
  }
  function removeLocal(index){setLocal(prev=>{const file=prev[index];URL.revokeObjectURL(file.url);urls.current.delete(file.url);return prev.filter((_,i)=>i!==index);});}
  function post(event){event.preventDefault();if(!body.trim()&&!attachments.length&&!local.length)return;
    setNotes(prev=>[...prev,{id:crypto.randomUUID(),name:'You · preview',time:new Date().toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}),body,attachments,local}]);
    setBody('');setAttachments([]);setLocal([]);setError('');setMenu(false);commentInput.current?.focus();
  }
  return <main>
    <div className="brand"><span className="brand-mark">C</span><div><strong>CMPRI</strong><small>ENGINEERING</small></div></div>
    <div className="page-intro"><p>STAFF COMMUNICATION</p><h1>A place for the little things.</h1><span>Staff Notes · isolated interaction preview</span><button className="open-button" onClick={()=>setOpen(true)}>Open Staff Notes</button></div>
    {open&&<div className="backdrop"><section role="dialog" aria-modal="true" aria-labelledby="modal-title" tabIndex={-1} ref={dialog} onKeyDown={keyboard} className="modal">
      <header><div><div className="eyebrow">CMPRI</div><h2 id="modal-title">Staff Notes</h2></div><button className="close" aria-label="Close Staff Notes" onClick={()=>{stopSearch();setOpen(false);setGif(false);setMenu(false);}}>×</button></header>
      <div className="preview-label"><span/>Mock notes · posts and files stay in this page only</div>
      <div className="notes" aria-label="Staff notes"><div className="day"><span/>TODAY<span/></div>{notes.map(note=><article className="note" key={note.id}><div className="note-heading"><strong>{note.name}</strong><time>{note.time}</time></div><p>{note.body}</p>{note.attachments?.map(card=><LinkCard key={card.canonicalUrl} card={card}/>)}{note.local?.map(file=><LocalCard key={file.url} file={file}/>)}</article>)}</div>
      <form className="composer" onSubmit={post}>
        {(attachments.length>0||local.length>0)&&<div className="draft-attachments">{attachments.map((card,index)=><div className="removable" key={card.canonicalUrl}><LinkCard card={card}/><button type="button" aria-label={`Remove ${card.title}`} onClick={()=>setAttachments(prev=>prev.filter((_,i)=>i!==index))}>×</button></div>)}{local.map((file,index)=><div className="removable" key={file.url}><LocalCard file={file}/><button type="button" aria-label={`Remove ${file.name}`} onClick={()=>removeLocal(index)}>×</button></div>)}</div>}
        <textarea ref={commentInput} aria-label="Write a comment" placeholder="Write a comment…" value={body} maxLength={4000} onChange={e=>setBody(e.target.value)} onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();chooseFiles(e.dataTransfer.files);}}/>
        <div className="composer-bottom"><span className="hint">Emoji welcome. Keep everyone in the loop.</span><div className="action-anchor">
          <div className="split-action"><button type="button" className="media-button" aria-label="Add GIF or media" aria-expanded={menu} aria-controls="media-menu" ref={mediaButton} onClick={()=>{setGif(false);stopSearch();setMenu(v=>!v);}} onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();chooseFiles(e.dataTransfer.files);}}><Icon name="image"/><Icon name="film"/><Icon name="clip"/></button><button type="submit" className="post" disabled={!body.trim()&&!attachments.length&&!local.length}>Post <Icon name="send"/></button></div>
          {menu&&<div id="media-menu" ref={menuRef} className="media-menu" role="group" aria-label="Attachment options"><button type="button" onClick={()=>{setMenu(false);setGif(true);}}>GIF</button><button type="button" onClick={()=>{fileInput.current?.click();setMenu(false);}}>Media</button><i aria-hidden="true"/></div>}
        </div></div>
        <input ref={fileInput} type="file" multiple hidden aria-label="Choose local media" onChange={e=>{chooseFiles(e.target.files||[]);e.target.value='';}}/>
        {error&&<p role="alert" className="error">{error}</p>}
      </form>
      {gif&&<section className="gif-picker" aria-label="GIF search"><div className="picker-top"><strong>Find a GIF</strong><button className="close" aria-label="Close GIF search" onClick={closePicker}>×</button></div><form onSubmit={search} className="search-form"><input ref={searchInput} value={query} maxLength={50} onChange={e=>{setQuery(e.target.value);stopSearch();setResults([]);}} aria-label="Search GIFs" placeholder="Search GIPHY & Tenor…"/><button disabled={busy||!query.trim()}>{busy?'Searching…':'Search'}</button></form><div className="provider-labels"><span>GIPHY</span><span>Tenor</span></div><div className="results-scroll" aria-live="polite" aria-busy={busy}>{busy&&<p className="empty">Searching both providers…</p>}{providerErrors.map(item=><div className="provider-error" key={item.provider}><strong>{item.provider==='giphy'?'GIPHY':'Tenor'} unavailable</strong><p>{item.message}</p>{item.documentation&&<a href={item.documentation} target="_blank" rel="noopener noreferrer">Provider details ↗</a>}</div>)}{!busy&&!results.length&&!providerErrors.length&&<p className="empty">Search to check provider availability.<br/><small>Live search is not connected in this preview.</small></p>}<div className="masonry">{results.map(card=><button type="button" key={`${card.provider}:${card.id}`} aria-label={`Attach ${card.title} from ${card.attribution}`} onClick={()=>select(card)}><img src={card.previewUrl} alt={card.title} width={card.width} height={card.height} loading="lazy"/><span>{card.attribution}</span></button>)}</div></div><footer>Selected GIFs attach as attributed external links.</footer></section>}
    </section></div>}
  </main>;
}
