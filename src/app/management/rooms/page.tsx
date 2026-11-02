"use client";
import "./locations.css";
import {sharedFetch as fetch} from '@/lib/events/shared-fetch';
import {useResourceChange} from '@/lib/events/use-resource-change';
import {useCallback, useEffect, useMemo, useRef, useState, type FormEvent} from 'react';
import {getValidSession} from '@/lib/supabase/client';
import {hasCapability, loadCmpriSession} from '@/lib/auth/client-session';
import ModalDashboardLink from '@/components/ModalDashboardLink';
import useEmbeddedModal from '@/components/use-embedded-modal';
import LocationActivity from '@/components/LocationActivity';
import {displayName, groupedLocations, recordedOptions, type Location, type LocationInput, type Snapshot} from '@/lib/location-records';

const emptySnapshot: Snapshot = {locations:[],work_orders:[],pm_plans:[],pm_completions:[],room_history:[],pm_logs:[]};
const emptyDraft: LocationInput = {name:'',area:'',location_type:''};
function inputFor(location: Location): LocationInput { return {name:displayName(location),area:location.area || '',location_type:location.location_type || ''}; }

export default function RoomsPage() {
  const embedded=useEmbeddedModal();
  const [snapshot,setSnapshot] = useState<Snapshot>(emptySnapshot);
  const [locations,setLocations] = useState<Location[]>([]);
  const [selectedId,setSelectedId] = useState('');
  const [draft,setDraft] = useState<LocationInput>(emptyDraft);
  const [view,setView] = useState<'edit'|'add'|'area'>('edit');
  const [selectedArea,setSelectedArea] = useState('');
  const [canEdit,setCanEdit] = useState(false);
  const [pageAllowed,setPageAllowed] = useState(false);
  const [message,setMessage] = useState('');
  const [error,setError] = useState('');
  const [busy,setBusy] = useState(false);
  const [query,setQuery] = useState('');
  const detailRef = useRef<HTMLElement>(null);

  const load = useCallback(async () => {
    const session = await getValidSession();
    if (!session) { window.location.replace('/'); return; }
    const response = await fetch('/api/rooms',{headers:{Authorization:`Bearer ${session.access_token}`},cache:'no-store'});
    const result = await response.json() as Snapshot & {error?:string;can_edit?:boolean;source_locations?:Location[]};
    if (!response.ok) { setError(result.error || 'Locations could not be loaded.'); return; }
    const list = result.locations || [];
    setSnapshot({...emptySnapshot,...result,locations:result.source_locations || list});
    setLocations(list); setCanEdit(result.can_edit === true);
    setSelectedId(current => {
      const item = list.find(l => l.id === current) || groupedLocations(list)[0]?.locations[0];
      setDraft(item ? inputFor(item) : emptyDraft); return item?.id || '';
    });
  },[]);
  useResourceChange('rooms',()=>{if(!selectedId && view !== 'add') void load();});
  useEffect(()=>{
    let active=true;
    void loadCmpriSession().then(session=>{
      if(!active)return;
      if(!hasCapability(session,'view_engineering_operations')){window.location.replace(session.landing);return;}
      setPageAllowed(true);void load();
    }).catch(()=>{if(active)setError('Locations could not be loaded.');});
    return ()=>{active=false;};
  },[load]);
  useEffect(()=>{
    const details=detailRef.current;
    if(!pageAllowed || !details)return;
    // Measure all right-hand content, not the visible viewport. Only desktop CSS
    // consumes this cap; a shorter list keeps its natural height.
    const update=()=>details.parentElement?.style.setProperty('--location-details-height',`${details.getBoundingClientRect().height}px`);
    const observer=new ResizeObserver(update);
    observer.observe(details);update();
    return ()=>observer.disconnect();
  },[pageAllowed]);
  const options = useMemo(()=>recordedOptions(snapshot.locations),[snapshot.locations]);
  const groups = useMemo(()=>groupedLocations(locations),[locations]);
  const visibleGroups = useMemo(()=>groups.map(group=>({...group,locations:group.locations.filter(l=>`${displayName(l)} ${l.area || ''} ${l.location_type || ''}`.toLowerCase().includes(query.trim().toLowerCase()))})).filter(group=>group.locations.length),[groups,query]);
  const selected = locations.find(l=>l.id===selectedId);
  const areaLocations = locations.filter(l=>(l.area || '')===selectedArea);
  const guestCount = locations.filter(l=>l.location_type==='Guest Room').length;

  function revealDetails() { requestAnimationFrame(()=>detailRef.current?.scrollIntoView({block:'start'})); }
  function select(location: Location) {
    revealDetails();
    setSelectedId(location.id);setSelectedArea(location.area || '');setDraft(inputFor(location));setView('edit');setMessage('');setError('');
  }
  function add() {
    revealDetails();
    setDraft({...emptyDraft,area:options.areas.includes(selectedArea)?selectedArea:''});setView('add');setMessage('');setError('');
  }
  function expandArea(area: string) {
    revealDetails();
    setView(view==='area' && selectedArea===area?'edit':'area');setSelectedArea(area);setMessage('');setError('');
  }
  async function save(event: FormEvent) {
    event.preventDefault();if(!canEdit||busy||view==='area')return;
    setBusy(true);setError('');setMessage('');
    const adding=view==='add';
    try {
      const session=await getValidSession();if(!session)throw new Error('Your session has ended.');
      const response=await fetch('/api/rooms',{method:adding?'POST':'PATCH',headers:{'Content-Type':'application/json',Authorization:`Bearer ${session.access_token}`},body:JSON.stringify(adding?draft:{...draft,id:selectedId})});
      const result=await response.json() as {error?:string;location?:Location};
      if(!response.ok||!result.location)throw new Error(result.error || 'Location could not be saved.');
      const saved=result.location;
      setLocations(items=>adding?[...items,saved]:items.map(l=>l.id===saved.id?saved:l));
      setSelectedId(saved.id);setSelectedArea(saved.area || '');setDraft(inputFor(saved));setView('edit');setQuery('');
      setMessage(adding?`Added ${displayName(saved)}.`:`Saved changes to ${displayName(saved)}.`);
      revealDetails();
    } catch(err) {setError(err instanceof Error?err.message:'Location could not be saved.');}
    finally {setBusy(false);}
  }
  if(!pageAllowed)return <p role="status">{error || 'Loading locations…'}</p>;
  return <main className="locations-page bg-slate-950 text-white" aria-label="Manage Locations" tabIndex={0}>
    <header className="locations-header border-b border-slate-800">
      <div>{embedded?<div className="text-xl font-bold">Manage Locations</div>:<h1 className="text-xl font-bold">Manage Locations</h1>}<p className="text-xs text-slate-400">{locations.length} locations · {guestCount} guest rooms · {locations.length-guestCount} other locations</p></div>
      <div className="locations-header-actions"><ModalDashboardLink className="rounded-lg border border-slate-700 px-3 py-2 text-sm">Dashboard</ModalDashboardLink>{canEdit && <button type="button" onClick={add} disabled={busy} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-bold">Add location</button>}</div>
    </header>
    <div className="locations-layout">
      <nav className="locations-sidebar rounded-2xl border border-slate-800 bg-slate-900" aria-label="Locations by area">
        <label className="location-search text-xs text-slate-300">Find a location<input type="search" value={query} onChange={e=>setQuery(e.target.value)} className="min-h-10 rounded-lg border border-slate-700 bg-slate-950 px-3" /></label>
        {query && <p className="px-3 text-xs text-slate-400">Showing {visibleGroups.reduce((sum,g)=>sum+g.locations.length,0)} of {locations.length}</p>}
        {visibleGroups.map(group=><section key={group.area} data-area={group.area}>
          <button type="button" onClick={()=>expandArea(group.area)} aria-expanded={view==='area'&&selectedArea===group.area} aria-controls="location-detail" className="location-area-button border-b border-slate-800" disabled={busy}><span>{group.area || 'No recorded area'} ({group.locations.length})</span><span aria-hidden="true">{view==='area'&&selectedArea===group.area?'▾':'▸'}</span></button>
          {group.locations.map(location=><button key={location.id} type="button" data-location-id={location.id} aria-label={`Edit ${displayName(location)}`} aria-current={selectedId===location.id&&view==='edit'?'true':undefined} onClick={()=>select(location)} disabled={busy} className={`location-row block w-full border-b border-slate-800 px-3 py-2.5 text-left ${selectedId===location.id&&view==='edit'?'bg-indigo-950/45':'hover:bg-slate-800'}`}><div className="font-bold">{displayName(location)}</div><div className="text-xs text-slate-400">{location.location_type || 'Unclassified'}<span className="location-edit-label">Edit</span></div></button>)}
        </section>)}
        {!visibleGroups.length&&<p className="px-3 py-4 text-sm text-slate-400">No locations match.</p>}
      </nav>
      <section ref={detailRef} id="location-detail" className="locations-detail rounded-2xl border border-slate-800 bg-slate-900 p-4" aria-label="Location details" tabIndex={0}>
        {message&&<div role="status" className="location-message border border-slate-700 bg-slate-950">{message}</div>}
        {error&&<div role="alert" className="location-message border border-red-500/40 bg-red-950/30">{error}</div>}
        {view==='area'?<>
          <h2 className="text-xl font-bold">{selectedArea || 'No recorded area'} — PM & tickets</h2><p className="mt-1 text-xs text-slate-400">{areaLocations.length} locations · Only recorded relationships are shown.</p>
          <LocationActivity snapshot={snapshot} locations={areaLocations} area={selectedArea}/>
        </>:<>
          <h2 className="text-xl font-bold">{view==='add'?'Add location':selected?`Edit ${displayName(selected)}`:'Choose a location'}</h2>
          {(selected||view==='add')&&<form onSubmit={save}>
            <fieldset disabled={!canEdit||busy} className="location-fields mt-4 disabled:opacity-70">
              <label className="location-name-field grid gap-1 text-sm text-slate-300">Location name<input required maxLength={200} value={draft.name} onChange={e=>setDraft({...draft,name:e.target.value})} className="min-h-10 rounded-lg border border-slate-700 bg-slate-950 px-3" /></label>
              <label className="grid gap-1 text-sm text-slate-300">Location type<select required value={draft.location_type} onChange={e=>setDraft({...draft,location_type:e.target.value})} className="min-h-10 rounded-lg border border-slate-700 bg-slate-950 px-3"><option value="">Select a recorded type</option>{options.types.map(value=><option key={value} value={value}>{value}</option>)}</select></label>
              <label className="grid gap-1 text-sm text-slate-300">Area<select required value={draft.area} onChange={e=>setDraft({...draft,area:e.target.value})} className="min-h-10 rounded-lg border border-slate-700 bg-slate-950 px-3"><option value="">Select a recorded area</option>{options.areas.map(value=><option key={value} value={value}>{value}</option>)}</select></label>
            </fieldset>
            {view==='add'&&draft.location_type==='Guest Room'&&<p className="mt-2 text-xs text-slate-400">Enter the room number in the name, for example Room 501.</p>}
            <div className="location-form-actions mt-3"><button type="button" onClick={()=>{if(selected)select(selected);else setView('edit');}} disabled={busy} className="rounded-lg border border-slate-700 px-3 py-2 text-sm">Cancel</button>{canEdit&&<button type="submit" disabled={busy} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-bold disabled:opacity-60">{busy?'Saving…':view==='add'?'Add location':'Save changes'}</button>}</div>
          </form>}
          {view==='edit'&&selected&&<LocationActivity snapshot={snapshot} locations={[selected]}/>}
        </>}
      </section>
    </div>
  </main>;
}
