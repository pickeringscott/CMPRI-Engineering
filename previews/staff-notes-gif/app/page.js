'use client';
import {useEffect,useRef,useState} from 'react';
import {searchGiphy,externalCard,giphyResult} from '../lib/cards.mjs';
const giphyKey=process.env.NEXT_PUBLIC_GIPHY_API_KEY || '';

function Icon({name}) {
  const paths={image:<><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1"/><path d="m3 17 6-6 4 4 3-3 5 5"/></>,film:<><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/></>,clip:<path d="m8 12 7-7a4 4 0 0 1 6 6L11 21a6 6 0 0 1-8-8L13 3m-7 12 9-9a2 2 0 0 1 3 3l-9 9"/>,send:<><path d="m3 11 18-8-8 18-2-8-8-2Z"/><path d="m11 13 10-10"/></>};
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}
function LinkCard({card}) {
  const [media,setMedia]=useState(card.previewUrl?card:null);
  useEffect(()=>{
    if(card.previewUrl||!giphyKey)return;
    const abort=new AbortController();
    const url=new URL(`https://api.giphy.com/v1/gifs/${encodeURIComponent(card.id)}`);url.searchParams.set('api_key',giphyKey);
    fetch(url,{signal:abort.signal,cache:'no-store',credentials:'omit'}).then(async r=>{if(!r.ok)throw Error('Unavailable');return r.json();}).then(value=>setMedia(giphyResult(value.data))).catch(()=>{});
    return()=>abort.abort();
  },[card.id,card.previewUrl]);
  return <a className="link-card" href={card.canonicalUrl} target="_blank" rel="noopener noreferrer" data-kind="external-link">
    {/* Provider URLs are kept intact, never fetched into local blobs. */}
    {media&&<img src={media.previewUrl} alt={card.title} loading="lazy" width={media.width} height={media.height}/>}
    <span><strong>{card.title}</strong><small>View on {card.attribution} ↗</small></span>
  </a>;
}
function LocalCard({file}) {
  return <div className="local-card">{file.type.startsWith('image/') ? <img src={file.url} alt={file.name}/> : file.type.startsWith('video/') ? <video controls playsInline src={file.url}/> : <Icon name="clip"/>}<span>{file.name}<small>{file.saved?'Uploaded':'Pending upload'} · {(file.size/1024/1024).toFixed(1)} MB</small></span></div>;
}
export default function Preview() {
  const [open,setOpen]=useState(true),[menu,setMenu]=useState(false),[gif,setGif]=useState(false);
  const [query,setQuery]=useState(''),[busy,setBusy]=useState(false),[results,setResults]=useState([]),[providerErrors,setProviderErrors]=useState([]);
  const [body,setBody]=useState(''),[attachments,setAttachments]=useState([]),[local,setLocal]=useState([]),[error,setError]=useState('');
  const [notes,setNotes]=useState([]),[storageReady,setStorageReady]=useState(false),[storageMessage,setStorageMessage]=useState('Checking isolated storage…'),[saving,setSaving]=useState(false),[hasMore,setHasMore]=useState(false);
  const posting=useRef(false),request=useRef(null);
  useEffect(()=>{let active=true;fetch('/api/notes',{cache:'no-store'}).then(async response=>{const value=await response.json();if(!response.ok)throw Error(value.error);if(active){setNotes(value.notes);setStorageReady(true);setStorageMessage('Isolated local storage · notes and uploads persist');}}).catch(e=>{if(active)setStorageMessage(e.message||'Storage is unavailable.');});return()=>{active=false;};},[]);
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
  async function search(event,more=false){
    event?.preventDefault();if(!query.trim())return;
    controller.current?.abort();controller.current=new AbortController();
    const current=++sequence.current,signal=controller.current.signal,offset=more?results.length:0;
    setBusy(true);if(!more)setResults([]);setProviderErrors([]);
    try{const value=await searchGiphy({key:giphyKey,query,offset,signal});if(current!==sequence.current||signal.aborted)return;setResults(prev=>more?[...prev,...value.items]:value.items);setHasMore(value.hasMore);}
    catch(e){if(current===sequence.current&&!signal.aborted)setProviderErrors([{provider:'giphy',message:e.message||'GIPHY could not be reached.'}]);}
    finally{if(current===sequence.current)setBusy(false);}
  }
  function select(card){setAttachments(prev=>[...prev.filter(p=>p.canonicalUrl!==card.canonicalUrl),card]);closePicker();commentInput.current?.focus();}
  function chooseFiles(files){
    if(posting.current)return;
    const accepted=[];let rejected=false;
    for(const file of files){if(file.size>100*1024*1024){rejected=true;continue;}const url=URL.createObjectURL(file);urls.current.add(url);accepted.push({file,name:file.name,type:file.type,size:file.size,url});}
    setLocal(prev=>[...prev,...accepted]);setError(rejected?'Files over 100 MB were skipped.':'');setMenu(false);
  }
  function removeLocal(index){setLocal(prev=>{const file=prev[index];URL.revokeObjectURL(file.url);urls.current.delete(file.url);return prev.filter((_,i)=>i!==index);});}
  async function post(event){
    event.preventDefault();if(posting.current||!storageReady||(!body.trim()&&!attachments.length&&!local.length))return;
    posting.current=true;setSaving(true);setError('');
    try{
      const uploaded=[];
      for(const file of local){
        if(file.saved){uploaded.push(file);continue;}
        const response=await fetch('/api/media',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-File-Name':encodeURIComponent(file.name)},body:file.file});
        const value=await response.json();if(!response.ok)throw Error(value.error||'Upload failed.');
        uploaded.push(value.media);
        setLocal(prev=>prev.map(p=>p.url===file.url?value.media:p));
        URL.revokeObjectURL(file.url);urls.current.delete(file.url);
      }
      const payload={body,attachments:attachments.map(externalCard),mediaIds:uploaded.map(f=>f.id)};
      const signature=JSON.stringify(payload);
      if(!request.current||request.current.signature!==signature)request.current={signature,id:crypto.randomUUID()};
      const response=await fetch('/api/notes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...payload,requestId:request.current.id})});
      const value=await response.json();if(!response.ok)throw Error(value.error||'Save could not be confirmed.');
      setNotes(prev=>[...prev.filter(n=>n.id!==value.note.id),value.note]);setBody('');setAttachments([]);setLocal([]);request.current=null;setMenu(false);commentInput.current?.focus();
    }catch(e){setError(e.message||'Save could not be confirmed. Your draft is retained.');}
    finally{posting.current=false;setSaving(false);}
  }
  return <main>
    <div className="brand"><span className="brand-mark">C</span><div><strong>CMPRI</strong><small>ENGINEERING</small></div></div>
    <div className="page-intro"><p>STAFF COMMUNICATION</p><h1>A place for the little things.</h1><span>Staff Notes · isolated interaction preview</span><button className="open-button" onClick={()=>setOpen(true)}>Open Staff Notes</button></div>
    {open&&<div className="backdrop"><section role="dialog" aria-modal="true" aria-labelledby="modal-title" tabIndex={-1} ref={dialog} onKeyDown={keyboard} className="modal">
      <header><div><div className="eyebrow">CMPRI</div><h2 id="modal-title">Staff Notes</h2></div><button className="close" aria-label="Close Staff Notes" onClick={()=>{stopSearch();setOpen(false);setGif(false);setMenu(false);}}>×</button></header>
      <div className="preview-label"><span/>{storageMessage}</div>
      <div className="notes" aria-label="Staff notes"><div className="day"><span/>TODAY<span/></div>{notes.map(note=><article className="note" key={note.id}><div className="note-heading"><strong>{note.name}</strong><time>{note.time}</time></div><p>{note.body}</p>{note.attachments?.map(card=><LinkCard key={card.canonicalUrl} card={card}/>)}{note.local?.map(file=><LocalCard key={file.url} file={file}/>)}</article>)}</div>
      <form className="composer" onSubmit={post} inert={saving?true:undefined}>
        {(attachments.length>0||local.length>0)&&<div className="draft-attachments">{attachments.map((card,index)=><div className="removable" key={card.canonicalUrl}><LinkCard card={card}/><button type="button" aria-label={`Remove ${card.title}`} onClick={()=>setAttachments(prev=>prev.filter((_,i)=>i!==index))}>×</button></div>)}{local.map((file,index)=><div className="removable" key={file.url}><LocalCard file={file}/><button type="button" aria-label={`Remove ${file.name}`} onClick={()=>removeLocal(index)}>×</button></div>)}</div>}
        <textarea ref={commentInput} aria-label="Write a comment" placeholder="Write a comment…" value={body} disabled={saving} maxLength={4000} onChange={e=>setBody(e.target.value)} onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();chooseFiles(e.dataTransfer.files);}}/>
        <div className="composer-bottom"><span className="hint">Emoji welcome. Keep everyone in the loop.</span><div className="action-anchor">
          <div className="split-action"><button type="button" className="media-button" disabled={saving} aria-label="Add GIF or media" aria-expanded={menu} aria-controls="media-menu" ref={mediaButton} onClick={()=>{setGif(false);stopSearch();setMenu(v=>!v);}} onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();chooseFiles(e.dataTransfer.files);}}><Icon name="image"/><Icon name="film"/><Icon name="clip"/></button><button type="submit" className="post" disabled={saving||!storageReady||(!body.trim()&&!attachments.length&&!local.length)}>{saving?'Saving…':'Post'} <Icon name="send"/></button></div>
          {menu&&<div id="media-menu" ref={menuRef} className="media-menu" role="group" aria-label="Attachment options"><button type="button" onClick={()=>{setMenu(false);setGif(true);}}>GIF</button><button type="button" onClick={()=>{fileInput.current?.click();setMenu(false);}}>Media</button><i aria-hidden="true"/></div>}
        </div></div>
        <input ref={fileInput} type="file" multiple hidden disabled={saving} aria-label="Choose local media" onChange={e=>{chooseFiles(e.target.files||[]);e.target.value='';}}/>
        {error&&<p role="alert" className="error">{error}</p>}
      </form>
      {gif&&<section className="gif-picker" aria-label="GIF search"><div className="picker-top"><strong>Find a GIF</strong><button className="close" aria-label="Close GIF search" onClick={closePicker}>×</button></div><form onSubmit={search} className="search-form"><input ref={searchInput} value={query} maxLength={50} onChange={e=>{setQuery(e.target.value);stopSearch();setResults([]);setHasMore(false);setProviderErrors([]);}} aria-label="Search GIFs" placeholder="Search GIPHY…"/><button disabled={busy||!query.trim()}>{busy?'Searching…':'Search'}</button></form><div className="provider-labels"><a href="https://giphy.com" target="_blank" rel="noopener noreferrer">Powered by GIPHY</a></div><div className="results-scroll" aria-live="polite" aria-busy={busy}>{busy&&<p className="empty">Searching GIPHY…</p>}{providerErrors.map(item=><div className="provider-error" key={item.provider}><strong>GIPHY unavailable</strong><p>{item.message}</p>{item.documentation&&<a href={item.documentation} target="_blank" rel="noopener noreferrer">Provider details ↗</a>}</div>)}{!busy&&!results.length&&!providerErrors.length&&<p className="empty">{giphyKey?'Search for a GIF.':'GIPHY search is waiting for an approved web API key.'}</p>}<div className="masonry">{results.map(card=><button type="button" key={`${card.provider}:${card.id}`} aria-label={`Attach ${card.title} from ${card.attribution}`} onClick={()=>select(card)}><img src={card.previewUrl} alt={card.title} width={card.width} height={card.height} loading="lazy"/><span>{card.attribution}</span></button>)}</div>{hasMore&&<button type="button" disabled={busy} onClick={e=>search(e,true)}>Load more GIFs</button>}</div><footer>Selected GIFs attach as attributed external links.</footer></section>}
    </section></div>}
  </main>;
}
