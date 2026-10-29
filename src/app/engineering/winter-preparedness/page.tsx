"use client";
import { sharedFetch as fetch } from "@/lib/events/shared-fetch";
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { authorizationHeaders, loadCmpriSession } from '@/lib/auth/client-session';
import { canUseWinterPreparedness } from '@/lib/winter-preparedness-access';
import type { WinterItem } from '@/lib/winter-preparedness';
import WinterChecklist from './WinterChecklist';

async function readItems(): Promise<WinterItem[]> {
  const response = await fetch('/api/winter-preparedness', { headers: await authorizationHeaders(), cache: 'no-store' });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || 'Checklist storage is unavailable.');
  return payload.items;
}
export default function WinterPreparednessPage() {
  const router = useRouter();
  const [items, setItems] = useState<WinterItem[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void (async () => {
      const session = await loadCmpriSession();
      if (!canUseWinterPreparedness(session.user)) throw new Error('Winter Preparedness requires an authorized hotel account.');
      const saved = await readItems();
      if (active) setItems(saved);
    })().catch(cause => { if (active) setError(cause.message); });
    return () => { active = false; };
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
  return items ? <WinterChecklist initial={items} persist={persist} reload={readItems} onClose={close} />
    : <main className="p-6"><p role={error ? 'alert' : 'status'}>{error || 'Loading Winter Preparedness 2026…'}</p><button onClick={close}>Close</button>{error && <button onClick={() => window.location.reload()}>Retry</button>}</main>;
}
