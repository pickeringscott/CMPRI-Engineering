"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { createClient, getValidSession } from "@/lib/supabase/client";

type Application = { id: string; created_at: string; name?: string; email?: string; department?: string; resumeName?: string | null; answers?: Record<string, unknown> };
const departmentName = (department: unknown) => department === "front" ? "Front Desk" : "Maintenance";
export default function EmploymentReview() {
  const [list, setList] = useState<Application[]>([]);
  const [selected, setSelected] = useState<Application | null>(null);
  const [message, setMessage] = useState("Loading private questionnaires…");
  const [resumeUrl, setResumeUrl] = useState<string | null>(null);
  const resumeRef = useRef<string | null>(null), generation = useRef(0), selectedId = useRef<string | null>(null);
  const releaseResume = useCallback(() => {
    generation.current++;
    if (resumeRef.current) URL.revokeObjectURL(resumeRef.current);
    resumeRef.current = null;
  }, []);
  const clearResume = useCallback(() => { releaseResume(); setResumeUrl(null); }, [releaseResume]);
  const load = useCallback(async (id?: string) => {
    clearResume();
    const version = generation.current, session = await getValidSession();
    if (version !== generation.current) return;
    if (!session) { setList([]); setSelected(null); setMessage("Sign in with your CMPRI work account to review questionnaires."); return; }
    try {
      const response = await fetch(`/api/employment${id ? `?id=${encodeURIComponent(id)}` : ""}`, { headers: { Authorization: `Bearer ${session.access_token}` }, cache: "no-store" });
      const data = await response.json(), current = await getValidSession();
      if (version !== generation.current || current?.user.id !== session.user.id) return;
      if (!response.ok) { setList([]); setSelected(null); setMessage("Private work-account access required, or applications are temporarily unavailable."); return; }
      selectedId.current = id || null;
      if (id) setSelected(data.application); else { setList(data.applications); setSelected(null); }
      setMessage(id && !data.application ? "Application unavailable." : "");
    } catch { if (version === generation.current) setMessage("Unable to load questionnaires. Please retry."); }
  }, [clearResume]);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    let initialized = false, lastIdentity: string | null = null;
    const { data } = createClient().auth.onAuthStateChange((_event, session) => {
      const next = session?.user.id || null;
      if (!initialized) { initialized = true; lastIdentity = next; return; }
      if (next === lastIdentity) return;
      lastIdentity = next;
      clearResume(); setSelected(null); setList([]); selectedId.current = null;
      if (next) queueMicrotask(() => void load()); else setMessage("Sign in with your CMPRI work account to review questionnaires.");
    });
    return () => { window.clearTimeout(timer); data.subscription.unsubscribe(); releaseResume(); };
  }, [load, clearResume, releaseResume]);
  async function openResume() {
    if (!selected) return;
    const id = selected.id;
    clearResume();
    const version = generation.current, session = await getValidSession();
    if (!session || version !== generation.current) return;
    try {
      const response = await fetch('/api/employment/resume?id=' + encodeURIComponent(id), { headers: { Authorization: `Bearer ${session.access_token}` }, cache: "no-store" });
      if (version !== generation.current) return;
      if (!response.ok) { setMessage("Attachment unavailable or access changed."); return; }
      const blob = await response.blob(), current = await getValidSession();
      if (current?.user.id !== session.user.id || version !== generation.current || selectedId.current !== id) return;
      resumeRef.current = URL.createObjectURL(blob); setResumeUrl(resumeRef.current); setMessage("");
    } catch { if (version === generation.current) setMessage("Unable to load the original PDF. Please retry."); }
  }
  function display(value: unknown): string {
    if (value === "Personally performed") return "Perform";
    if (Array.isArray(value)) return value.map(display).join(", ");
    if (value && typeof value === "object") return Object.entries(value).map(([key, v]) => `${key}: ${display(v)}`).join("\n");
    return String(value || "Not provided");
  }
  const labels: Record<string, string> = { department: "Department", name: "Full name", email: "Email address", phone: "Phone number", history: "Relevant work history / training", example: selected?.answers?.department === 'front' ? "Guest-service example" : "Repair example", workingDays: "Available working days", skills: "Tasks you have done", interview: "Interview days" };
  return <main style={{ maxWidth: 850, margin: "auto", padding: 12, color: "var(--cmpri-modal-text,#f4f6fa)", background: "var(--cmpri-modal-surface,#202020)", minHeight: "100vh" }}>
    <div data-cmpri-page-heading><h1 style={{ fontSize: 22, margin: "0 0 8px" }}>Candidate questionnaires</h1><p style={{ fontSize: 12, margin: "0 0 8px" }}>Private work-account review. Human review only.</p></div>
    <button onClick={() => void load()} className="rounded border px-3 py-1">{selected ? "Back to questionnaires" : "Refresh"}</button>
    <p role="status">{message}</p>
    {selected?.resumeName && <div className="my-3"><button onClick={() => void openResume()}>View original PDF: {selected.resumeName}</button>{resumeUrl && <div><button onClick={clearResume}>Close PDF</button><iframe title="Original résumé PDF" src={resumeUrl} style={{ width: '100%', height: '75vh' }} /></div>}</div>}
    {selected ? <dl>{Object.entries(selected.answers || {}).map(([key, value]) => <div key={key} style={{ padding: "5px 0", borderBottom: "1px solid var(--cmpri-outline,#555)" }}><dt style={{ fontSize: 12, color: "var(--cmpri-modal-muted,#a3a3a3)" }}>{labels[key] || key}</dt><dd style={{ margin: "2px 0", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{key === 'department' ? departmentName(value) : display(value)}</dd></div>)}</dl> : <div>{!message && list.length === 0 && <p>No questionnaires yet.</p>}{list.map(item => <button key={item.id} onClick={() => void load(item.id)} style={{ display: "block", width: "100%", textAlign: "left", padding: "7px 4px", borderBottom: "1px solid var(--cmpri-outline,#555)", overflowWrap: "anywhere" }}><small>{departmentName(item.department)}</small><br /><strong>{item.name}</strong> · {item.email}<br /><small>{new Date(item.created_at).toLocaleString()}</small></button>)}</div>}
  </main>;
}
