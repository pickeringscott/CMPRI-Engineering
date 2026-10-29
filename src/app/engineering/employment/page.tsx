"use client";
import { sharedFetch as fetch } from "@/lib/events/shared-fetch";
import { useResourceChange } from "@/lib/events/use-resource-change";
import { useEffect, useState, useRef } from "react";
import { createClient, getValidSession } from "@/lib/supabase/client";
type Application = { id: string; created_at: string; name?: string; email?: string; department?:string; resumeName?: string|null; answers?: Record<string, unknown> };
export default function EmploymentReview() {
  useResourceChange("employment", () => { void load(selected?.id); });
  const [resumeUrl,setResumeUrl]=useState<string|null>(null);
  const resumeRef=useRef<string|null>(null);
  const generation=useRef(0);
  const selectedId=useRef<string|null>(null);
  function clearResume(){generation.current++;if(resumeRef.current)URL.revokeObjectURL(resumeRef.current);resumeRef.current=null;setResumeUrl(null);}
  useEffect(()=>{let identity:string|null=null;const {data}=createClient().auth.onAuthStateChange((_event,session)=>{const next=session?.user.id||null;if(identity!==next){identity=next;generation.current++;if(resumeRef.current)URL.revokeObjectURL(resumeRef.current);resumeRef.current=null;setResumeUrl(null);setSelected(null);setList([]);selectedId.current=null;if(next)queueMicrotask(()=>void load());}});return ()=>{generation.current++;data.subscription.unsubscribe();if(resumeRef.current)URL.revokeObjectURL(resumeRef.current);};},[]);
  async function openResume(){
   if(!selected)return;const requestId=selected.id;clearResume();const version=generation.current;const session=await getValidSession();if(!session)return;
   try {const response=await fetch('/api/employment/resume?id='+encodeURIComponent(selected.id),{headers:{Authorization:`Bearer ${session.access_token}`},cache:'no-store'});
   if(!response.ok){setMessage('Attachment unavailable or access changed.');return;}
   const blob=await response.blob();const current=await getValidSession();if(current?.user.id!==session.user.id||version!==generation.current||selectedId.current!==requestId)return;
   const url=URL.createObjectURL(blob);resumeRef.current=url;setResumeUrl(url);
   }catch{if(version===generation.current)setMessage('Unable to load the original PDF. Please retry.');}
  }
  const [list,setList] = useState<Application[]>([]);
  const [selected,setSelected] = useState<Application|null>(null);
  const [message,setMessage] = useState("Loading private questionnaires…");
  async function load(id?: string) {
    clearResume();const version=generation.current;
    const session = await getValidSession();
    if (!session) { setMessage("Sign in with your CMPRI work account to review questionnaires."); return; }
    try {
      const response = await fetch(`/api/employment${id ? `?id=${encodeURIComponent(id)}` : ""}`,{headers:{Authorization:`Bearer ${session.access_token}`},cache:"no-store"});
      if (!response.ok) { setList([]);setSelected(null);setMessage("Private work-account access required, or applications are temporarily unavailable.");return; }
      const data = await response.json();
      const current=await getValidSession();if(version!==generation.current||current?.user.id!==session.user.id)return;
      selectedId.current=id||null;
      if(id) setSelected(data.application); else { setList(data.applications);setSelected(null); }
      setMessage("");
    } catch {setMessage("Unable to load questionnaires. Please retry.");}
  }
  useEffect(()=>{const timer = window.setTimeout(()=>void load(),0);return ()=>window.clearTimeout(timer);},[]);
  function display(value: unknown): string {
    if(value === "Personally performed") return "Perform";
    if(Array.isArray(value)) return value.map(display).join(", ");
    if(value && typeof value === "object") return Object.entries(value).map(([key,v])=>`${key}: ${display(v)}`).join("\n");
    return String(value || "Not provided");
  }
  const labels: Record<string,string> = {name:"Full name",email:"Email address",phone:"Phone number",history:"Relevant work history / training",example:"Repair example",workingDays:"Available working days",skills:"Tasks you have done",interview:"Interview days"};
  return <main style={{maxWidth:850,margin:"auto",padding:12,color:"#f4f6fa",background:"#101b2b",minHeight:"100vh"}}>
    <h1 style={{fontSize:22,margin:"0 0 8px"}}>Candidate questionnaires</h1>
    <p style={{fontSize:12,margin:"0 0 8px"}}>Private work-account review. Human review only.</p>
    <button onClick={()=>void load()} className="rounded border px-3 py-1">{selected ? "Back to questionnaires" : "Refresh"}</button>
    <p role="status">{message}</p>
    {selected?.resumeName && <div className="my-3"><button onClick={()=>void openResume()}>View original PDF: {selected.resumeName}</button>{resumeUrl && <div><button onClick={clearResume}>Close PDF</button><iframe title="Original résumé PDF" src={resumeUrl} style={{width:'100%',height:'75vh'}} /></div>}</div>}
    {selected ? <dl>{Object.entries(selected.answers || {}).map(([key,value])=><div key={key} style={{padding:"5px 0",borderBottom:"1px solid #344359"}}><dt style={{fontSize:12,color:"#b6c4d7"}}>{labels[key]||key}</dt><dd style={{margin:"2px 0",whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>{display(value)}</dd></div>)}</dl> : <div>{!message && list.length===0 && <p>No questionnaires yet.</p>}{list.map(item=><button key={item.id} onClick={()=>void load(item.id)} style={{display:"block",width:"100%",textAlign:"left",padding:"7px 4px",borderBottom:"1px solid #344359",overflowWrap:"anywhere"}}><small>{item.department==='front'?'Front Desk':'Maintenance'}</small><br/><strong>{item.name}</strong> · {item.email}<br/><small>{new Date(item.created_at).toLocaleString()}</small></button>)}</div>}
  </main>;
}

