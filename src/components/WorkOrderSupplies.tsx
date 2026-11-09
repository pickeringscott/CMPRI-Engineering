"use client";
import {useCallback,useEffect,useMemo,useRef,useState} from "react";
import {createPortal} from "react-dom";
import {authorizationHeaders} from "@/lib/auth/client-session";
import {subscribeResources} from "@/lib/events/browser";
import {invalidateCachedResources} from "@/lib/data-cache/browser";
import {exactSupply,linkedPartStatus,PART_STATUSES,partsMentionedInNotes,suggestedSupplies,type SupplyItem,type TicketPart, type PartStatus} from "@/lib/work-order-parts";

type PoLine={id:string;order_id:string;description:string;inventory_item_id:string|null;received:number|string;order?:{supplier:string;external_reference:string|null;acceptance:string;cancelled:boolean;origin:string}};
type Data={items:SupplyItem[];parts:TicketPart[];poLines:PoLine[]};
type Draft={id:string;name:string;item:string;status:"In-House"|"Need to Order";quantity:string;poLine:string;revision:number};
const blank=():Draft=>({id:"",name:"",item:"",status:"In-House",quantity:"1",poLine:"",revision:0});
const field="min-h-8 min-w-0 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 text-sm disabled:opacity-60";
export default function WorkOrderSupplies({jobId,cacheScope="",issue="",notes="",disabled=false,onRecorded,registerExitGuard}:{jobId:string;cacheScope?:string;issue?:string;notes?:string;disabled?:boolean;onRecorded?:()=>Promise<unknown>;registerExitGuard?:(guard:()=>Promise<void>)=>()=>void}) {
 const [data,setData]=useState<Data>({items:[],parts:[],poLines:[]});
 const [draft,setDraft]=useState<Draft>(blank),[enabled,setEnabled]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState("");
 const [showAll,setShowAll]=useState(false),[showPo,setShowPo]=useState(false),[quantityUsed,setQuantityUsed]=useState(""),[unit,setUnit]=useState("");
 const [dirty,setDirty]=useState(false),[uncertain,setUncertain]=useState(false),[pendingKind,setPendingKind]=useState<"part"|"use"|null>(null);
 const [draftReady,setDraftReady]=useState(false),[refreshing,setRefreshing]=useState(true),[fresh,setFresh]=useState(false);
 const draftKey=`cmpri:parts-draft:v1:${cacheScope}:${jobId}`;
 const readGeneration=useRef(0);
 const pending=useRef<{kind:"part"|"use";body:Record<string,unknown>}|null>(null),submitting=useRef(false);
 const load=useCallback(async()=>{
  const generation=++readGeneration.current;
  setRefreshing(true);
  try{
   const headers=await authorizationHeaders();
   let response=await fetch(`/api/work-orders/${encodeURIComponent(jobId)}/parts`,{headers,cache:"no-store"});
   let result=await response.json();
   if(generation!==readGeneration.current)return null;
   if(response.ok&&response.headers.get("X-CMPRI-Data-Cache")==="hit"){
    setData(result);setEnabled(true);setFresh(false);
    response=await fetch(`/api/work-orders/${encodeURIComponent(jobId)}/parts`,{headers,cache:"reload"});
    result=await response.json();
    if(generation!==readGeneration.current)return null;
   }
   if(response.status===409){setEnabled(false);return null;}
   if(!response.ok){if([401,403].includes(response.status)){setEnabled(false);setData({items:[],parts:[],poLines:[]});}throw Error(result.error||"Parts unavailable.");}
   setData(result);setEnabled(true);setFresh(true);return result as Data;
  }catch(error){if(generation===readGeneration.current)setFresh(false);throw error;}
  finally{if(generation===readGeneration.current)setRefreshing(false);}
 },[jobId]);
 useEffect(()=>{let active=true;void Promise.resolve().then(load).catch(error=>{if(active)setMessage(error.message);});return()=>{active=false;readGeneration.current++;};},[load]);
 useEffect(()=>subscribeResources(["orders","reference"],async()=>{if(!submitting.current)await load();},false),[load]);
 useEffect(()=>{
  const section=document.getElementById("cmpri-labor-parts");
  const opened=()=>{if((section as HTMLDetailsElement)?.open&&!submitting.current){void load().catch(error=>setMessage(error.message));void onRecorded?.();}};
  section?.addEventListener("toggle",opened);return()=>section?.removeEventListener("toggle",opened);
 },[load,onRecorded]);
 useEffect(()=>{
  let active=true;
  void Promise.resolve().then(()=>{
   if(!active)return;
   try{
    const raw=localStorage.getItem(draftKey),saved=raw?JSON.parse(raw):null;
    if(saved?.version===1&&saved.draft&&typeof saved.draft.name==="string"&&["In-House","Need to Order"].includes(saved.draft.status)&&Number.isSafeInteger(saved.draft.revision)){
     setDraft(saved.draft);setDirty(Boolean(saved.dirty));setQuantityUsed(String(saved.quantityUsed||""));setUnit(String(saved.unit||""));
     if(saved.pending&&["part","use"].includes(saved.pending.kind)&&typeof saved.pending.body?.id==="string"){
      pending.current=saved.pending;setPendingKind(saved.pending.kind);setUncertain(true);setMessage("A previous save is unconfirmed. Retry the same operation to confirm it without duplicating stock or parts.");
     }else setMessage("Unsaved part details restored from this device. Review before saving.");
    }
   }catch{setMessage("Local part draft could not be read. Check the ticket notes before retrying a prior save.");}
   setDraftReady(true);
  });
  return()=>{active=false;};
 },[draftKey]);
 useEffect(()=>{
  if(!draftReady)return;
  try{
   if(dirty||quantityUsed||uncertain||busy)localStorage.setItem(draftKey,JSON.stringify({version:1,draft,dirty,quantityUsed,unit,pending:pending.current}));
   else localStorage.removeItem(draftKey);
  }catch{ /* A failed mandatory pre-write checkpoint is surfaced by submit. */ }
 },[draftKey,draftReady,draft,dirty,quantityUsed,unit,uncertain,busy]);
 useEffect(()=>{const warn=(event:BeforeUnloadEvent)=>{if(dirty||uncertain||quantityUsed)event.preventDefault();};window.addEventListener("beforeunload",warn);return()=>window.removeEventListener("beforeunload",warn);},[dirty,uncertain,quantityUsed]);
 useEffect(()=>registerExitGuard?.(async()=>{if(dirty||quantityUsed||uncertain||submitting.current)throw Error("Save or discard the part changes, and confirm any pending supply use before closing this ticket.");}),[dirty,quantityUsed,uncertain,registerExitGuard]);
 const selected=data.parts.find(part=>part.id===draft.id),inventory=data.items.find(item=>item.id===draft.item);
 const matched=useMemo(()=>suggestedSupplies(data.items,issue),[data.items,issue]);
 const supplies=showAll?data.items:matched;
 const options=inventory&&!supplies.some(item=>item.id===inventory.id)?[inventory,...supplies]:supplies;
 const suggestions=useMemo(()=>partsMentionedInNotes(notes).filter(name=>!data.parts.some(part=>part.name.toLowerCase()===name.toLowerCase())),[notes,data.parts]);
 const linkedLine=data.poLines.find(line=>line.id===draft.poLine);
 const displayedStatus:PartStatus=!dirty&&selected?selected.status:linkedPartStatus({requested_status:draft.status,po_line_id:draft.poLine||null,inventory_item_id:draft.item||null,quantity:Number(draft.quantity)||1},linkedLine,linkedLine?.order,linkedLine?.received||0);
 const locked=busy||disabled||uncertain||refreshing||!fresh;
 function edit(change:Partial<Draft>){if(locked||Object.entries(change).every(([key,value])=>draft[key as keyof Draft]===value))return;setDraft(current=>({...current,...change}));setDirty(true);setMessage("");}
 function choosePart(value:string){
  if(locked)return;
  if(dirty&&!window.confirm("Discard unsaved part changes?"))return;
  const part=data.parts.find(part=>part.id===value);
  const explicitSupply=value.startsWith("supply:")?data.items.find(item=>item.id===value.slice(7)):undefined;
  const name=explicitSupply?.item_name||(value.startsWith("note:")?suggestions[Number(value.slice(5))]||"":"");
  const match=exactSupply(data.items,name);
  setDraft(part?{id:part.id,name:part.name,item:part.inventory_item_id||"",status:part.requested_status,quantity:String(part.quantity),poLine:part.po_line_id||"",revision:part.revision}:{...blank(),name,item:match?.id||"",status:"In-House"});
  setDirty(Boolean(name));setUnit("");setQuantityUsed("");setMessage("");setShowPo(Boolean(part?.po_line_id));
 }
 async function submit(kind:"part"|"use") {
  if(submitting.current||disabled||refreshing||!fresh)return;
  if(uncertain&&pending.current?.kind!==kind)return;
  if(kind==="part"&&!draft.name.trim()){setMessage("Enter the part name.");return;}
  if(kind==="use"&&!uncertain&&(!inventory||!(Number(quantityUsed)>0))){setMessage("Choose a supply and quantity actually used.");return;}
  const preparedNow=!pending.current;
  if(!pending.current){const partId=draft.id||crypto.randomUUID();if(kind==="part"&&!draft.id)setDraft(current=>({...current,id:partId}));pending.current={kind,body:kind==="part"?{id:partId,name:draft.name.trim(),item:draft.item||null,status:draft.status,quantity:Number(draft.quantity),po_line:draft.poLine||null,expected_revision:draft.revision}:{id:crypto.randomUUID(),job:jobId,item:draft.item,quantity:Number(quantityUsed),unit:unit||null,confirmed:true}};}
  const attempt=pending.current;setPendingKind(attempt.kind);
  try{localStorage.setItem(draftKey,JSON.stringify({version:1,draft:{...draft,id:kind==="part"?String(attempt.body.id):draft.id},dirty,quantityUsed,unit,pending:attempt}));}
  catch{if(preparedNow){pending.current=null;setPendingKind(null);}setMessage("Cannot preserve this save attempt locally. Free device storage before recording parts or supply use.");return;}
  submitting.current=true;setBusy(true);setMessage("");
  try{
   const response=await fetch(attempt.kind==="part"?`/api/work-orders/${encodeURIComponent(jobId)}/parts`:"/api/engineering/supply-use",{method:"POST",headers:{...await authorizationHeaders(),"Content-Type":"application/json"},body:JSON.stringify(attempt.body)});
   const result=await response.json().catch(()=>({}));
   if(!response.ok){
    if(response.status===409&&attempt.kind==="part"){
     const fresh=await load(),existing=fresh?.parts.find(part=>part.id===attempt.body.id);
     if(existing&&attempt.body.expected_revision===0){setDraft({id:existing.id,name:existing.name,item:existing.inventory_item_id||"",status:existing.requested_status,quantity:String(existing.quantity),poLine:existing.po_line_id||"",revision:existing.revision});setDirty(false);pending.current=null;setUncertain(false);setMessage("This part changed in another session. Showing its current saved record; review before editing.");return;}
     if(existing&&existing.revision!==attempt.body.expected_revision)result.error="This part changed in another session. Your local edits are preserved; cancel this part edit to load the saved record.";
    }
    if(response.status<500){pending.current=null;setUncertain(false);}else setUncertain(true);
    throw Error(result.error||"Save not confirmed. Retry this same operation.");
   }
   // Keep the exact operation key through a failed readback; retry cannot deduct/create twice.
   const fresh=await load();if(!fresh)throw Error("Save succeeded but readback is unavailable. Retry to confirm.");
   if(attempt.kind==="part"){
    const part=fresh.parts.find(part=>part.id===result.id);
    if(!part)throw Error("Saved part could not be confirmed. Retry to confirm.");
    setDraft({id:part.id,name:part.name,item:part.inventory_item_id||"",status:part.requested_status,quantity:String(part.quantity),poLine:part.po_line_id||"",revision:part.revision});setDirty(false);
   }else setQuantityUsed("");
   pending.current=null;setUncertain(false);
   setMessage(attempt.kind==="part"?"Part saved. Activity posted to ticket notes.":"Supply use recorded once. Inventory and ticket notes updated.");
   await invalidateCachedResources(["orders","reference"]);
   await onRecorded?.();
  }catch(error){if(pending.current)setUncertain(true);setMessage(error instanceof Error?error.message:"Save not confirmed. Retry this same operation.");}
  finally{submitting.current=false;setBusy(false);}
 }
 if(!enabled)return message?<p role="status" className="text-xs text-amber-300">{message}</p>:null;
 const header=document.getElementById("cmpri-parts-status");
 const statusControl=<label className="inline-flex items-center gap-1 text-[11px] font-semibold" onClick={event=>event.stopPropagation()} onKeyDown={event=>event.stopPropagation()}>Status<select aria-label="Selected part status" className={`${field} w-auto max-w-36 text-xs`} value={displayedStatus} disabled={locked||Boolean(draft.poLine)} title={draft.poLine?"Status follows the linked PO and physical receiving records":"Status of this part"} onChange={event=>edit({status:event.target.value as Draft["status"]})}>{PART_STATUSES.map(status=><option key={status} disabled={status==="On Order"||status==="Received"}>{status}</option>)}</select></label>;
 return <div className="mt-1 space-y-1 border-t border-slate-700 pt-1 text-sm">
  {header?createPortal(statusControl,header):statusControl}
  <h3 className="text-sm font-semibold">Supplies Used / Parts</h3>
  <label className="grid grid-cols-[4rem_minmax(0,1fr)] items-center gap-1">Part<select aria-label="Choose ticket part" className={field} disabled={locked} value={selected?.id||""} onChange={event=>choosePart(event.target.value)}><option value="">Add part…</option>{data.parts.map(part=><option key={part.id} value={part.id}>{part.name} · {part.status}</option>)}{matched.length>0&&<optgroup label="Suggested from current issue">{matched.filter(item=>!data.parts.some(part=>part.inventory_item_id===item.id)).map(item=><option key={item.id} value={`supply:${item.id}`}>{item.item_name}</option>)}</optgroup>}{suggestions.length>0&&<optgroup label="Mentioned in ticket notes">{suggestions.map((name,index)=><option key={name} value={`note:${index}`}>{name}</option>)}</optgroup>}</select></label>
  <label className="grid grid-cols-[4rem_minmax(0,1fr)] items-center gap-1">Name<input aria-label="Part name" className={field} maxLength={500} value={draft.name} disabled={locked} placeholder="Name the part needed" onChange={event=>{const match=exactSupply(data.items,event.target.value);edit({name:event.target.value,...(match?{item:match.id}:{})});}}/></label>
  <label className="grid grid-cols-[4rem_minmax(0,1fr)] items-center gap-1">Supply<select aria-label="Supply" className={field} disabled={locked} value={draft.item} onChange={event=>{const item=data.items.find(item=>item.id===event.target.value);edit({item:event.target.value,...(!draft.name&&item?{name:item.item_name}:{})});setUnit("");}}><option value="">Choose supply</option>{options.map(item=><option key={item.id} value={item.id}>{item.item_name} · {Number(item.quantity_on_hand)-Number(item.quantity_reserved)} {item.unit_of_measure} available · {item.quantity_on_hand} on hand / {item.quantity_reserved} reserved</option>)}</select></label>
  <div className="text-right"><button type="button" className="text-xs text-sky-300 underline" disabled={busy||uncertain} onClick={()=>setShowAll(value=>!value)}>{showAll?"Show suggested supplies":"Show all supplies"}</button></div>
  <div className="flex flex-wrap items-center gap-2"><label className="inline-flex items-center gap-1 text-xs">Quantity needed<input aria-label="Quantity needed" className={`${field} w-20`} type="number" min="0.001" max="999999" step="0.001" value={draft.quantity} disabled={locked} onChange={event=>edit({quantity:event.target.value})}/></label><button type="button" className="rounded border border-amber-400/60 px-2 py-1 text-xs text-amber-300 disabled:opacity-50" disabled={busy||disabled||refreshing||!fresh||(!dirty&&!uncertain)} onClick={()=>void submit("part")}>{uncertain&&pendingKind==="part"?"Retry part save":draft.status==="Need to Order"&&!draft.poLine?"Save order idea":"Save part"}</button>{(dirty||quantityUsed)&&!uncertain&&<button type="button" className="text-xs text-slate-300 underline" disabled={locked} onClick={()=>choosePart(selected?.id||"")}>Cancel part edit</button>}<button type="button" className="text-xs text-sky-300 underline" disabled={locked} onClick={()=>setShowPo(value=>!value)}>Link existing PO</button></div>
  {showPo&&<label className="block text-xs">PO item<select aria-label="Linked PO item" className={field} value={draft.poLine} disabled={locked} onChange={event=>{const line=data.poLines.find(line=>line.id===event.target.value);edit({poLine:event.target.value,...(line?{item:line.inventory_item_id||"",status:"Need to Order" as const}:{})});}}><option value="">No linked PO</option>{data.poLines.filter(line=>!line.order?.cancelled||line.id===draft.poLine).map(line=><option key={line.id} value={line.id}>{line.order?.external_reference||line.order?.supplier||"PO"} · {line.description}</option>)}</select></label>}
  {linkedLine&&<a className="block text-xs text-sky-300 underline" href={`/engineering/purchasing?order=${encodeURIComponent(linkedLine.order_id)}`}>View linked PO · {linkedLine.received} stock units physically received</a>}
  <div className="flex flex-wrap items-end gap-2 border-t border-slate-700 pt-1"><label className="block text-xs">Quantity used<input aria-label="Quantity used" className={`${field} w-24`} type="number" min="0.001" step="0.001" value={quantityUsed} disabled={locked||dirty} onChange={event=>setQuantityUsed(event.target.value)}/></label><label className="block text-xs">Unit<select aria-label="Usage unit" className={`${field} w-24`} value={unit} disabled={locked||dirty} onChange={event=>setUnit(event.target.value)}><option value="">{inventory?.unit_of_measure||"Inventory unit"}</option>{["EA","LB","OZ","G","KG"].map(value=><option key={value}>{value}</option>)}</select></label><button type="button" className="min-h-8 rounded bg-amber-400 px-2 py-1 text-xs font-semibold text-slate-950 disabled:opacity-50" disabled={busy||disabled||refreshing||!fresh||(uncertain?pendingKind!=="use":dirty||!inventory||!["In-House","Received"].includes(displayedStatus))} onClick={()=>void submit("use")}>{uncertain&&pendingKind==="use"?"Retry supply use":"Record supply use"}</button></div>
  {refreshing&&<p role="status" className="text-xs text-slate-400">Refreshing current inventory and PO records…</p>}
  {!fresh&&!refreshing&&<button type="button" className="text-xs text-sky-300 underline" onClick={()=>void load().catch(error=>setMessage(error.message))}>Retry current data</button>}
  {disabled&&<p className="text-xs text-amber-300">Save your ticket changes before recording parts activity.</p>}
  {message&&<p role="status" className="text-xs text-amber-300">{message}</p>}
 </div>;
}
