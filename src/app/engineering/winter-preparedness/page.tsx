"use client";
import { useUiLanguage } from "@/components/UiLanguageProvider";
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { authorizationHeaders, loadCmpriSession } from '@/lib/auth/client-session';
import { canUseWinterPreparedness } from '@/lib/winter-preparedness-access';
import type { WinterItem } from '@/lib/winter-preparedness';
import WinterChecklist from './WinterChecklist';

async function readItems(signal?: AbortSignal): Promise<{items:WinterItem[];readOnlyMessage:string}> {
  const response = await fetch('/api/winter-preparedness', { headers: await authorizationHeaders(), cache: 'no-store', signal });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || 'Checklist storage is unavailable.');
  if (!Array.isArray(payload.items)) throw new Error('Saved checklist progress could not be verified.');
  const readOnlyMessage = payload.preview_read_only === true
    ? 'Preview: saved progress is shown. Checklist changes are blocked in this preview.'
    : payload.can_edit === false ? 'View-only access. Saved checklist progress is shown.' : '';
  return { items: payload.items, readOnlyMessage };
}
export default function WinterPreparednessPage() {
  const { t } = useUiLanguage();
  const router = useRouter();
  const [items, setItems] = useState<WinterItem[] | null>(null);
  const [error, setError] = useState('');
  const [readOnlyMessage, setReadOnlyMessage] = useState('');
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    void (async () => {
      const session = await loadCmpriSession();
      if (!canUseWinterPreparedness(session.user)) throw new Error('Winter Preparedness requires an authorized hotel account.');
      if (!active) return;
      const saved = await readItems(controller.signal);
      if (active) {setItems(saved.items);setReadOnlyMessage(saved.readOnlyMessage);}
    })().catch(cause => { if (active) setError(cause.message); });
    return () => { active = false; controller.abort(); };
  }, []);
  async function persist(body: { item_id: string; checked: boolean; revision: number }) {
    const response = await fetch('/api/winter-preparedness', { method: 'PATCH', headers: { ...await authorizationHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Change was not confirmed saved. Reload before retrying.');
    return payload.item as WinterItem;
  }
  function close() {
    if (window.parent !== window) window.parent.postMessage({ type: 'cmpri-modal-close', modalToken: new URLSearchParams(window.location.search).get('modalToken') || '' }, window.location.origin);
    else router.push('/engineering');
  }
  return items ? <WinterChecklist initial={items} persist={persist} reload={async()=>{const saved=await readItems();setReadOnlyMessage(saved.readOnlyMessage);return saved.items;}} onClose={close} readOnlyMessage={readOnlyMessage} />
    : <main className="p-6"><p role={error ? 'alert' : 'status'}>{error ? t(error) : t("Loading Winter Preparedness 2026…")}</p><button onClick={close}>{t("Close")}</button>{error && <button onClick={() => window.location.reload()}>{t("Retry")}</button>}</main>;
}
