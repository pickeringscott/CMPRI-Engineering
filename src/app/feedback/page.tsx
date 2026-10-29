"use client";
import { sharedFetch as fetch } from "@/lib/events/shared-fetch";
import { useResourceChange } from "@/lib/events/use-resource-change";

import { useCallback, useEffect, useState, type FormEvent, type MouseEvent } from "react";
import { useRouter } from "next/navigation";
import { getValidSession } from "@/lib/supabase/client";
import { hasCapability, loadCmpriSession, type CmpriClientSession } from "@/lib/auth/client-session";

type FeedbackStatus = "New" | "Reviewed" | "Planned" | "Resolved";
type FeedbackItem = {
  id: string;
  created_at: string;
  user_name: string;
  user_role: string;
  feedback_type: "Problem" | "Bug" | "Suggestion";
  description: string;
  page_route: string;
  app_version: string;
  status: FeedbackStatus;
  reviewed_at: string | null;
  resolved_at: string | null;
};

const STATUSES: FeedbackStatus[] = ["New", "Reviewed", "Planned", "Resolved"];

function formattedDate(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function originatingRoute() {
  const requested = new URLSearchParams(window.location.search).get("route");
  if (requested?.startsWith("/") && !requested.startsWith("//")) return requested.slice(0, 500);
  try {
    const referrer = new URL(document.referrer);
    if (referrer.origin === window.location.origin) return `${referrer.pathname}${referrer.search}`.slice(0, 500);
  } catch {}
  return window.location.pathname;
}

export default function FeedbackPage() {
  const router = useRouter();
  const [session, setSession] = useState<CmpriClientSession | null>(null);
  const [feedback, setFeedback] = useState<FeedbackItem[]>([]);
  const [feedbackType, setFeedbackType] = useState<FeedbackItem["feedback_type"]>("Problem");
  const [description, setDescription] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [updatingId, setUpdatingId] = useState("");

  const canSubmit = hasCapability(session, "submit_feedback");
  const canReview = hasCapability(session, "review_feedback");

  const authHeaders = useCallback(async (json = false) => {
    const auth = await getValidSession();
    if (!auth?.access_token) throw new Error("Sign in again to continue.");
    return {
      Authorization: `Bearer ${auth.access_token}`,
      ...(json ? { "Content-Type": "application/json" } : {}),
    };
  }, []);

  const loadFeedback = useCallback(async () => {
    const response = await fetch("/api/feedback", { headers: await authHeaders(), cache: "no-store" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !Array.isArray(payload.feedback)) throw new Error(payload.error || "Feedback could not be loaded.");
    setFeedback(payload.feedback as FeedbackItem[]);
  }, [authHeaders]);
  useResourceChange("feedback", () => { if (session && hasCapability(session,"review_feedback")) void loadFeedback(); });

  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const loaded = await loadCmpriSession();
        if (!current) return;
        setSession(loaded);
        if (!hasCapability(loaded, "submit_feedback") && !hasCapability(loaded, "review_feedback")) {
          setMessage("Your account cannot access feedback.");
          return;
        }
        if (hasCapability(loaded, "review_feedback")) {
          try { await loadFeedback(); }
          catch (error) { if (current) setMessage(error instanceof Error ? error.message : "Feedback could not be loaded."); }
        }
      } catch (error) {
        if (current) setMessage(error instanceof Error ? error.message : "Feedback is unavailable.");
      } finally {
        if (current) setLoading(false);
      }
    })();
    return () => { current = false; };
  }, [loadFeedback]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cleanDescription = description.trim();
    if (!cleanDescription || busy) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/feedback", {
        method: "POST",
        headers: await authHeaders(true),
        body: JSON.stringify({ feedback_type: feedbackType, description: cleanDescription, page_route: originatingRoute() }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Feedback could not be submitted.");
      setDescription("");
      setMessage("Thank you. Your feedback was submitted.");
      if (canReview) await loadFeedback();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Feedback could not be submitted.");
    } finally {
      setBusy(false);
    }
  }

  async function updateStatus(item: FeedbackItem, status: FeedbackStatus) {
    if (updatingId) return;
    setUpdatingId(item.id);
    setMessage("");
    try {
      const response = await fetch("/api/feedback", {
        method: "PATCH",
        headers: await authHeaders(true),
        body: JSON.stringify({ id: item.id, status }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Feedback status could not be updated.");
      setFeedback((current) => current.map((entry) => entry.id === item.id ? payload.feedback as FeedbackItem : entry));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Feedback status could not be updated.");
    } finally {
      setUpdatingId("");
    }
  }

  async function deleteFeedback(item: FeedbackItem) {
    if (updatingId) return;
    if (!window.confirm("Delete this feedback submission? This cannot be undone.")) return;
    setUpdatingId(item.id);
    setMessage("");
    try {
      const response = await fetch(`/api/feedback?id=${encodeURIComponent(item.id)}`, {
        method: "DELETE",
        headers: await authHeaders(),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Feedback could not be deleted.");
      setFeedback((current) => current.filter((entry) => entry.id !== item.id));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Feedback could not be deleted.");
    } finally {
      setUpdatingId("");
    }
  }

  function closeFeedback(event: MouseEvent<HTMLButtonElement>) {
    const params = new URLSearchParams(window.location.search);
    if (params.get("embedded") === "1" && window.parent !== window) {
      event.preventDefault();
      window.parent.postMessage({ type: "cmpri-modal-close", modalToken: params.get("modalToken") || "" }, window.location.origin);
      return;
    }
    if (window.parent !== window) {
      event.preventDefault();
      window.parent.postMessage({ type: "cmpri-modal-close", modalToken: "" }, window.location.origin);
      return;
    }
    event.preventDefault();
    router.push(session?.landing || "/");
  }

  return (
    <main className="h-full min-h-full w-full overflow-y-auto bg-slate-950 px-4 py-5 text-white sm:px-6 sm:py-6">
      <div className="mx-auto w-full max-w-none space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-400">CMPRI</p>
            <h1 className="mt-1 text-2xl font-bold">Feedback</h1>
          </div>
          <button type="button" data-cmpri-modal-ignore="true" onClick={closeFeedback} className="cmpri-embedded-modal-dashboard rounded-lg border border-slate-600 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800">Cancel</button>
        </header>

        {message && <p role="status" className="rounded-lg border border-slate-700 bg-slate-900 px-4 py-3 text-sm text-slate-200">{message}</p>}
        {loading ? <p role="status" className="text-sm text-slate-400">Loading feedback…</p> : canSubmit && (
          <section aria-labelledby="feedback-form-heading" className="space-y-4">
            <h2 id="feedback-form-heading" className="text-lg font-bold">Report a Problem / Suggestion</h2>
            <form onSubmit={submit} className="space-y-4">
              <label className="grid max-w-xl gap-1.5 text-sm font-semibold text-slate-300">
                Type
                <select value={feedbackType} onChange={(event) => setFeedbackType(event.target.value as FeedbackItem["feedback_type"])} disabled={busy} className="min-h-11 rounded-lg border border-slate-700 bg-slate-900 px-3 text-white">
                  <option value="Problem">Problem</option>
                  <option value="Bug">Bug</option>
                  <option value="Suggestion">Suggestion</option>
                </select>
              </label>
              <label className="grid gap-1.5 text-sm font-semibold text-slate-300">
                Description
                <textarea required maxLength={10000} rows={5} value={description} onChange={(event) => setDescription(event.target.value)} disabled={busy} className="w-full resize-y rounded-lg border border-slate-700 bg-slate-900 p-3 text-sm font-normal text-white placeholder:text-slate-500" placeholder="Describe the problem or suggestion" />
              </label>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="text-xs text-slate-500">{description.length}/10,000</span>
                <button type="submit" disabled={busy || !description.trim()} className="min-h-10 rounded-lg bg-amber-400 px-5 text-sm font-bold text-slate-950 disabled:opacity-50">{busy ? "Submitting…" : "Submit"}</button>
              </div>
            </form>
          </section>
        )}

        {canReview && (
          <section aria-labelledby="feedback-review-heading" className="space-y-3 border-t border-slate-800 pt-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="feedback-review-heading" className="text-lg font-bold">Submitted feedback</h2>
              <span className="text-sm text-slate-400">{feedback.filter((item) => item.status === "New").length} new</span>
            </div>
            {feedback.length === 0 ? <p className="text-sm text-slate-400">No feedback submissions yet.</p> : (
              <div className="divide-y divide-slate-800 border-y border-slate-800">
                {feedback.map((item) => (
                  <article key={item.id} className="grid gap-3 py-4 lg:grid-cols-[minmax(0,1fr)_auto]">
                    <div className="min-w-0 space-y-2">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                        <strong>{item.user_name}</strong>
                        <span className="text-slate-400">{item.user_role}</span>
                        <span className="text-slate-400">{formattedDate(item.created_at)}</span>
                        <span className="rounded-full border border-slate-700 px-2 py-0.5 text-xs text-slate-300">{item.feedback_type}</span>
                      </div>
                      <p className="whitespace-pre-wrap break-words text-sm text-slate-200">{item.description}</p>
                      <dl className="grid gap-x-4 gap-y-1 text-xs text-slate-400 sm:grid-cols-2">
                        <div><dt className="inline font-semibold text-slate-300">Page: </dt><dd className="inline break-all">{item.page_route}</dd></div>
                        <div><dt className="inline font-semibold text-slate-300">Version: </dt><dd className="inline">{item.app_version}</dd></div>
                        {item.reviewed_at && <div><dt className="inline font-semibold text-slate-300">Reviewed: </dt><dd className="inline">{formattedDate(item.reviewed_at)}</dd></div>}
                        {item.resolved_at && <div><dt className="inline font-semibold text-slate-300">Resolved: </dt><dd className="inline">{formattedDate(item.resolved_at)}</dd></div>}
                      </dl>
                    </div>
                    <div className="grid content-start gap-2">
                      <label className="grid gap-1 text-xs font-semibold text-slate-400">
                        Status
                        <select value={item.status} disabled={updatingId === item.id} onChange={(event) => void updateStatus(item, event.target.value as FeedbackStatus)} className="min-h-10 min-w-36 rounded-lg border border-slate-700 bg-slate-900 px-3 text-sm text-white disabled:opacity-50">
                          {STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}
                        </select>
                      </label>
                      <button type="button" disabled={updatingId === item.id} onClick={() => void deleteFeedback(item)} className="min-h-8 rounded-lg border border-red-500/50 bg-red-950/20 px-3 text-xs font-bold text-red-200 hover:bg-red-900/30 disabled:opacity-50">Delete</button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        )}
      </div>
    </main>
  );
}
