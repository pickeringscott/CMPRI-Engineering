"use client";
import { useUiLanguage } from "@/components/UiLanguageProvider";
import { readImportResponse } from '@/lib/import-response';
import {uploadImportFile} from '@/lib/import-upload';
import {useEffect,useState} from 'react';
import {authorizationHeaders} from '@/lib/auth/client-session';
import type {HistoryRecord} from '@/lib/purchasing-history';
import PlainTextLinks from '@/components/PlainTextLinks';
import styles from './po-receiving.module.css';
const kinds=[['supplier-observation','Automatic supplier observations'],['pdf-document','PDF documents'],['supplier-order','Supplier orders'],['order-line','Order items'],['catalog','Historical catalog'],['supplier-event','Supplier events'],['acceptance','iBuy acceptances'],['purchase-document','Purchase documents'],['correspondence','Correspondence'],['reconciliation-note','Disputes & reconciliation'],['mailbox-evidence','Mailbox source review'],['coverage','Coverage']];
function Evidence({value}:{value:unknown}){
  const {t: ui} = useUiLanguage();
 if(value===null||value===undefined)return <span>{ui("Unknown")}</span>;
 if(Array.isArray(value))return value.length?<ul>{value.map((v,i)=><li key={i}><Evidence value={v}/></li>)}</ul>:<span>{ui("None recorded")}</span>;
 if(typeof value==='object')return <dl>{Object.entries(value).map(([key,v])=><div key={key}><dt><strong>{key.replaceAll('_',' ')}</strong></dt><dd><Evidence value={v}/></dd></div>)}</dl>;
 return <PlainTextLinks text={typeof value==='boolean'?ui(value?'Yes':'No'):String(value)}/>;
}
export default function PurchasingHistory({canImport=false}:{canImport?:boolean}){
  const {t: ui} = useUiLanguage();
 const [records,setRecords]=useState<HistoryRecord[]>([]),[kind,setKind]=useState('supplier-order'),[page,setPage]=useState(0),[total,setTotal]=useState(0);
 const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[bundle,setBundle]=useState<unknown>(null);
 const [review,setReview]=useState<{digest:string;counts:Record<string,number>;sourceCount:number;records:HistoryRecord[]}|null>(null);
 useEffect(()=>{
  if(review)return;let cancelled=false;
  void (async()=>{try{const r=await fetch(`/api/engineering/purchasing-history?kind=${encodeURIComponent(kind)}&page=${page}&record=${encodeURIComponent(new URL(window.location.href).searchParams.get("historyRecord")||"")}`,{headers:await authorizationHeaders(),cache:'no-store'});const d=await readImportResponse(r);if(!r.ok)throw Error(d.error);if(!cancelled){setRecords(d.records);setTotal(d.total);}}catch(e){if(!cancelled)setMessage(e instanceof Error?e.message:'Could not load history');}})();
  return()=>{cancelled=true;};
 },[kind,page,review]);
 async function submit(action:'review'|'import',e?:React.FormEvent<HTMLFormElement>){
  e?.preventDefault();if(!canImport)return;setBusy(true);setMessage('');
  try{let input=bundle;if(action==='review'&&e){setReview(null);const file=new FormData(e.currentTarget).get('bundle');if(!(file instanceof File)||file.size>100*1024*1024)throw Error('Choose an evidence JSON file up to 100 MB');input=await uploadImportFile(file,'purchasing-history');setBundle(input);}
   const r=await fetch('/api/engineering/purchasing-history',{method:'POST',headers:{...await authorizationHeaders(),'Content-Type':'application/json'},body:JSON.stringify({action,upload:input,digest:review?.digest,reviewed:action==='import'})});const d=await readImportResponse(r);if(!r.ok)throw Error(d.error);
   if(action==='review'){setReview(d);setPage(0);}else{setReview(null);setBundle(null);setMessage(`${d.recordCount} historical records saved. Current stock unchanged.`);}
  }catch(e){setMessage(e instanceof Error?e.message:'History request failed');}finally{setBusy(false);}
 }
 const filtered=review?.records.filter(r=>r.kind===kind),visible=filtered?filtered.slice(page*50,page*50+50):records,count=filtered?.length??total;
 return <div className={`${styles.panelBody} ${styles.sourcePanel}`}><h2>{ui("Purchasing history")}</h2><p>{ui("Historical purchases and supplier catalog. Current on-hand remains unknown until reconciled with counted inventory. Shipping, acceptance and purchase documents do not establish physical receipt.")}</p>
 {canImport&&<form onSubmit={e=>void submit('review',e)} className={`${styles.form} ${styles.uploadForm}`}><label>{ui("Prepared evidence bundle (JSON)")}<input type="file" name="bundle" accept="application/json,.json" required disabled={busy}/></label><button disabled={busy}>{ui("Review historical bundle")}</button></form>}
 {message&&<p role="status">{ui(message)}</p>}{review&&<div className={styles.notice}><p>{ui("Reviewing ")}{review.sourceCount}{ui(" source messages.")}</p><p>{Object.entries(review.counts).map(([k,n])=>`${n} ${k.replaceAll('-',' ')}`).join(' · ')}</p><button disabled={busy} onClick={()=>void submit('import')}>{ui("Import reviewed history without changing stock")}</button><button disabled={busy} onClick={()=>{setReview(null);setBundle(null);setPage(0);}}>{ui("Close review")}</button></div>}
 <label>{ui("Show ")}<select value={kind} onChange={e=>{const url=new URL(window.location.href);url.searchParams.delete("historyRecord");window.history.replaceState(null,"",url);setKind(e.target.value);setPage(0);}}>{kinds.map(([k,label])=><option key={k} value={k}>{ui(label)}</option>)}</select></label>
 <p>{count}{ui(" records")}</p>{visible.map(r=><article key={r.key} className={styles.history}><h3>{r.title}</h3><p>{ui(r.status.replaceAll('-',' '))}{r.reference&&` · Reference ${r.reference}`}</p>{['order-line','catalog'].includes(r.kind)&&<p>{ui("Ordered: ")}{r.orderedQuantity??ui("Unknown")} {r.uom??ui("(unit unknown)")}{ui(" · Current on-hand: Unknown")}</p>}<details><summary>{ui("Source evidence (")}{r.sourceIds.length}{ui(" messages)")}</summary><ul>{r.sourceIds.map(id=><li key={id}><a href={`https://mail.google.com/mail/u/0/#all/${id}`} target="_blank" rel="noreferrer">{ui("Open source email ")}{id}</a></li>)}</ul><div style={{overflowWrap:'anywhere'}}><Evidence value={r.payload}/></div></details></article>)}
 <div className={styles.actions}><button disabled={busy||page===0} onClick={()=>setPage(p=>p-1)}>{ui("Previous")}</button><span>{ui("Page ")}{page+1}</span><button disabled={busy||(page+1)*50>=count} onClick={()=>setPage(p=>p+1)}>{ui("Next")}</button></div></div>;
}
