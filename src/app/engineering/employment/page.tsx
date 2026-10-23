"use client";
import { useEffect, useState } from "react";
import { getValidSession } from "@/lib/supabase/client";
type Application = { id: string; created_at: string; name?: string; email?: string; answers?: Record<string, unknown> };
export default function EmploymentReview() {
  const [list,setList] = useState<Application[]>([]);
  const [selected,setSelected] = useState<Application|null>(null);
  const [message,setMessage] = useState("Loading private questionnaires…");
  async function load(id?: string) {
    const session = await getValidSession();
    if (!session) { setMessage("Sign in with your CMPRI work account to review questionnaires."); return; }
    try {
      const response = await fetch(`/api/employment${id ? `?id=${encodeURIComponent(id)}` : ""}`,{headers:{Authorization:`Bearer ${session.access_token}`},cache:"no-store"});
      if (!response.ok) { setList([]);setSelected(null);setMessage("Private work-account access required, or applications are temporarily unavailable.");return; }
      const data = await response.json();
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
    {selected ? <dl>{Object.entries(selected.answers || {}).map(([key,value])=><div key={key} style={{padding:"5px 0",borderBottom:"1px solid #344359"}}><dt style={{fontSize:12,color:"#b6c4d7"}}>{labels[key]||key}</dt><dd style={{margin:"2px 0",whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>{display(value)}</dd></div>)}</dl> : <div>{!message && list.length===0 && <p>No questionnaires yet.</p>}{list.map(item=><button key={item.id} onClick={()=>void load(item.id)} style={{display:"block",width:"100%",textAlign:"left",padding:"7px 4px",borderBottom:"1px solid #344359",overflowWrap:"anywhere"}}><strong>{item.name}</strong> · {item.email}<br/><small>{new Date(item.created_at).toLocaleString()}</small></button>)}</div>}
  </main>;
}

