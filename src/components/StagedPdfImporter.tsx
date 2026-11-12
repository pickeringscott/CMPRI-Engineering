"use client";
import {useEffect,useState} from "react";
import StoredPdfImporter from "./StoredPdfImporter";
export default function StagedPdfImporter(props:Parameters<typeof StoredPdfImporter>[0]&{legacyUpload:(file:File)=>void;legacyBusy:boolean}){
 const {token}=props;
 const [ready,setReady]=useState<boolean|null>(null),[error,setError]=useState(""),[file,setFile]=useState<File|null>(null);
 useEffect(()=>{let current=true;void(async()=>{try{const access=await token();const r=await fetch('/api/assets/documentation?mode=consolidation',{headers:{Authorization:`Bearer ${access}`},cache:'no-store'});const body=await r.json();if(!r.ok)throw Error(body.error||'Unable to check documentation availability.');if(current)setReady(body.ready===true);}catch(e){if(current)setError(e instanceof Error?e.message:'Unavailable');}})();return()=>{current=false;};},[token]);
 if(error)return <p role="alert">{error}</p>;
 if(ready===null)return <p role="status">Loading documentation controls…</p>;
 if(ready)return <StoredPdfImporter {...props}/>;
 const chosen=props.sourceFile===undefined?file:props.sourceFile;
 return <section><label>Choose manufacturer/equipment PDF<input type="file" accept="application/pdf,.pdf" onChange={e=>(props.onSourceFileChange||setFile)(e.target.files?.[0]||null)}/></label><button type="button" disabled={!chosen||props.legacyBusy} onClick={()=>chosen&&props.legacyUpload(chosen)}>Upload &amp; Read</button><p>Current documentation importer. Reopen this dialog after the scheduled consolidation to use multiple-PDF controls.</p></section>;
}

