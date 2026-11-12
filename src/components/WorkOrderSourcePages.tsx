"use client";

import {useEffect,useLayoutEffect,useRef,useState} from "react";
import {createClient,getValidSession} from "@/lib/supabase/client";
import {sourcePageHtml} from "@/lib/manual-document-html";
import {themeSourceDiagramBlob} from "@/lib/work-orders/diagram-theme";
import ManualSourceLink from "./ManualSourceLink";
import type {SourcePassage} from "@/lib/manual-source";

type Props={passages:SourcePassage[];sourceUrl:string;assetId:string;sourceSha256:string;userId:string;sourceOrder?:string[];contextKey?:string;isOpen?:boolean;startAtTop?:boolean};
const pageKey=(page:SourcePassage)=>JSON.stringify([page.source_document_id||page.source_url,page.source_sha256,page.page]);

/** A continuous guide in original document/page order; no page-selection control. */
export default function WorkOrderSourcePages({passages,sourceUrl,assetId,sourceSha256,userId,sourceOrder=[],contextKey='',isOpen=true,startAtTop=true}:Props){
  const host=useRef<HTMLDivElement>(null);
  const [paletteVersion,setPaletteVersion]=useState(0);
  const documents=[...new Set([...sourceOrder,...passages.map(page=>page.source_document_id||page.source_url||sourceUrl)])];
  const pages=[...new Map(passages.map(page=>[pageKey(page),page])).values()].sort((a,b)=>
    documents.indexOf(a.source_document_id||a.source_url||sourceUrl)-documents.indexOf(b.source_document_id||b.source_url||sourceUrl)||a.page-b.page);
  const hasPages=pages.length>0;
  const viewKey=JSON.stringify([assetId,sourceSha256,userId,contextKey,pages.map(pageKey)]);
  const entered=useRef('');
  useLayoutEffect(()=>{
    if(!isOpen){entered.current='';return;}
    if(!hasPages||!startAtTop||entered.current===viewKey)return;
    const target=host.current;if(!target)return;
    const editing=target.ownerDocument.activeElement;
    if(editing?.matches('input,textarea,[contenteditable="true"]')&&!target.closest('[data-ticket-accordion="troubleshooting"]')?.contains(editing))return;
    entered.current=viewKey;
    const header=target.closest('[data-ticket-layout]')?.querySelector('[data-preview-locked-pane]');
    target.style.scrollMarginTop=((header?.getBoundingClientRect().height||0)+8)+'px';
    target.scrollIntoView?.({block:'start',behavior:'instant'});
  },[isOpen,hasPages,startAtTop,viewKey]);
  useEffect(()=>{
    if(!host.current||typeof MutationObserver==='undefined')return;
    const signature=()=>{const style=getComputedStyle(host.current!);return style.backgroundColor+'/'+style.color;};
    let previous=signature();
    const changed=()=>{const next=signature();if(next!==previous){previous=next;setPaletteVersion(value=>value+1);}};
    const observer=new MutationObserver(changed);
    for(let ancestor:HTMLElement|null=host.current.parentElement;ancestor;ancestor=ancestor.parentElement)observer.observe(ancestor,{attributes:true,attributeFilter:['style','class','data-theme','data-cmpri-modal-theme']});
    window.addEventListener('cmpri-palette-change',changed);
    return()=>{observer.disconnect();window.removeEventListener('cmpri-palette-change',changed);};
  },[hasPages]);
  if(!hasPages)return null;
  return <div ref={host} data-source-page-surface className="mt-1 text-sm" style={{backgroundColor:'var(--cmpri-modal-surface,#191b24)',color:'var(--cmpri-modal-text,#f0f1f6)'}}>
    <p className="font-semibold text-sky-300">Source pages ({pages.length})</p>
    <p className="text-xs text-slate-400">Pages follow their original order. Compare the source and its warnings before using a procedure.</p>
    {pages.map(page=><SourcePage key={pageKey(page)} passage={page} sourceUrl={sourceUrl} assetId={assetId} sourceSha256={sourceSha256} userId={userId} host={host} paletteVersion={paletteVersion} isOpen={isOpen}/>)}
  </div>;
}

function SourcePage({passage,sourceUrl,assetId,sourceSha256,userId,host,paletteVersion,isOpen}:Omit<Props,'passages'>&{passage:SourcePassage;host:React.RefObject<HTMLDivElement|null>;paletteVersion:number}){
  const element=useRef<HTMLElement>(null);
  const [near,setNear]=useState(()=>typeof IntersectionObserver==='undefined');
  const [ratio,setRatio]=useState('17 / 22');
  const [image,setImage]=useState<{key:string;url:string;adapted:boolean}|null>(null);
  const sha=passage.source_sha256||sourceSha256;
  const url=passage.source_url||sourceUrl;
  const imageKey=JSON.stringify([assetId,userId,pageKey(passage),sha,paletteVersion]);
  const active=near&&isOpen;
  useEffect(()=>{
    if(!element.current||typeof IntersectionObserver==='undefined')return;
    const observer=new IntersectionObserver(entries=>{
      const visible=entries.some(entry=>entry.isIntersecting);
      setNear(visible);if(!visible)setImage(null);
    },{rootMargin:'600px 0px'});
    observer.observe(element.current);
    return()=>observer.disconnect();
  },[]);
  useEffect(()=>{
    if(!active||!assetId||!sha||!userId)return;
    const controller=new AbortController();let displayUrl='';
    const {data:{subscription}}=createClient().auth.onAuthStateChange((_event,session)=>{
      if(session?.user.id!==userId){controller.abort();if(displayUrl)URL.revokeObjectURL(displayUrl);displayUrl='';setImage(null);}
    });
    void(async()=>{
      try{
        const session=await getValidSession();
        if(!session?.access_token||session.user.id!==userId||controller.signal.aborted)return;
        const query=new URLSearchParams({source:'asset-upload',assetId,sha256:sha,pageImage:String(passage.page)});
        if(passage.source_document_id)query.set('fileId',passage.source_document_id);
        const response=await fetch('/api/maintenance-reference?'+query,{headers:{Authorization:'Bearer '+session.access_token},signal:controller.signal,cache:'no-store'});
        if(!response.ok)return;
        const blob=await response.blob(),after=await getValidSession();
        if(controller.signal.aborted||after?.user.id!==userId)return;
        const display=await themeSourceDiagramBlob(blob,host.current,passage.text,response.headers?.get('X-CMPRI-Source-Artwork')==='vector');
        if(controller.signal.aborted)return;
        displayUrl=URL.createObjectURL(display.blob);setImage({key:imageKey,url:displayUrl,adapted:display.adapted});
      }catch{/* The authenticated original remains available if the page image fails. */}
    })();
    return()=>{controller.abort();subscription.unsubscribe();if(displayUrl)URL.revokeObjectURL(displayUrl);};
  },[active,assetId,sha,userId,imageKey,passage.page,passage.source_document_id,passage.text,host]);
  const chart=/\b(?:troubleshooting|diagnostic|fault|flow)\s*chart\b/i.test(passage.text);
  return <section ref={element} data-continuous-source-page={passage.page} data-source-document={passage.source_document_id} className="mt-1 border-t border-slate-700">
    <p className="font-semibold text-sky-300">{passage.source_file_name||'Source'} · PDF page {passage.page}{passage.printed_label&&passage.printed_label!==String(passage.page)?' (printed '+passage.printed_label+')':''}</p>
    <div data-original-chart={chart?'true':undefined} style={{aspectRatio:ratio}}>
      {active&&image?.key===imageKey?<picture style={{display:'contents'}}><img data-diagram-adapted={image.adapted?'true':'false'} className="h-auto w-full rounded border border-slate-700" src={image.url} alt={'Manual page '+passage.page+', including diagrams and tables'} onLoad={event=>{const image=event.currentTarget;if(image.naturalWidth&&image.naturalHeight)setRatio(image.naturalWidth+' / '+image.naturalHeight);}}/></picture>:<p className="text-xs text-slate-400">The original page loads here as you scroll. The PDF link is available below.</p>}
    </div>
    <ManualSourceLink userId={userId} className="text-sky-300 underline" href={url.split('#')[0]+'#page='+passage.page}>Open PDF page {passage.page}</ManualSourceLink>
    <details className="mt-1" open={!chart} data-source-transcription>
      <summary className="cursor-pointer text-xs text-sky-300">Extracted text from PDF page {passage.page}</summary>
      {chart&&<p className="text-xs text-slate-400">This text does not retain chart connections. Use the original diagram when following a branch.</p>}
      <div className="break-words [&_h2]:font-semibold [&_h2]:text-sky-300 [&_h3]:font-semibold [&_ol]:list-decimal [&_ol]:pl-6 [&_ul]:list-disc [&_ul]:pl-6 [&_.manual-source-table]:overflow-x-auto [&_table]:border-collapse [&_th]:border [&_th]:border-slate-700 [&_td]:border [&_td]:border-slate-700" dangerouslySetInnerHTML={{__html:sourcePageHtml(passage.text,passage.page,passage.origin||'pdf')}}/>
    </details>
  </section>;
}
