'use client';
import { useEffect, useRef, useState } from 'react';
import { WINTER_TASKS, WINTER_TASK_IDS, WINTER_YEAR, type WinterItem, type WinterTask } from '@/lib/winter-preparedness';
import styles from './winter.module.css';

export default function WinterChecklist({ initial, persist, reload, onClose }: {
  initial: WinterItem[];
  persist: (change: { item_id: string; checked: boolean; revision: number }) => Promise<WinterItem>;
  reload: () => Promise<WinterItem[]>;
  onClose: () => void;
}) {
  const [items, setItems] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('All changes saved.');
  const inFlight = useRef(false);
  useEffect(() => {
    const preventClose = (event: Event) => { if (inFlight.current) event.preventDefault(); };
    const preventUnload = (event: BeforeUnloadEvent) => { if (inFlight.current) event.preventDefault(); };
    document.addEventListener('cmpri-modal-cancel-request', preventClose);
    window.addEventListener('beforeunload', preventUnload);
    return () => { document.removeEventListener('cmpri-modal-cancel-request', preventClose); window.removeEventListener('beforeunload', preventUnload); };
  }, []);
  async function change(task: WinterTask, checked: boolean) {
    if (inFlight.current || error) return;
    inFlight.current = true; setBusy(true); setStatus('Saving change…');
    try {
      const saved = await persist({ item_id: task.id, checked, revision: items.find(item => item.item_id === task.id)?.revision || 0 });
      setItems(current => [...current.filter(item => item.item_id !== saved.item_id), saved]);
      setStatus('All changes saved.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Change was not confirmed saved. Reload before retrying.'); setStatus(''); }
    finally { inFlight.current = false; setBusy(false); }
  }
  async function refresh() {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true);
    try { setItems(await reload()); setError(''); setStatus('Latest saved progress loaded.'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not reload saved progress.'); }
    finally { inFlight.current = false; setBusy(false); }
  }
  function renderTask(task: WinterTask) {
    const saved = items.find(item => item.item_id === task.id);
    return <li key={task.id}>
      <label className={styles.task}>
        <input type="checkbox" aria-label={task.text} checked={saved?.checked || false} disabled={busy || !!error} onChange={event => void change(task, event.target.checked)} />
        <span className={styles.printBox} aria-hidden="true">{saved?.checked ? '✓' : ''}</span>
        <span>{task.text}</span>
      </label>
      {saved && <p className={styles.attribution}>Last changed by {saved.changed_by_name} · <time dateTime={saved.changed_at}>{new Date(saved.changed_at).toLocaleString()}</time></p>}
      {task.children && <ul>{task.children.map(renderTask)}</ul>}
    </li>;
  }
  return <main className={styles.page} data-winter-checklist>
    <div className={styles.toolbar}>
      <p>Shared hotel checklist · {items.filter(item => item.checked).length} / {WINTER_TASK_IDS.length} complete</p>
      <div><button disabled={busy} onClick={() => void refresh()}>Reload</button><button disabled={busy || !!error} onClick={() => window.print()}>Print</button><button disabled={busy} onClick={onClose}>Close</button></div>
    </div>
    <div className={styles.feedback}>
      {error ? <p role="alert">{error}</p> : <p role="status" aria-live="polite">{status}</p>}
    </div>
    <article className={styles.sheet}>
      <header><p className={styles.eyebrow}>Winter Preparedness {WINTER_YEAR}</p><h1>Winter Preparedness Checklist</h1><p>10.10.2026<br />V1<br />Maintenance &amp; IT -&gt; Additional Resources</p></header>
      <ul className={styles.list}>{WINTER_TASKS.map(renderTask)}</ul>
    </article>
  </main>;
}
