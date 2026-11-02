import {associatedActivity, historyHref, workOrderHref, equipmentFormHref, equipmentLogHref, formPeriods, type Location, type Snapshot} from '@/lib/location-records';
function localDate(value: string | null | undefined) {
  if (!value) return 'Not recorded';
  const [y,m,d] = value.slice(0,10).split('-').map(Number);
  return y && m && d ? new Date(y,m-1,d).toLocaleDateString() : value;
}
export default function LocationActivity({snapshot, locations, area}: {snapshot: Snapshot; locations: Location[]; area?: string}) {
  const activity = associatedActivity(snapshot,locations,area);
  const today = new Date();
  const dateKey = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
  const current = activity.plans.filter(p => p.next_due_on && p.next_due_on <= dateKey);
  const upcoming = activity.plans.filter(p => p.next_due_on && p.next_due_on > dateKey);
  const undated = activity.plans.filter(p => !p.next_due_on);
  const planGroups = [{title:'Current / overdue PM',items:current},{title:'Upcoming PM',items:upcoming},...(undated.length ? [{title:'PM without a due date',items:undated}] : [])];
  const logGroups = [{title:'Current / past PM logs',items:activity.logs.filter(l=>l.period_start<=dateKey)},{title:'Upcoming PM logs',items:activity.logs.filter(l=>l.period_start>dateKey)}];
  return <div className="location-activity">
    <h3 className="font-bold">Preventive maintenance</h3>
    <div className="activity-columns compact-pm-columns">
      {planGroups.map(group => <section key={group.title}>
        <h4 className="text-sm font-semibold">{group.title} ({group.items.length})</h4>
        <div className="activity-records" tabIndex={0} aria-label={group.title}>
          {group.items.length ? group.items.map(plan => <article key={plan.id} data-plan-id={plan.id} className="compact-pm-row">
            <div className="font-semibold">{plan.title}</div>
            <div className="mt-1 text-xs text-slate-400">Due {localDate(plan.next_due_on)} · Every {plan.frequency_value} {plan.frequency_unit.toLowerCase()}</div>
            <div className="mt-1 text-xs text-slate-400">Last completed {localDate(plan.last_completed_on)}</div>
            {plan.description && !/quarterly guest.room preventive maintenance.*corporate|corporate CMPRI.*tracking workbook/i.test(plan.description) && <p className="mt-2 text-xs leading-5 text-slate-400">{plan.description}</p>}
          </article>) : <p className="text-sm text-slate-400">No {group.title.toLowerCase()} is linked to this selection.</p>}
        </div>
      </section>)}
    </div>
    {activity.forms.length > 0 && <section className="equipment-forms">
      <h4 className="text-sm font-semibold">Location & equipment PM forms ({activity.forms.length})</h4>
      <p className="text-xs text-slate-400">Source periods below; completion and overdue status require recorded dates.</p>
      <div className="activity-records compact-records" aria-label="Location equipment PM forms" tabIndex={0}>
        {activity.forms.map(form => {const periods=formPeriods(form,dateKey);const shared=snapshot.pm_logs.filter(log=>log.template_id===form.template_id&&!activity.logs.some(linked=>linked.id===log.id));return <div className="compact-pm-row" key={`${form.location_id}/${form.template_id}`} data-form-id={form.template_id} data-location-id={form.location_id}>
          <a className="record-link" href={equipmentFormHref(form)} target="_blank" rel="noopener">{form.title}</a>
          <div className="text-xs text-slate-400">{form.asset_names.join(', ') || snapshot.locations.find(l=>l.id===form.location_id)?.name}</div>
          <div className="text-xs text-slate-400">Current period {localDate(periods.current)} · Next {localDate(periods.next)}</div>
          {shared.length>0 && <details><summary className="text-xs text-slate-400">Shared source history ({shared.length})</summary><p className="text-xs text-slate-400">Recorded scope retained; these are not individual equipment completions.</p>{shared.map(log=><div className="compact-pm-row" key={log.id}><a className="record-link" href={equipmentLogHref(log.id)} target="_blank" rel="noopener">{localDate(log.period_start)}</a> <span className="text-xs text-slate-400">{log.status} · {log.scope_key}</span></div>)}</details>}
        </div>;})}
      </div>
    </section>}
    {activity.logs.length > 0 && <div className="activity-columns compact-pm-columns">
      {logGroups.filter(group=>group.items.length).map(group => <section key={group.title}>
        <h4 className="text-sm font-semibold">{group.title} ({group.items.length})</h4>
        <div className="activity-records compact-records" tabIndex={0} aria-label={group.title}>
          {group.items.map(log => <article key={log.id} className="compact-pm-row"><a className="record-link" href={equipmentLogHref(log.id)} target="_blank" rel="noopener">{localDate(log.period_start)} · {log.template_id.replace('pdf:','').replaceAll('-',' ')}</a><div className="text-xs text-slate-400">{log.status} · Source scope: {log.scope_key}</div>{activity.logLinks.filter(link=>link.log_id===log.id).map(link=><div className="text-xs text-slate-400" key={link.row_index}><a className="record-link" href={`${equipmentLogHref(log.id)}#row-${link.row_index}`} target="_blank" rel="noopener">{link.recorded_location}</a></div>)}</article>)}
        </div>
      </section>)}
    </div>}
    <section>
      <h4 className="text-sm font-semibold">PM completion records ({activity.completions.length})</h4>
      <div className="activity-records" tabIndex={0} aria-label="PM completion records">
        {activity.completions.length ? activity.completions.map(record => <article key={record.id} className="compact-pm-row">{localDate(record.completed_on)} · {record.completed_by_name || 'Technician not recorded'}{record.notes && <p>{record.notes}</p>}</article>) : <p className="text-sm text-slate-400">No completion records linked to these plans.</p>}
      </div>
    </section>
    <section>
      <h4 className="text-sm font-semibold">Room PM history ({activity.history.length})</h4>
      <div className="activity-records compact-records" tabIndex={0} aria-label="Room PM history">
        {activity.history.length ? activity.history.map(record => <div key={`${record.hotel_id}-${record.room}-${record.period_start}`} className="compact-history-row" data-history-key={`${record.hotel_id}/${record.room}/${record.period_start}`}><span className="text-xs text-slate-400">Room {record.room}</span><span>{record.completed_on ? <a className="record-link" href={historyHref(record)} target="_blank" rel="noopener" aria-label={`Open completed PM for Room ${record.room}, period ${localDate(record.period_start)}`}>{localDate(record.period_start)}</a> : <span>{localDate(record.period_start)}</span>}</span><span className="text-xs text-slate-400">{record.completed_on ? `Completed ${localDate(record.completed_on)}` : 'Completion not recorded'}</span></div>) : <p className="text-sm text-slate-400">No room history linked to this selection.</p>}
      </div>
    </section>
    <section>
      <h3 className="font-bold">Related work orders ({activity.tickets.length})</h3>
      <div className="activity-records compact-records" tabIndex={0} aria-label="Related work orders">
        {activity.tickets.length ? activity.tickets.map(order => <div key={order.id} data-ticket-id={order.id} className="compact-work-order-row"><a className="record-link" href={workOrderHref(order.id)} target="_blank" rel="noopener" title={order.issue || 'No issue description'}>{order.display_id || `Work order ${order.id.slice(0,8)}`} · {(order.issue || 'No issue description').length > 90 ? `${order.issue!.slice(0,87)}…` : order.issue || 'No issue description'}</a><span className="text-xs text-slate-400">{order.status || 'Status not recorded'}</span></div>) : <p className="text-sm text-slate-400">No tickets have a recorded link to this selection.</p>}
      </div>
    </section>
    {snapshot.equipment && <a className="record-link text-xs" href="/management/rooms/record?kind=unresolved" target="_blank" rel="noopener">Unresolved source relationships: {snapshot.equipment.counts.unmatched_logs} logs / {snapshot.equipment.counts.unresolved_rows} rows</a>}
  </div>;
}
