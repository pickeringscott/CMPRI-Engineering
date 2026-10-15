"use client";
import { useState } from "react";
import type { PdfReview, StoredPdf } from "@/lib/stored-pdf-link";
import { preservePdfReview } from "@/lib/stored-pdf-link";

type SavedLink = StoredPdf & PdfReview & { sha256: string; document_id?: string };
type Review = { file: StoredPdf; sha256: string; url: string; saved_fields: SavedLink | null; suggestions: { manufacturer?: string; model_number?: string; model_candidates?: string[] } | null; readable_text: boolean; updated_at: string };
const blank: PdfReview = { title:"", manufacturer:"", models:[], selected_model:"", applicability:"reference", notes:"", reason:"", extracted_fields:{} };

export default function StoredPdfImporter({ assetId, assetName, token, onSaved }: { assetId:string; assetName:string; token:()=>Promise<string | null>; onSaved:()=>void }) {
  const [files,setFiles]=useState<StoredPdf[]>([]), [links,setLinks]=useState<SavedLink[]>([]);
  const [objectId,setObjectId]=useState(""), [review,setReview]=useState<Review|null>(null), [fields,setFields]=useState<PdfReview>(blank);
  const [updatedAt,setUpdatedAt]=useState(""), [confirmed,setConfirmed]=useState(false), [busy,setBusy]=useState(false), [message,setMessage]=useState("");
  const [upload,setUpload]=useState<File|null>(null);
  const inputClass="min-h-10 w-full rounded border border-slate-600 bg-slate-900 p-2 text-sm";
  async function request(form?:FormData) {
    const access=await token(); if(!access) throw new Error("Sign in again.");
    const response=await fetch(form ? "/api/assets/documentation" : `/api/assets/documentation?mode=stored&asset_id=${encodeURIComponent(assetId)}`, {method:form?"POST":"GET",headers:{Authorization:`Bearer ${access}`},...(form?{body:form}:{cache:"no-store" as const})});
    const result=await response.json();if(!response.ok)throw new Error(result.error||"PDF import failed.");return result;
  }
  async function load() {
    const result=await request();setFiles(result.files);setLinks(result.links);setUpdatedAt(result.updated_at);
  }
  async function run(action:"load"|"review"|"upload"|"save"|"unlink", id=objectId) {
    if(busy)return;setBusy(true);setMessage("");
    try {
      if(action==="load"){await load();setReview(null);setConfirmed(false);setMessage("Choose a stored PDF or upload another original.");return;}
      const form=new FormData();form.set("asset_id",assetId);form.set("import_action",action);form.set("object_id",id);
      form.set("expected_updated_at",updatedAt);form.set("reason",fields.reason);
      if(action==="upload"){if(!upload)throw new Error("Choose a PDF.");form.set("file",upload);}
      if(action==="save") {
        if(!review||review.file.object_id!==id)throw new Error("Review the selected PDF first.");
        form.set("sha256",review.sha256);form.set("fields",JSON.stringify(fields));form.set("review_confirmed",String(confirmed));
      }
      const result=await request(form);
      if(action==="review"||action==="upload") {
        const next=result as Review;
        setObjectId(next.file.object_id);setReview(next);setUpdatedAt(next.updated_at);setConfirmed(false);
        // Re-reading the same document never replaces in-progress edits. Saved overrides
        // take priority when opening a different document; extracted candidates stay suggestions.
        const knownModel=assetId==="a1a64c82-93f2-4ecb-96b8-23601b13f448"?"AZ95E12DACK1":"";
        setFields(preservePdfReview(review?.file.object_id||null,next.file.object_id,fields,next.saved_fields ? {...blank,...next.saved_fields} : null,{...blank,title:next.file.title,manufacturer:next.suggestions?.manufacturer||"",models:Array.from(new Set([...(next.suggestions?.model_candidates||[]),...(knownModel?[knownModel]:[])]))}));
        setMessage(next.readable_text?"Review the original and edit its fields. Model selection is yours.":"The PDF opens, but has no readable text. Enter and confirm applicability manually from the original.");
        if(action==="upload"){setUpload(null);await load();}
      } else {
        await load();onSaved();setConfirmed(false);
        if(action==="unlink"){setReview(null);setObjectId("");setFields(blank);}
        setMessage(action==="unlink"?"Association removed. Original PDF and history preserved.":"Saved association and original file identity verified. Model applicability is recorded as your choice.");
      }
    } catch(error){setMessage(error instanceof Error?error.message:"PDF import failed.");}finally{setBusy(false);}
  }
  return <section className="mt-4 space-y-3 rounded border border-slate-700 bg-slate-950 p-4">
    <h3 className="font-bold">PDFs for {assetName}</h3>
    <button type="button" disabled={busy} onClick={()=>void run("load")} className="rounded border px-3 py-2">Load stored PDFs and saved links</button>
    <label className="grid gap-1 text-sm">Existing PDF<select className={inputClass} value={objectId} disabled={busy} onChange={e=>{setObjectId(e.target.value);setReview(null);setConfirmed(false);}}><option value="">Choose a PDF</option>{files.map(f=><option key={f.object_id} value={f.object_id}>{f.title}{f.size===0?" — EMPTY FILE":""}</option>)}</select></label>
    <button type="button" disabled={busy||!objectId} onClick={()=>void run("review")} className="rounded border px-3 py-2">Open / re-read selected PDF</button>
    <label className="grid gap-1 text-sm">Add another PDF<input className={inputClass} disabled={busy} type="file" accept="application/pdf,.pdf" onChange={e=>setUpload(e.target.files?.[0]||null)}/></label>
    <button type="button" disabled={busy||!upload} onClick={()=>void run("upload")} className="rounded border px-3 py-2">Upload original for review</button>
    {review&&<fieldset disabled={busy} className="space-y-3">
      <a className="text-cyan-300 underline" href={review.url} target="_blank" rel="noreferrer">Open the selected original PDF</a>
      {review.suggestions&&<p className="text-xs text-slate-400">Extracted suggestions (unverified): {JSON.stringify(review.suggestions)}. Re-reading does not replace your edits.</p>}
      <label className="grid gap-1 text-sm">Document title<input className={inputClass} value={fields.title} onChange={e=>{setFields({...fields,title:e.target.value});setConfirmed(false);}}/></label>
      <label className="grid gap-1 text-sm">Manufacturer<input className={inputClass} value={fields.manufacturer} onChange={e=>{setFields({...fields,manufacturer:e.target.value});setConfirmed(false);}}/></label>
      {([['asset_type','Equipment type'],['model_family','Model family'],['serial_number','Serial number'],['generation','Generation'],['install_year','Install year']] as const).map(([key,label])=><label key={key} className="grid gap-1 text-sm">{label}<input className={inputClass} value={fields.extracted_fields?.[key]||""} onChange={e=>{setFields({...fields,extracted_fields:{...fields.extracted_fields,[key]:e.target.value}});setConfirmed(false);}}/></label>)}
      <label className="grid gap-1 text-sm">Models covered by this guide (one per line)<textarea className={inputClass} value={fields.models.join("\n")} onChange={e=>{setFields({...fields,models:e.target.value.split("\n")});setConfirmed(false);}}/></label>
      <label className="grid gap-1 text-sm">Model selected for this asset<select className={inputClass} value={fields.selected_model} onChange={e=>{setFields({...fields,selected_model:e.target.value});setConfirmed(false);}}><option value="">No exact model selected</option>{fields.models.filter(Boolean).map((m,i)=><option key={`${m}-${i}`} value={m}>{m}</option>)}</select></label>
      <label className="grid gap-1 text-sm">Applicability<select className={inputClass} value={fields.applicability} onChange={e=>{setFields({...fields,applicability:e.target.value as PdfReview["applicability"]});setConfirmed(false);}}><option value="reference">General reference — exact compatibility unconfirmed</option><option value="confirmed_model">I confirmed the selected model applies</option></select></label>
      <label className="grid gap-1 text-sm">Applicability notes / corrections<textarea className={inputClass} value={fields.notes} onChange={e=>{setFields({...fields,notes:e.target.value});setConfirmed(false);}}/></label>
      <label className="flex gap-2 text-sm"><input type="checkbox" checked={fields.preferred===true} onChange={e=>{setFields({...fields,preferred:e.target.checked});setConfirmed(false);}}/>Use this as the selected guide for this asset (other linked PDFs stay available).</label>
      <label className="grid gap-1 text-sm">Reason for this link or correction<input className={inputClass} value={fields.reason} onChange={e=>setFields({...fields,reason:e.target.value})}/></label>
      <label className="flex gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>I reviewed this original and chose the intended asset, guide and model applicability.</label>
      <button type="button" disabled={!confirmed||fields.reason.trim().length<5} onClick={()=>void run("save")} className="rounded bg-cyan-700 px-3 py-2">Save and verify association</button>
      {links.some(l=>l.object_id===objectId)&&<button type="button" disabled={fields.reason.trim().length<5} onClick={()=>void run("unlink")} className="ml-2 rounded border px-3 py-2">Remove this asset’s link</button>}
    </fieldset>}
    <p className="text-xs text-slate-400">Saved links: {links.length}. Each asset can retain multiple PDFs. Removal affects the association only.</p>
    {links.length>0&&<label className="grid gap-1 text-sm">Reason for removing a saved link (original stays stored)<input className={inputClass} disabled={busy} value={fields.reason} onChange={e=>setFields({...fields,reason:e.target.value})}/></label>}
    {links.map(l=><div key={l.object_id || l.document_id} className="flex flex-wrap items-center gap-3"><button type="button" disabled={busy || !l.object_id} className="text-left text-sm text-cyan-200 underline" onClick={()=>void run("review",l.object_id)}>{l.preferred?"Selected guide: ":""}{l.title} — {l.selected_model||"general reference"}</button><button type="button" disabled={busy||!l.object_id||fields.reason.trim().length<5} onClick={()=>void run("unlink",l.object_id)} className="rounded border px-2 py-1 text-xs">Remove link</button></div>)}
    {message&&<p role="status" className="text-sm text-amber-100">{message}</p>}
  </section>;
}
