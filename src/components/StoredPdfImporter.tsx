"use client";
import { useEffect, useRef, useState } from "react";
import { eligibleManualLinks, type ManualApplicabilityReview } from "@/lib/manual-applicability";
import { pdfImportResponse, uploadPdfDirect } from "@/lib/pdf-direct-upload";
import type { PdfReview, StoredPdf } from "@/lib/stored-pdf-link";
import { pdfReviewSuggestions, type EquipmentSuggestions } from "@/lib/equipment-pdf-suggestions";
import { preservePdfReview, storedPdfStatusLabel } from "@/lib/stored-pdf-link";

type SavedLink = StoredPdf & PdfReview & { sha256: string; document_id?: string };
type Review = { file: StoredPdf; sha256: string; url: string; saved_fields: SavedLink | null; suggestions: EquipmentSuggestions | null; readable_text: boolean; updated_at: string; asset_identity: Omit<ManualApplicabilityReview, "confirmed"> };
const blank: PdfReview = { title:"", manufacturer:"", models:[], selected_model:"", applicability:"reference", notes:"", reason:"", extracted_fields:{} };

export default function StoredPdfImporter({ assetId, assetName, token, onSaved }: { assetId:string; assetName:string; token:()=>Promise<string | null>; onSaved:()=>void }) {
  const [files,setFiles]=useState<StoredPdf[]>([]), [links,setLinks]=useState<SavedLink[]>([]);
  const [objectId,setObjectId]=useState(""), [review,setReview]=useState<Review|null>(null), [fields,setFields]=useState<PdfReview>(blank);
  const [updatedAt,setUpdatedAt]=useState(""), [confirmed,setConfirmed]=useState(false), [busy,setBusy]=useState(true), [message,setMessage]=useState("");
  const [assetIdentity,setAssetIdentity]=useState<Review["asset_identity"]|null>(null);
  const [upload,setUpload]=useState<File|null>(null);
  const [uploading,setUploading]=useState(false);
  const running = useRef(false), uploadController = useRef<AbortController | null>(null), fileInput = useRef<HTMLInputElement | null>(null);
  const inputClass="min-h-10 w-full rounded border border-slate-600 bg-slate-900 p-2 text-sm";
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const access = await token();
        if (!access) throw new Error("Sign in again.");
        const response = await fetch(`/api/assets/documentation?mode=stored&asset_id=${encodeURIComponent(assetId)}`, { headers: { Authorization: `Bearer ${access}` }, cache: "no-store", signal: controller.signal });
        const result = await pdfImportResponse(response);
        if (controller.signal.aborted) return;
        setFiles(result.files); setLinks(result.links); setUpdatedAt(result.updated_at); setAssetIdentity(result.asset_identity);
      } catch (error) {
        if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : "PDFs could not be loaded.");
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    })();
    return () => controller.abort();
  }, [assetId, token]);
  async function request(form?:FormData, signal?:AbortSignal) {
    const access=await token(); if(!access) throw new Error("Sign in again.");
    const response=await fetch(form ? "/api/assets/documentation" : `/api/assets/documentation?mode=stored&asset_id=${encodeURIComponent(assetId)}`, {method:form?"POST":"GET",headers:{Authorization:`Bearer ${access}`},signal,...(form?{body:form}:{cache:"no-store" as const})});
    return pdfImportResponse(response);
  }
  async function load() {
    const result=await request();setFiles(result.files);setLinks(result.links);setUpdatedAt(result.updated_at);setAssetIdentity(result.asset_identity);
  }
  async function run(action:"load"|"review"|"upload"|"save"|"unlink", id=objectId) {
    if(running.current)return;running.current=true;setBusy(true);setMessage("");
    try {
      if(action==="load"){await load();setReview(null);setConfirmed(false);setMessage("Choose a stored PDF or upload another original.");return;}
      const form=new FormData();form.set("asset_id",assetId);form.set("import_action",action);form.set("object_id",id);
      form.set("expected_updated_at",updatedAt);form.set("reason",fields.reason);
      if(action==="upload"&&!upload)throw new Error("Choose a PDF.");
      if(action==="save") {
        if(!review||review.file.object_id!==id)throw new Error("Review the selected PDF first.");
        form.set("sha256",review.sha256);form.set("fields",JSON.stringify(fields));form.set("review_confirmed",String(confirmed));
      }
      let result;
      if(action==="upload"&&upload) {
        const controller=new AbortController();uploadController.current=controller;setUploading(true);
        result=await uploadPdfDirect(upload,assetId,f=>request(f,controller.signal),controller.signal,setMessage);
      } else result=await request(form);
      if(action==="review"||action==="upload") {
        const next=result as Review;
        setObjectId(next.file.object_id);setReview(next);setAssetIdentity(next.asset_identity);setUpdatedAt(next.updated_at);setConfirmed(false);
        // Re-reading the same document never replaces in-progress edits. Saved overrides
        // take priority when opening a different document; extracted candidates stay suggestions.
        const suggested=pdfReviewSuggestions(next.file.title,next.suggestions);
        const reviewedFields = preservePdfReview(review?.file.object_id||null,next.file.object_id,fields,next.saved_fields ? {...blank,...next.saved_fields} : null,suggested);
        setFields({ ...reviewedFields, applicability_review: reviewedFields.applicability === "confirmed_model" ? { ...next.asset_identity, confirmed: true } : null, quarantine_acknowledged: false });
        setMessage(next.readable_text?"Review the original and edit its fields. Model selection is yours.":"The PDF opens, but has no readable text. Enter and confirm applicability manually from the original.");
        if(action==="upload"){setUpload(null);if(fileInput.current)fileInput.current.value="";await load();}
      } else {
        await load();onSaved();setConfirmed(false);
        if(action==="unlink"){setReview(null);setObjectId("");setFields(blank);}
        setMessage(action==="unlink"?"Association removed. Original PDF and history preserved.":"Saved association and original file identity verified. Model applicability is recorded as your choice.");
      }
    } catch(error){setMessage(uploadController.current?.signal.aborted?"Upload cancelled. No association was saved. Retry the same file to reuse any original already received.":error instanceof Error?error.message:"PDF import failed.");}finally{uploadController.current=null;running.current=false;setUploading(false);setBusy(false);}
  }
  const applicable = assetIdentity ? eligibleManualLinks({ ...assetIdentity, id: assetId }, links) : { eligible: [], unresolved: [] };
  const applicableIds = new Set(applicable.eligible.map(link => link.object_id));
  return <section className="mt-4 space-y-3 rounded border border-slate-700 bg-slate-950 p-4">
    <h3 className="font-bold">PDFs for {assetName}</h3>
    <p className="text-sm text-slate-300">Attach all manuals for this equipment here. Adding a manual does not require a new asset. Stored files, saved links, and manuals confirmed for this physical machine are different stages. Work orders use the applicable linked manuals automatically when this asset is selected.</p>
    <p role="status" className="text-sm text-amber-100">{applicable.eligible.filter(link => (link.catalog_status !== "content_mismatch" || link.quarantine_acknowledged)).length} linked manual(s) have confirmed choices for this physical equipment. Other links remain references until reviewed; catalog completion alone does not make a guide ready.</p>
    {assetIdentity && <p className="text-sm">Equipment: {assetName} · {assetIdentity.manufacturer || "Manufacturer missing"} · {assetIdentity.model_number || assetIdentity.model_family || "Model missing"} · Serial: {assetIdentity.serial_number || "Not recorded"}</p>}
    <button type="button" disabled={busy} onClick={()=>void run("load")} className="rounded border px-3 py-2">Load stored PDFs and saved links</button>
    <label className="grid gap-1 text-sm">Existing PDF<select className={inputClass} value={objectId} disabled={busy} onChange={e=>{setObjectId(e.target.value);setReview(null);setConfirmed(false);}}><option value="">Choose a PDF</option>{files.map(f=><option key={f.object_id} value={f.object_id}>{f.title} — {links.some(link => link.object_id === f.object_id) ? "Linked" : "Stored, not linked"} — {storedPdfStatusLabel(f)}</option>)}</select></label>
    <button type="button" disabled={busy||!objectId} onClick={()=>void run("review")} className="rounded border px-3 py-2">Open / re-read selected PDF</button>
    <label className="grid gap-1 text-sm">Add another PDF (up to 100 MB)<input ref={fileInput} className={inputClass} disabled={busy} type="file" accept="application/pdf,.pdf" onChange={e=>setUpload(e.target.files?.[0]||null)}/></label>
    <button type="button" disabled={busy||!upload} onClick={()=>void run("upload")} className="rounded border px-3 py-2">Upload original for review</button>
    {uploading&&<button type="button" onClick={()=>uploadController.current?.abort()} className="ml-2 rounded border px-3 py-2">Cancel upload</button>}
    {review&&<fieldset disabled={busy} className="min-w-0 space-y-3">
      <p className="text-sm">{storedPdfStatusLabel(review.file)}. {links.some(link => link.object_id === review.file.object_id) ? "Linked to this equipment." : "Not linked to this equipment."}</p>
      {review.file.catalog_warnings?.map((warning, index) => <p key={index} role="alert" className="text-sm text-amber-100">{warning}</p>)}
      {review.file.catalog_status === "content_mismatch" && <p role="alert" className="text-sm text-amber-100">The catalog flagged this document. Read the reason above. You may deliberately choose it for this equipment by acknowledging the warning below; the catalog record itself will not be changed.</p>}
      {review.file.catalog_status === "content_mismatch" && <label className="flex gap-2 text-sm"><input type="checkbox" checked={fields.quarantine_acknowledged===true} onChange={e=>{setFields({...fields,quarantine_acknowledged:e.target.checked});setConfirmed(false);}}/>I read the catalog mismatch warning and deliberately choose this original for this asset.</label>}
      <a className="text-cyan-300 underline" href={review.url} target="_blank" rel="noreferrer">Open the selected original PDF</a>
      {review.suggestions?.manufacturer_source==="asset"&&<p className="text-xs text-amber-100">Manufacturer defaults to the existing equipment record, not extracted PDF text. Confirm it against the original. Model choices do not establish exact variant compatibility.</p>}
      {review.suggestions&&<p className="text-xs text-slate-400" style={{overflowWrap:"anywhere"}}>Review suggestions (unverified): {JSON.stringify(review.suggestions)}. Re-reading does not replace your edits.</p>}
      <label className="grid gap-1 text-sm">Document title<input className={inputClass} value={fields.title} onChange={e=>{setFields({...fields,title:e.target.value});setConfirmed(false);}}/></label>
      <label className="grid gap-1 text-sm">Manufacturer<input className={inputClass} value={fields.manufacturer} onChange={e=>{setFields({...fields,manufacturer:e.target.value});setConfirmed(false);}}/></label>
      {([['asset_type','Equipment type'],['model_family','Model family'],['serial_number','Serial number'],['generation','Generation'],['install_year','Install year']] as const).map(([key,label])=><label key={key} className="grid gap-1 text-sm">{label}<input className={inputClass} value={fields.extracted_fields?.[key]||""} onChange={e=>{setFields({...fields,extracted_fields:{...fields.extracted_fields,[key]:e.target.value}});setConfirmed(false);}}/></label>)}
      <label className="grid gap-1 text-sm">Models covered by this guide (one per line)<textarea className={inputClass} value={fields.models.join("\n")} onChange={e=>{setFields({...fields,models:e.target.value.split("\n")});setConfirmed(false);}}/></label>
      <label className="grid gap-1 text-sm">Model selected for this asset<select className={inputClass} value={fields.selected_model} onChange={e=>{setFields({...fields,selected_model:e.target.value});setConfirmed(false);}}><option value="">No exact model selected</option>{fields.models.filter(Boolean).map((m,i)=><option key={`${m}-${i}`} value={m}>{m}</option>)}</select></label>
      <label className="grid gap-1 text-sm">Applicability<select className={inputClass} value={fields.applicability} onChange={e=>{setFields({...fields,applicability:e.target.value as PdfReview["applicability"],applicability_review:e.target.value==="confirmed_model"&&assetIdentity?{...assetIdentity,confirmed:true}:null});setConfirmed(false);}}><option value="reference">General reference — exact compatibility unconfirmed</option><option value="confirmed_model">Use this manual for troubleshooting this physical asset</option></select></label>
      <p className="text-sm text-amber-100">You choose the manuals for this physical machine. Filenames and model numbers do not automatically link or exclude documents. The saved equipment model and serial number identify your choice; this app does not infer a serial range.</p>
      <label className="grid gap-1 text-sm">Notes / edition or serial restrictions (optional)<textarea className={inputClass} value={fields.notes} onChange={e=>{setFields({...fields,notes:e.target.value});setConfirmed(false);}}/></label>

      <label className="grid gap-1 text-sm">Reason for this link or correction<input className={inputClass} value={fields.reason} onChange={e=>setFields({...fields,reason:e.target.value})}/></label>
      <label className="flex gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>I chose this original for this physical asset and confirm whether it should be used for troubleshooting.</label>
      <button type="button" disabled={!confirmed||fields.reason.trim().length<5||(review.file.catalog_status==="content_mismatch"&&!fields.quarantine_acknowledged)||(fields.applicability==="confirmed_model"&&!fields.applicability_review?.confirmed)} onClick={()=>void run("save")} className="rounded bg-cyan-700 px-3 py-2">Save and verify association</button>
      {links.some(l=>l.object_id===objectId)&&<button type="button" disabled={fields.reason.trim().length<5} onClick={()=>void run("unlink")} className="ml-2 rounded border px-3 py-2">Remove this asset’s link</button>}
    </fieldset>}
    <p className="text-xs text-slate-400">Saved links: {links.length}. A completed catalog entry is not proof that its PDF is linked or ready for troubleshooting. Reviewing another manual keeps the other PDFs; removal affects the association only.</p>
    {links.length>0&&<label className="grid gap-1 text-sm">Reason for removing a saved link (original stays stored)<input className={inputClass} disabled={busy} value={fields.reason} onChange={e=>setFields({...fields,reason:e.target.value})}/></label>}
    {links.map(l=><div key={l.object_id || l.document_id} className="flex flex-wrap items-center gap-3"><button type="button" disabled={busy || !l.object_id} className="text-left text-sm text-cyan-200 underline" onClick={()=>void run("review",l.object_id)}>{applicableIds.has(l.object_id) && (l.catalog_status !== "content_mismatch" || l.quarantine_acknowledged) ? "Applicability reviewed: " : "Reference / unresolved: "}{l.title} — {l.selected_model||"general reference"} — {storedPdfStatusLabel(l)}</button>
      <button type="button" disabled={busy || !l.object_id} onClick={() => void run("review", l.object_id)} className="rounded border px-2 py-1 text-xs">Review manual choice</button>
      {l.catalog_warnings?.map((warning, index) => <p key={index} role="alert" className="w-full text-sm text-amber-100">{warning}</p>)}
      <button type="button" disabled={busy||!l.object_id||fields.reason.trim().length<5} onClick={()=>void run("unlink",l.object_id)} className="rounded border px-2 py-1 text-xs">Remove link</button></div>)}
    {message&&<p role="status" className="text-sm text-amber-100">{message}</p>}
  </section>;
}
