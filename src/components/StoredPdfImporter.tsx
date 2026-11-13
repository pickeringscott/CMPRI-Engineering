"use client";
import { useEffect, useRef, useState } from "react";
import { eligibleManualLinks, serialRangeStatus, type ManualApplicabilityReview } from "@/lib/manual-applicability";
import { pdfImportResponse, uploadPdfDirect } from "@/lib/pdf-direct-upload";
import type { PdfReview, StoredPdf } from "@/lib/stored-pdf-link";
import { pdfReviewSuggestions, type EquipmentSuggestions } from "@/lib/equipment-pdf-suggestions";
import { preservePdfReview } from "@/lib/stored-pdf-link";

type SavedLink = StoredPdf & PdfReview & { sha256: string; document_id?: string };
type Review = { file: StoredPdf; sha256: string; url: string; saved_fields: SavedLink | null; suggestions: EquipmentSuggestions | null; readable_text: boolean; updated_at: string; asset_identity: Omit<ManualApplicabilityReview, "confirmed"> };
const blank: PdfReview = { title:"", manufacturer:"", models:[], selected_model:"", applicability:"reference", notes:"", reason:"", extracted_fields:{} };

export default function StoredPdfImporter({ assetId, assetName, token, onSaved, sourceFile, onSourceFileChange }: { assetId:string; assetName:string; token:()=>Promise<string | null>; onSaved:(previousUpdatedAt:string, savedUpdatedAt:string)=>void; sourceFile?:File|null; onSourceFileChange?:(file:File|null)=>void }) {
  const [files,setFiles]=useState<StoredPdf[]>([]), [links,setLinks]=useState<SavedLink[]>([]);
  const [objectId,setObjectId]=useState(""), [review,setReview]=useState<Review|null>(null), [fields,setFields]=useState<PdfReview>(blank);
  const [updatedAt,setUpdatedAt]=useState(""), [busy,setBusy]=useState(true), [message,setMessage]=useState("");
  const [assetIdentity,setAssetIdentity]=useState<Review["asset_identity"]|null>(null);
  const [localUpload,setLocalUpload]=useState<File|null>(null);
  const upload=sourceFile===undefined?localUpload:sourceFile;
  const setUpload=onSourceFileChange||setLocalUpload;
  const [uploading,setUploading]=useState(false);
  const [previewReadOnly,setPreviewReadOnly]=useState(false);
  const running = useRef(false), uploadController = useRef<AbortController | null>(null), fileInput = useRef<HTMLInputElement | null>(null);
  const inputClass="min-h-10 min-w-0 w-full max-w-full rounded border border-slate-600 bg-slate-900 p-2 text-sm";
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const access = await token();
        if (!access) throw new Error("Sign in again.");
        const response = await fetch(`/api/assets/documentation?mode=stored&asset_id=${encodeURIComponent(assetId)}`, { headers: { Authorization: `Bearer ${access}` }, cache: "no-store", signal: controller.signal });
        if(response.headers?.get('X-CMPRI-Preview')==='read-only')setPreviewReadOnly(true);
        const result = await pdfImportResponse(response);
        if (controller.signal.aborted) return;
        setFiles(result.files); setLinks(result.links); setUpdatedAt(result.updated_at); setAssetIdentity(result.asset_identity);
      } catch (error) {
        if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : "PDFs could not be loaded.");
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    })();
    return () => {controller.abort();uploadController.current?.abort();};
  }, [assetId, token]);
  useEffect(()=>{if(sourceFile===null){uploadController.current?.abort();if(fileInput.current)fileInput.current.value='';}},[sourceFile]);
  async function request(form?:FormData, signal?:AbortSignal) {
    const access=await token(); if(!access) throw new Error("Sign in again.");
    const response=await fetch(form ? "/api/assets/documentation" : `/api/assets/documentation?mode=stored&asset_id=${encodeURIComponent(assetId)}`, {method:form?"POST":"GET",headers:{Authorization:`Bearer ${access}`},signal,...(form?{body:form}:{cache:"no-store" as const})});
    if(response.headers?.get('X-CMPRI-Preview')==='read-only')setPreviewReadOnly(true);
    return pdfImportResponse(response);
  }
  async function load() {
    const result=await request();setFiles(result.files);setLinks(result.links);setUpdatedAt(result.updated_at);setAssetIdentity(result.asset_identity);
    return result;
  }
  async function run(action:"load"|"review"|"upload"|"save"|"unlink", id=objectId, purpose?:'confirmed_model'|'reference') {
    if(running.current)return;running.current=true;setBusy(true);setMessage("");
    try {
      if(action==="load"){await load();setReview(null);setMessage("Choose a stored PDF or upload another original.");return;}
      const form=new FormData();form.set("asset_id",assetId);form.set("import_action",action);form.set("object_id",id);
      form.set("expected_updated_at",updatedAt);form.set("reason",fields.reason.trim() || "Removed manual association");
      if(action==="upload"&&!upload)throw new Error("Choose a PDF.");
      if(action==="save") {
        if(!review||review.file.object_id!==id)throw new Error("Review the selected PDF first.");
        form.set("sha256",review.sha256);form.set("fields",JSON.stringify({...fields,reason:fields.reason.trim() || (review.saved_fields ? "Updated manual association" : "Attached manual to equipment")}));form.set("review_confirmed","true");
      }
      let result;
      if(action==="upload"&&upload) {
        const controller=new AbortController();uploadController.current=controller;setUploading(true);
        result=await uploadPdfDirect(upload,assetId,f=>request(f,controller.signal),controller.signal,setMessage);
      } else result=await request(form);
      if(action==="review"||action==="upload") {
        const next=result as Review;
        setObjectId(next.file.object_id);setReview(next);setAssetIdentity(next.asset_identity);setUpdatedAt(next.updated_at);
        // Re-reading the same document never replaces in-progress edits. Saved overrides
        // take priority when opening a different document; extracted candidates stay suggestions.
        const suggested=pdfReviewSuggestions(next.file.title,next.suggestions);
        const reviewedFields = preservePdfReview(review?.file.object_id||null,next.file.object_id,fields,next.saved_fields ? {...blank,...next.saved_fields} : null,suggested);
        const chosenFields:PdfReview={ ...reviewedFields, ...(action==='upload'&&upload&&!next.saved_fields&&review?.file.object_id!==next.file.object_id?{title:upload.name}:{}), ...(purpose?{applicability:purpose}:{}), applicability_review: (purpose||reviewedFields.applicability) === "confirmed_model" ? { ...next.asset_identity, confirmed: true } : null, quarantine_acknowledged: false };
        setFields(chosenFields);
        setMessage(next.readable_text?"Review the PDF and choose whether it should be used for troubleshooting.":"The text preview is unavailable. You can still attach and open the complete original.");
        if(action==="upload"){
          const fresh=await load();
          if(purpose&&next.file.catalog_status!=='content_mismatch'){
            setMessage('Attaching the original manual to this asset…');
            const save=new FormData();save.set('asset_id',assetId);save.set('import_action','save');save.set('object_id',next.file.object_id);save.set('expected_updated_at',fresh.updated_at);save.set('sha256',next.sha256);save.set('review_confirmed','true');
            save.set('fields',JSON.stringify({...chosenFields,reason:purpose==='confirmed_model'?'User selected Upload and use for troubleshooting':'User selected Upload as reference'}));
            const saved=await request(save,uploadController.current?.signal);
            if(saved.association_verified!==true)throw Error('The upload completed, but its attachment could not be confirmed. Retry Attach manual below; the original is preserved.');
            setReview({...next,saved_fields:saved.saved});
            onSaved(fresh.updated_at,saved.updated_at);await load();
            setMessage(purpose==='confirmed_model'?'Confirmed. The original manual is attached and ready for this asset’s guide.':'The original manual is attached as a reference.');
          }else if(purpose)setMessage('Original uploaded. Review and acknowledge the document warning below before attaching it.');
          if(sourceFile===undefined){setUpload(null);if(fileInput.current)fileInput.current.value='';}
        }
      } else {
        if (typeof result.updated_at === "string" && result.updated_at) onSaved(updatedAt, result.updated_at);
        await load();
        if(action==="unlink"){setReview(null);setObjectId("");setFields(blank);}
        setMessage(action==="unlink"?"Manual removed from this asset. The original PDF is preserved.":fields.applicability==="confirmed_model"?"Manual attached for this asset’s troubleshooting.":"Manual attached as a reference.");
      }
    } catch(error){setMessage(uploadController.current?.signal.aborted?"Upload stopped. The original or attachment may already be saved. Reload the attached manuals before retrying; existing originals will be reused.":error instanceof Error?error.message:"PDF import failed.");}finally{uploadController.current=null;running.current=false;setUploading(false);setBusy(false);}
  }
  const applicable = assetIdentity ? eligibleManualLinks({ ...assetIdentity, id: assetId }, links) : { eligible: [], unresolved: [] };
  const applicableIds = new Set(applicable.eligible.map(link => link.object_id));
  return <section className="mt-2 min-w-0 space-y-2 bg-slate-950 p-2">
    <h3 className="font-bold">Manuals for {assetName}</h3>
    <p className="text-sm text-slate-300">Choose the original once. Upload and use attaches the complete manual for this asset’s troubleshooting; reading text below is optional.</p>
    {previewReadOnly&&<p role="status" className="text-sm text-amber-200">Preview: full-document reading is available here. Uploads and saved reviews are blocked in this preview.</p>}
    <label className="grid gap-1 text-sm">Choose an existing PDF
      <select className={inputClass} value={objectId} disabled={busy} onChange={e=>{const id=e.target.value;setObjectId(id);setReview(null);if(id)void run("review",id);}}>
        <option value="">Select a PDF</option>{files.map(f=><option key={f.object_id} value={f.object_id}>{f.title}{links.some(link=>link.object_id===f.object_id)?" · Attached":""}</option>)}
      </select>
    </label>
    <label className="grid gap-1 text-sm">{sourceFile===undefined?'Upload a PDF (up to 100 MB)':'Choose a manual PDF (up to 100 MB) or label image'}<input ref={fileInput} className={inputClass} disabled={busy} type="file" accept={sourceFile===undefined?'application/pdf,.pdf':'.pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/png,image/jpeg,image/webp'} onChange={e=>setUpload(e.target.files?.[0]||null)}/></label>
    {upload&&<p className="break-all text-sm text-slate-300">Selected: {upload.name}</p>}
    {upload&&/\.pdf$/i.test(upload.name)&&<div className="flex flex-wrap gap-2"><button type="button" disabled={busy} onClick={()=>void run('upload',objectId,'confirmed_model')} className="rounded bg-cyan-700 px-3 py-2">Upload and use for troubleshooting</button><button type="button" disabled={busy} onClick={()=>void run('upload',objectId,'reference')} className="rounded border border-slate-600 px-3 py-2">Upload as reference</button></div>}
    {uploading&&<button type="button" onClick={()=>uploadController.current?.abort()} className="ml-2 rounded px-2 py-1">Cancel upload</button>}
    {review&&<fieldset disabled={busy} className="min-w-0 space-y-2">
      <a className="break-all text-cyan-300 underline" href={review.url} target="_blank" rel="noreferrer">Open {review.file.title}</a>
      {review.file.catalog_warnings?.map((warning,index)=><p key={index} role="alert" className="text-sm text-amber-100">{warning}</p>)}
      {review.file.catalog_status==="content_mismatch"&&<label className="flex gap-2 text-sm"><input type="checkbox" checked={fields.quarantine_acknowledged===true} onChange={e=>setFields({...fields,quarantine_acknowledged:e.target.checked})}/>I reviewed the warning and choose this PDF for this asset.</label>}
      <label className="grid gap-1 text-sm">Document title<input className={inputClass} value={fields.title} onChange={e=>setFields({...fields,title:e.target.value})}/></label>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={fields.applicability==="confirmed_model"} onChange={e=>setFields({...fields,applicability:e.target.checked?"confirmed_model":"reference",applicability_review:e.target.checked&&assetIdentity?{...assetIdentity,confirmed:true}:null})}/>Use this manual for this asset’s work-order troubleshooting</label>
      <details><summary className="cursor-pointer text-sm font-semibold">Optional model and serial details</summary>
        <label className="grid gap-1 text-sm">Manufacturer<input className={inputClass} value={fields.manufacturer} onChange={e=>setFields({...fields,manufacturer:e.target.value})}/></label>
        <label className="grid gap-1 text-sm">Models covered (one per line)<textarea className={inputClass} value={fields.models.join("\n")} onChange={e=>setFields({...fields,models:e.target.value.split("\n")})}/></label>
        <label className="grid gap-1 text-sm">Model for this asset<select className={inputClass} value={fields.selected_model} onChange={e=>setFields({...fields,selected_model:e.target.value})}><option value="">Not specified</option>{fields.models.filter(Boolean).map((m,i)=><option key={`${m}-${i}`} value={m}>{m}</option>)}</select></label>
        <label className="flex gap-2 text-sm"><input type="checkbox" checked={Boolean(fields.serial_range)} onChange={e=>setFields({...fields,serial_range:e.target.checked?{kind:"numeric",from:"",to:""}:null})}/>This manual has a numeric serial-number range</label>
        {fields.serial_range&&<div className="grid gap-2 sm:grid-cols-2">
          <label className="grid gap-1 text-sm">First serial number<input className={inputClass} inputMode="numeric" value={fields.serial_range.from} onChange={e=>setFields({...fields,serial_range:{kind:"numeric",from:e.target.value,to:fields.serial_range?.to||""}})}/></label>
          <label className="grid gap-1 text-sm">Last serial number<input className={inputClass} inputMode="numeric" value={fields.serial_range.to} onChange={e=>setFields({...fields,serial_range:{kind:"numeric",from:fields.serial_range?.from||"",to:e.target.value}})}/></label>
          <p className="text-xs text-amber-100 sm:col-span-2">Asset serial: {assetIdentity?.serial_number||"Not recorded"}. Range check: {serialRangeStatus(assetIdentity?.serial_number,fields.serial_range)}. A missing, nonnumeric, or out-of-range serial prevents this restricted manual from being used for troubleshooting.</p>
        </div>}
        <label className="grid gap-1 text-sm">Edition or serial notes<textarea className={inputClass} value={fields.notes} onChange={e=>setFields({...fields,notes:e.target.value})}/></label>
        {([['asset_type','Equipment type'],['model_family','Model family'],['serial_number','Serial number'],['generation','Generation'],['install_year','Install year']] as const).map(([key,label])=><label key={key} className="grid gap-1 text-sm">{label}<input className={inputClass} value={fields.extracted_fields?.[key]||""} onChange={e=>setFields({...fields,extracted_fields:{...fields.extracted_fields,[key]:e.target.value}})}/></label>)}
      </details>
      <button type="button" disabled={!fields.title.trim()||(review.file.catalog_status==="content_mismatch"&&!fields.quarantine_acknowledged)||(fields.applicability==="confirmed_model"&&!fields.applicability_review?.confirmed)} onClick={()=>void run("save")} className="rounded bg-cyan-700 px-3 py-2">{review.saved_fields?"Save manual changes":"Attach manual"}</button>
    </fieldset>}
    {links.length>0&&<div className="space-y-1"><h4 className="font-semibold">Attached manuals</h4>{links.map(l=><div key={l.object_id||l.document_id} className="flex flex-wrap items-center gap-2 text-sm">
      <button type="button" disabled={busy||!l.object_id} className="min-w-0 break-all text-left text-cyan-200 underline" onClick={()=>void run("review",l.object_id)}>{l.title}</button>
      <span>{applicableIds.has(l.object_id)&&(l.catalog_status!=="content_mismatch"||l.quarantine_acknowledged)?"Used for troubleshooting":"Reference only"}</span>
      <button type="button" disabled={busy||!l.object_id} onClick={()=>{if(window.confirm(`Remove ${l.title} from this asset? The original PDF will be kept.`))void run("unlink",l.object_id);}} className="text-sm underline">Remove</button>
    </div>)}</div>}
    {message&&<p role="status" className="text-sm text-amber-100">{message}</p>}
  </section>;
}
