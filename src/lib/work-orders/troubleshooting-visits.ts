"use client";

import { getValidSession } from "../supabase/client";

const CHANNEL = "cmpri-troubleshooting-visits";
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);

/** The page keeps this lease alive even when its guide is reloaded. */
export function registerActiveTroubleshootingVisit(visitId: string) {
  if (typeof BroadcastChannel === "undefined") return () => {};
  const channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = event => {
    if (event.data?.type === "probe" && event.data.visitId === visitId) channel.postMessage({ type: "active", visitId, requestId: event.data.requestId });
  };
  return () => channel.close();
}

async function activeElsewhere(visitId: string): Promise<boolean | null> {
  if (typeof BroadcastChannel === "undefined") return null;
  return new Promise(resolve => {
    const channel = new BroadcastChannel(CHANNEL);
    const requestId = crypto.randomUUID();
    const finish = (active: boolean) => { clearTimeout(timer); channel.close(); resolve(active); };
    const timer = setTimeout(() => finish(false), 250);
    channel.onmessage = event => {
      if (event.data?.type === "active" && event.data.visitId === visitId && event.data.requestId === requestId) finish(true);
    };
    channel.postMessage({ type: "probe", visitId, requestId });
  });
}

export type VisitFinalization = { ok: boolean; finalized: boolean; alreadyFinalized: boolean; eventCount: number; workOrderRevision: number | null };

class TroubleshootingVisit {
  private pending = new Set<Promise<unknown>>();
  private remembered = new Set<string>();
  private finalizing?: Promise<void>;
  private ended = false;
  private key: string;
  constructor(readonly visitId: string, readonly workOrderId: string, readonly userId: string, hotelId: string) {
    this.key = `cmpri:troubleshooting-visits:${hotelId}:${userId}:${workOrderId}`;
  }
  private references() {
    try {
      const parsed: unknown = JSON.parse(sessionStorage.getItem(this.key) || "[]");
      if (Array.isArray(parsed)) for (const value of parsed) if (uuid(value)) this.remembered.add(value);
    } catch { /* Server journals remain durable when browser storage is unavailable. */ }
    return [...this.remembered];
  }
  private store() {
    try {
      if (this.remembered.size) sessionStorage.setItem(this.key, JSON.stringify([...this.remembered]));
      else sessionStorage.removeItem(this.key);
    } catch { /* Keep the in-memory reference until a confirmed exit. */ }
  }
  remember() {
    if (this.ended) throw new Error("This editing visit has ended. Reopen the work order before recording more checks.");
    this.references(); this.remembered.add(this.visitId); this.store();
  }
  track<T>(work: Promise<T>): Promise<T> {
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work)).catch(() => {});
    return work;
  }
  hasChanges() { return this.references().includes(this.visitId); }
  async finalize(visitId: string) {
    const auth = await getValidSession();
    if (!auth?.access_token || auth.user.id !== this.userId) throw new Error("Sign in with the same account to save the troubleshooting exit note.");
    const response = await fetch(`/api/work-orders/${encodeURIComponent(this.workOrderId)}/troubleshooting/exit`, {
      method: "POST", headers: { Authorization: `Bearer ${auth.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ visitId }), cache: "no-store", keepalive: true,
    });
    const result = await response.json();
    if (!response.ok || result.finalized !== true) throw new Error(result.error || "The troubleshooting exit note could not be confirmed. Keep this work order open and retry.");
    this.references(); this.remembered.delete(visitId); this.store();
    return result as VisitFinalization;
  }
  async recoverLocal() {
    // A silent or delayed browser channel cannot prove that an earlier editor
    // has closed. Keep its durable reference for deliberate user recovery.
    this.references();
  }
  async recover(visitId: string) {
    if (!uuid(visitId)) throw new Error("A valid earlier editing visit is required.");
    if (await activeElsewhere(visitId) === true) throw new Error("That editing visit is still open in another window. Close it before recovering its summary.");
    return this.finalize(visitId);
  }
  flush() {
    if (this.finalizing) return this.finalizing;
    this.finalizing = (async () => {
      // Every mounted copy of this guide shares this set for the page visit.
      while (this.pending.size) await Promise.allSettled([...this.pending]);
      await this.recoverLocal();
      if (this.hasChanges()) await this.finalize(this.visitId);
      this.ended = true;
    })().finally(() => { this.finalizing = undefined; });
    return this.finalizing;
  }
}

const visits = new Map<string, TroubleshootingVisit>();
export function troubleshootingVisit(visitId: string, workOrderId: string, userId: string, hotelId: string) {
  const key = JSON.stringify([visitId, workOrderId, userId, hotelId]);
  let visit = visits.get(key);
  if (!visit) {
    visit = new TroubleshootingVisit(visitId, workOrderId, userId, hotelId);
    visits.set(key, visit);
  }
  return visit;
}
