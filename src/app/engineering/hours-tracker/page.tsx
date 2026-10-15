"use client";
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { authorizationHeaders, loadCmpriSession } from '@/lib/auth/client-session';
import { landingPath, profileCanUseHoursTracker, profileIsChiefEngineer, profileIsEstablishedHoursChief } from '@/lib/server/roles';
import HoursTracker, { type SavedState } from './HoursTracker';

export default function HoursTrackerPage() {
  const router = useRouter();
  const [loaded, setLoaded] = useState<{ owner: string; saved: SavedState; requirePersonalSetup: boolean; home: string } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void (async () => {
      const session = await loadCmpriSession();
      if (!profileCanUseHoursTracker(session.user)) throw new Error('Hours Tracker is private to an eligible signed-in account.');
      const response = await fetch('/api/hours-tracker', { headers: await authorizationHeaders(), cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Hours storage is unavailable.');
      if (active) setLoaded({ owner: session.user.name || session.user.role || 'My account', saved: payload.saved, requirePersonalSetup: !profileIsChiefEngineer(session.user) && !profileIsEstablishedHoursChief(session.user), home: landingPath(session.user.role) || '/' });
    })().catch(error => { if (active) setError(error.message); });
    return () => { active = false; };
  }, []);
  async function persist(body: unknown) {
    const response = await fetch('/api/hours-tracker', { method: 'PUT', headers: { ...await authorizationHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Hours could not be saved. Your draft is unchanged.');
    return payload.saved as NonNullable<SavedState>;
  }
  function close() {
    if (window.parent !== window) window.parent.postMessage({ type: 'cmpri-modal-close', modalToken: new URLSearchParams(window.location.search).get('modalToken') || '' }, window.location.origin);
    else router.push(loaded?.home || '/');
  }
  return loaded ? <HoursTracker owner={loaded.owner} initial={loaded.saved} requirePersonalSetup={loaded.requirePersonalSetup} persist={persist} onClose={close} /> : <main style={{background:'#050918',color:'#dce2eb',padding:16}}><p role={error ? 'alert' : 'status'}>{error || 'Loading private Hours Tracker…'}</p><button onClick={close}>Close</button></main>;
}

