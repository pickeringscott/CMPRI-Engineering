"use client";
import React,{useEffect,useRef,useState} from 'react';
import {createPortal,flushSync} from 'react-dom';
type Attachment={can_remove?:boolean;id:string;name:string;url:string;uploaded_at?:string|null;uploader_name?:string;uploader_role?:string;type?:string};
export default function WorkOrderAttachmentHistory({items,onRemove,removing}:{items:Attachment[];onRemove?:(item:Attachment)=>void;removing?:boolean}){
 const [hover,setHover]=useState<{item:Attachment;x:number;y:number}|null>(null),[openedId,setOpenedId]=useState<string|null>(null);
 const opened=items.find(item=>item.id===openedId)||null;
 const dialog=useRef<HTMLDialogElement>(null),fullVideo=useRef<HTMLVideoElement>(null),trigger=useRef<HTMLAnchorElement|null>(null),hideTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
 const video=(item:Attachment)=>item.type?.startsWith('video/')||/\.(webm|mp4|mov|m4v|ogv)$/i.test(item.name);

 function keepPreview(){if(hideTimer.current){clearTimeout(hideTimer.current);hideTimer.current=null}}
 function leavePreview(){keepPreview();hideTimer.current=setTimeout(()=>setHover(null),180)}
 useEffect(()=>()=>{if(hideTimer.current)clearTimeout(hideTimer.current)},[]);
 function open(item:Attachment){keepPreview();setHover(null);flushSync(()=>setOpenedId(item.id));dialog.current?.showModal();if(video(item))void fullVideo.current?.play().catch(()=>{})}
 function close(){fullVideo.current?.pause();setOpenedId(null);trigger.current?.focus()}
 function preview(item:Attachment,anchor:HTMLAnchorElement){keepPreview();trigger.current=anchor;const r=anchor.getBoundingClientRect();setHover({item,x:Math.max(8,Math.min(r.left,innerWidth-232)),y:Math.max(8,Math.min(r.bottom+6,innerHeight-160))})}
 return <>{items.map(item=><div className="preview-history-attachment" key={item.id}><time>{item.uploaded_at?new Date(item.uploaded_at).toLocaleString([], {month:'numeric',day:'numeric',hour:'numeric',minute:'2-digit'}):'Date unavailable'}</time><span className="preview-uploader" title={item.uploader_role||''}>{item.uploader_name||'Uploader unavailable'}{item.uploader_role&&<small>{item.uploader_role}</small>}</span><a className="preview-attachment-link" href={item.url} onMouseEnter={e=>preview(item,e.currentTarget)} onMouseLeave={leavePreview} onFocus={e=>preview(item,e.currentTarget)} onBlur={leavePreview} onClick={e=>{e.preventDefault();trigger.current=e.currentTarget;open(item)}}>{item.name}</a></div>)}{hover&&createPortal(<div role="tooltip" className="preview-attachment-hover" onMouseEnter={keepPreview} onMouseLeave={leavePreview} style={{left:hover.x,top:hover.y}}><button type="button" className="preview-hover-open" aria-label={"Open "+hover.item.name} onFocus={keepPreview} onBlur={leavePreview} onClick={()=>open(hover.item)}>{video(hover.item)?<video src={hover.item.url} preload="auto" muted playsInline onLoadedData={e=>{e.currentTarget.pause();e.currentTarget.currentTime=0}}/>:<img src={hover.item.url} alt={'Preview of '+hover.item.name}/>}</button></div>,document.body)}{opened&&<dialog ref={dialog} className="preview-attachment-dialog" aria-label={opened.name} onCancel={e=>{e.preventDefault();close()}}><header><span>{opened.name}</span>{opened.can_remove&&onRemove&&<button type="button" disabled={removing} onClick={()=>onRemove(opened)} aria-label="Remove attachment">Remove</button>}<button type="button" onClick={close} aria-label="Close attachment">×</button></header>{video(opened)?<video ref={fullVideo} src={opened.url} controls autoPlay playsInline/>:<img src={opened.url} alt={opened.name}/>}</dialog>}</>;
}
