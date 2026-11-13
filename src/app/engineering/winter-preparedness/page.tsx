"use client";
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { authorizationHeaders, loadCmpriSession } from '@/lib/auth/client-session';
import { canUseWinterPreparedness } from '@/lib/winter-preparedness-access';
import type { WinterItem } from '@/lib/winter-preparedness';
import WinterChecklist from './WinterChecklist';

async function readItems(signal?: AbortSignal): Promise<{items:WinterItem[];preview_read_only:boolean}> {
  const response = await fetch('/api/winter-preparedness', { headers: await authorizationHeaders(), cache: 'no-store', signal });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || 'Checklist storage is unavailable.');
  if (!Array.isArray(payload.items)) throw new Error('Saved checklist progress could not be verified.');
  return payload;
}
export default function WinterPreparednessPage() {
  const router = useRouter();
  const [items, setItems] = useState<WinterItem[] | null>(null);
  const [error, setError] = useState('');
  const [readOnly, setReadOnly] = useState(false);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    void (async () => {
      const session = await loadCmpriSession();
      if (!canUseWinterPreparedness(session.user)) throw new Error('Winter Preparedness requires an authorized hotel account.');
      if (!active) return;
      const saved = await readItems(controller.signal);
      if (active) {setItems(saved.items);setReadOnly(saved.preview_read_only===true);}
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
  return items ? <WinterChecklist initial={items} persist={persist} reload={async()=>{const saved=await readItems();setReadOnly(saved.preview_read_only===true);return saved.items;}} onClose={close} readOnly={readOnly} />
    : <main className="p-6"><p role={error ? 'alert' : 'status'}>{error || 'Loading Winter Preparedness 2026…'}</p><button onClick={close}>Close</button>{error && <button onClick={() => window.location.reload()}>Retry</button>}</main>;
}
