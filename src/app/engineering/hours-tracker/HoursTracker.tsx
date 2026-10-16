"use client";
import { useEffect, useRef, useState } from 'react';
import { NEW_WORK, PAYROLL_ANCHOR, emptyPeriod, dayTotals, periodDates, summarizePeriod, leaveBalance, leaveConfigurationAt, validateLeaveConfiguration, type HoursDay, type DatedLeaveConfiguration, type LeaveKind } from '@/lib/hours-tracker';
import type { HoursDocument, SavedHoursPeriod } from '@/lib/server/hours-tracker-store';
import styles from './hours.module.css';

export type SavedState = { document: HoursDocument; revision: number } | null;
const DAY = 86400000;
const iso = (time: number) => new Date(time).toISOString().slice(0,10);
const dateTime = (date: string) => Date.parse(date + 'T00:00:00Z');
const displayDate = (date: string, options: Intl.DateTimeFormatOptions = { month:'short', day:'numeric' }) => new Date(dateTime(date)).toLocaleDateString('en-US', { ...options, timeZone:'UTC' });
const hours = (minutes: number) => (minutes / 60).toFixed(2);
const dollars = (cents: number) => (cents / 100).toLocaleString('en-US',{style:'currency',currency:'USD'});
const newPeriod = (start: string, personalSetup = false): SavedHoursPeriod => ({ start, days:emptyPeriod(start), rateCents:personalSetup ? 0 : 2229, deductionPercent:personalSetup ? 0 : 22 });
function currentPeriod(today: string) { return iso(dateTime(PAYROLL_ANCHOR) + Math.floor((dateTime(today)-dateTime(PAYROLL_ANCHOR))/(14*DAY))*14*DAY); }
function range(start: string, end: string) { return displayDate(start) + '–' + displayDate(end, start.slice(0,7) === end.slice(0,7) ? {day:'numeric'} : {month:'short',day:'numeric'}); }

const DIGIT_SEGMENTS = ['abcdef','bc','abdeg','abcdg','bcfg','acdfg','acdefg','abc','abcdefg','abcdfg'];
const DIGIT_SHAPES = {a:'2,1 8,1 9,2 8,3 2,3 1,2',b:'8,3 9,2 10,3 10,8 9,9 8,8',c:'8,11 9,10 10,11 10,16 9,17 8,16',d:'2,17 8,17 9,18 8,19 2,19 1,18',e:'0,11 1,10 2,11 2,16 1,17 0,16',f:'0,3 1,2 2,3 2,8 1,9 0,8',g:'2,9 8,9 9,10 8,11 2,11 1,10'};
function TimeDigits({text}:{text:string}) {
  return <>{[...text].map((digit,index)=><svg key={index} className={styles.timeDigit} viewBox="0 0 10 20" aria-hidden="true" focusable="false">{Object.entries(DIGIT_SHAPES).map(([segment,points])=><polygon key={segment} className={DIGIT_SEGMENTS[Number(digit)].includes(segment)?styles.timeLit:styles.timeDim} points={points}/>)}</svg>)}</>;
}

function TimeField({ value, onChange, label }: { value:number; onChange:(value:number)=>void; label:string }) {
  const root=useRef<HTMLSpanElement>(null);
  const segments=useRef<(HTMLSpanElement|null)[]>([]);
  const part=useRef(0);
  const digits=useRef('');
  const lastKey=useRef(0);
  const lastWheel=useRef(-Infinity);
  const wheelRun=useRef(0);
  const wheelDirection=useRef(0);
  const latest=useRef({value,onChange});
  useEffect(()=>{latest.current={value,onChange};},[value,onChange]);
  const texts=[String(Math.floor(value/60)%12||12).padStart(2,'0'),String(value%60).padStart(2,'0'),value<720?'AM':'PM'];
  function disabled(){return !!root.current?.closest('fieldset:disabled');}
  function change(next:number){if(disabled())return;latest.current.value=next;latest.current.onChange(next);}
  function select(index=part.current){segments.current[index]?.focus();}
  function step(direction:number,accelerated=false){const amount=part.current===0?60:part.current===2?720:accelerated?5:1;change((latest.current.value+direction*amount+1440)%1440);}
  useEffect(()=>{
    // Listen at the document so wheel changes follow keyboard focus, not the pointer.
    const wheel=(event:WheelEvent)=>{
      const active=document.activeElement;
      if(!segments.current.some(element=>element===active)||root.current?.closest('fieldset:disabled')||!event.deltaY||event.ctrlKey)return;
      event.preventDefault();digits.current='';
      const now=performance.now(),direction=event.deltaY<0?1:-1;
      wheelRun.current=now-lastWheel.current<140&&direction===wheelDirection.current?wheelRun.current+1:1;
      wheelDirection.current=direction;lastWheel.current=now;
      const amount=part.current===0?60:part.current===2?720:wheelRun.current>=10?3:wheelRun.current>=5?2:1;
      const next=(latest.current.value+direction*amount+1440)%1440;
      latest.current.value=next;latest.current.onChange(next);
    };
    const blur=()=>{const active=segments.current.find(element=>element===document.activeElement);active?.blur();};
    document.addEventListener('wheel',wheel,{passive:false});window.addEventListener('blur',blur);
    return()=>{document.removeEventListener('wheel',wheel);window.removeEventListener('blur',blur);};
  },[]);
  return <><span ref={root} className={styles.desktopTime}>
    {texts.map((text,index)=><span key={index} className={styles.timePart}>
      {index===1&&<span className={styles.timeColon} aria-hidden="true">:</span>}
      <span ref={element=>{segments.current[index]=element;}} className={`${styles.timeSegment} ${index===2?styles.timeMeridiem:''}`} role="spinbutton" tabIndex={0} aria-label={`${label} ${['hour','minute','period'][index]}`} aria-valuemin={index===0?1:0} aria-valuemax={index===0?12:index===1?59:1} aria-valuenow={index===2?(value<720?0:1):Number(text)} aria-valuetext={text}
        onFocus={()=>{if(disabled()){segments.current[index]?.blur();return;}part.current=index;digits.current='';lastKey.current=0;lastWheel.current=-Infinity;wheelRun.current=0;wheelDirection.current=0;}}
        onKeyDown={event=>{
          if(disabled()||event.ctrlKey||event.metaKey||event.altKey)return;
          if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();select((index+(event.key==='ArrowRight'?1:2))%3);}
          else if(event.key==='ArrowUp'||event.key==='ArrowDown'){event.preventDefault();digits.current='';step(event.key==='ArrowUp'?1:-1,event.repeat);}
          else if(/^[ap]$/i.test(event.key)){event.preventDefault();change(latest.current.value%720+(event.key.toLowerCase()==='p'?720:0));select(2);}
          else if(/^\d$/.test(event.key)&&index<2){event.preventDefault();const now=performance.now();digits.current=now-lastKey.current<900?(digits.current+event.key).slice(-2):event.key;lastKey.current=now;const number=Number(digits.current),current=latest.current.value;if(index===0&&number>=1&&number<=12)change(Math.floor(current/720)*720+number%12*60+current%60);if(index===1&&number<60)change(Math.floor(current/60)*60+number);}
        }}>{index===2?text:<TimeDigits text={text}/>}</span>
    </span>)}
    <span className={styles.arrows}><button type="button" aria-label={`Increase ${label}`} onMouseDown={event=>event.preventDefault()} onClick={()=>{select();step(1);}}>▲</button><button type="button" aria-label={`Decrease ${label}`} onMouseDown={event=>event.preventDefault()} onClick={()=>{select();step(-1);}}>▼</button></span>
  </span><input className={styles.mobileTime} type="time" aria-label={`${label} mobile`} value={`${String(Math.floor(value/60)).padStart(2,'0')}:${String(value%60).padStart(2,'0')}`} onChange={event=>{if(event.target.value){const [hour,minute]=event.target.value.split(':').map(Number);onChange(hour*60+minute);}}}/></>;
}

export default function HoursTracker({ owner, initial, persist, onClose, requirePersonalSetup = false, today = new Date().toLocaleDateString('en-CA',{timeZone:'America/Chicago'}) }: { owner:string; initial:SavedState; persist:(body:unknown)=>Promise<NonNullable<SavedState>>; onClose:()=>void; requirePersonalSetup?:boolean; today?:string }) {
  const [saved,setSaved]=useState(initial);
  const [start,setStart]=useState(()=>currentPeriod(today));
  const [draft,setDraft]=useState(()=>structuredClone(initial?.document.periods.find(p=>p.start===currentPeriod(today))||newPeriod(currentPeriod(today),requirePersonalSetup)));
  const [week,setWeek]=useState(0);
  const [edit,setEdit]=useState<'rate'|'deduction'|null>(null);
  const [editValue,setEditValue]=useState('');
  const [message,setMessage]=useState('');
  const [busy,setBusy]=useState(false);
  const saving=useRef(false);
  const setupConfirmed=useRef({rate:false,deduction:false});
  const [decision,setDecision]=useState<null|{kind:'off'|'clear';index:number}|{kind:'rate';action?:{kind:'close'}|{kind:'period';start:string}}>(null);
  const [baselineEntered,setBaselineEntered]=useState(false);
  const [pending,setPending]=useState<null|{kind:'close'}|{kind:'period';start:string}>(null);
  const root=useRef<HTMLElement>(null);
  const [configuration,setConfiguration]=useState<DatedLeaveConfiguration|null>(null);
  const savedPeriod=saved?.document.periods.find(p=>p.start===start);
  const dirty=JSON.stringify(draft)!==JSON.stringify(savedPeriod||newPeriod(start,requirePersonalSetup)) || edit!==null || configuration!==null;
  const calendar=periodDates(start);
  let summary:ReturnType<typeof summarizePeriod>|null=null, validation='';
  try{summary=summarizePeriod(start,draft.days,draft.rateCents,draft.deductionPercent);}catch(error){validation=error instanceof Error?error.message:'Invalid time.';}
  const periods=[...new Set([start,...(saved?.document.periods.map(p=>p.start)||[]),...Array.from({length:54},(_,i)=>iso(dateTime(currentPeriod(today))+(2-i)*14*DAY))])].sort().reverse();
  function finish(action:NonNullable<typeof pending>){setPending(null);setEdit(null);setConfiguration(null);if(action.kind==='close')onClose();else{setupConfirmed.current={rate:false,deduction:false};setStart(action.start);setDraft(structuredClone(saved?.document.periods.find(p=>p.start===action.start)||newPeriod(action.start,requirePersonalSetup)));setWeek(0);setMessage('');}}
  function request(action:NonNullable<typeof pending>){if(saving.current)return;if(decision){setDecision(null);return;}if(dirty)setPending(action);else finish(action);}
  const closeRef=useRef(()=>request({kind:'close'}));
  useEffect(()=>{closeRef.current=()=>request({kind:'close'});});
  useEffect(()=>{
    const cancel=(event:Event)=>{event.preventDefault();closeRef.current();};
    const unload=(event:BeforeUnloadEvent)=>{if(dirty||saving.current){event.preventDefault();event.returnValue='';}};
    const key=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();if(decision)setDecision(null);else if(pending)setPending(null);else closeRef.current();}};
    document.addEventListener('cmpri-modal-cancel-request',cancel);window.addEventListener('beforeunload',unload);document.addEventListener('keydown',key);
    return()=>{document.removeEventListener('cmpri-modal-cancel-request',cancel);window.removeEventListener('beforeunload',unload);document.removeEventListener('keydown',key);};
  },[dirty,pending,decision,configuration]);
  function changeDay(index:number, change:Partial<HoursDay>){
    // Editing confirmed wall times returns this day to explicit manual calculation.
    const previous=draft.days[index].attendance;
    if(change.attendance?.state==='work'&&previous.state==='work'&&previous.clockSpan&&(change.attendance.start!==previous.start||change.attendance.end!==previous.end||change.attendance.nextDay!==previous.nextDay)){
      const {start,end,nextDay}=change.attendance;change={...change,attendance:{state:'work',start,end,nextDay}};
    }
    setMessage('');setDraft(current=>({...current,days:current.days.map((day,i)=>i===index?{...day,...change}:day)}));}
  function toggle(index:number){const day=draft.days[index];if(day.attendance.state==='work'){setDecision({kind:'off',index});return;}changeDay(index,{attendance:{...NEW_WORK}});}
  function commitNumber():SavedHoursPeriod|null{
    if(!edit)return draft;
    const number=Number(editValue);
    if(!editValue.trim()||!Number.isFinite(number)||number<0||(edit==='deduction'?number>100:number>10000)){setMessage('Enter a valid rate or deduction (0–100%).');return null;}
    setupConfirmed.current[edit]=true;
    const next={...draft,...(edit==='rate'?{rateCents:Math.round(number*100)}:{deductionPercent:number})};setDraft(next);setEdit(null);return next;
  }
  async function save(action?:NonNullable<typeof pending>, approvedRate=false){
    if(saving.current)return;
    const period=commitNumber();if(!period)return;
    if(requirePersonalSetup&&!savedPeriod&&(!setupConfirmed.current.rate||!setupConfirmed.current.deduction)){setMessage('Enter and confirm your own rate and deduction using edit before saving this new period.');return;}
    try{summarizePeriod(period.start,period.days,period.rateCents,period.deductionPercent);}catch(error){setMessage((error as Error).message);return;}
    const changedRate=!!savedPeriod&&savedPeriod.rateCents!==period.rateCents;
    if(changedRate&&!approvedRate){setDecision({kind:'rate',action});return;}
    saving.current=true;setBusy(true);setMessage('');
    try{const result=await persist({period,revision:saved?.revision||0,confirmRateChange:changedRate});setSaved(result);setMessage('Both weeks saved.');if(action){setPending(null);if(action.kind==='close')onClose();else{setupConfirmed.current={rate:false,deduction:false};setStart(action.start);setDraft(structuredClone(result.document.periods.find(p=>p.start===action.start)||newPeriod(action.start,requirePersonalSetup)));setWeek(0);}}}
    catch(error){setMessage((error as Error).message);}finally{saving.current=false;setBusy(false);}
  }
  function openConfiguration(kind:LeaveKind){if(dirty){setMessage('Save or cancel the period draft before configuring a dated leave bank.');return;}const coveredThrough=calendar.end;setBaselineEntered(false);setConfiguration({kind,date:iso(dateTime(coveredThrough)+DAY),coveredThrough,statementDate:calendar.payday,minutes:0,earnedMinutesPerWorkedHour:null,policy:'unconfigured',note:'',evidence:{earnedMinutes:null,carriedInMinutes:null,usedMinutes:null,benefitYearStart:null}});}
  async function saveConfiguration(){if(!configuration||saving.current)return;if(!baselineEntered){setMessage('Enter the documented available hours explicitly.');return;}if(configuration.policy==='manual'&&configuration.earnedMinutesPerWorkedHour===null){setMessage('Enter an explicit accrual rate, or leave policy unconfigured.');return;}try{validateLeaveConfiguration(configuration);}catch(error){setMessage((error as Error).message);return;}saving.current=true;setBusy(true);try{setSaved(await persist({configuration,revision:saved?.revision||0}));setConfiguration(null);setMessage('Dated leave configuration saved.');}catch(error){setMessage((error as Error).message);}finally{saving.current=false;setBusy(false);}}
    const modalOpen=!!pending||!!configuration||!!decision;
  useEffect(()=>{
    if(!modalOpen)return;
    const previous=document.activeElement as HTMLElement|null;
    const dialog=root.current?.querySelector<HTMLElement>('[role="dialog"]');
    const focusable=()=>Array.from(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)')||[]);
    focusable()[0]?.focus();
    const trap=(event:KeyboardEvent)=>{if(event.key!=='Tab')return;const items=focusable();const first=items[0],last=items.at(-1);if(!first)return;if(!dialog?.contains(document.activeElement)||(event.shiftKey&&document.activeElement===first)){event.preventDefault();(event.shiftKey?last:first)?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}};
    document.addEventListener('keydown',trap,true);
    return()=>{document.removeEventListener('keydown',trap,true);previous?.focus();};
  },[modalOpen,pending?.kind,decision?.kind]);
  const totals=summary?.weeks[week];
  return <main ref={root} className={styles.tracker} data-cmpri-modal-ignore="true" aria-label="Personal Hours Tracker">
    <header className={styles.header}><h1>Hours Tracker</h1><span>{owner}</span><button aria-label="Close Hours Tracker" onClick={()=>request({kind:'close'})}>×</button></header>
    <div className={styles.period}><select aria-label="Pay period" disabled={busy} value={start} onChange={e=>request({kind:'period',start:e.target.value})}>{periods.map(date=><option key={date} value={date}>Period {range(date,periodDates(date).end)} · {date.slice(0,4)}</option>)}</select><span>Pay date: {displayDate(calendar.payday,{weekday:'short',month:'short',day:'numeric'})}</span></div>
    <fieldset disabled={busy||!!pending||!!configuration||!!decision} className={styles.fields}>
    <div className={styles.estimate}>
      <div className={styles.rate}><strong>BIWEEKLY ESTIMATE</strong><span>Rate <span className={styles.numeric}>{edit==='rate'?<input autoFocus aria-label="Hourly rate" type="number" min="0" step="0.01" value={editValue} onChange={e=>setEditValue(e.target.value)} onBlur={()=>commitNumber()} onKeyDown={e=>{if(e.key==='Enter')commitNumber();if(e.key==='Escape'){e.stopPropagation();setEdit(null);}}}/>:<button onClick={()=>{if(edit&&!commitNumber())return;setEdit('rate');setEditValue((draft.rateCents/100).toFixed(2));}}>{dollars(draft.rateCents)}/h&nbsp; edit</button>}</span></span></div>
      <div><span>Gross</span><b>{summary?dollars(summary.grossCents):'—'}</b></div>
      <div><span>Deduction <span className={styles.numeric}>{edit==='deduction'?<input autoFocus aria-label="Deduction percent" type="number" min="0" max="100" step="0.1" value={editValue} onChange={e=>setEditValue(e.target.value)} onBlur={()=>commitNumber()} onKeyDown={e=>{if(e.key==='Enter')commitNumber();if(e.key==='Escape'){e.stopPropagation();setEdit(null);}}}/>:<button title="Total taxes and benefits estimate" onClick={()=>{if(edit&&!commitNumber())return;setEdit('deduction');setEditValue(String(draft.deductionPercent));}}>{draft.deductionPercent}%&nbsp; edit</button>}</span></span><b>{summary?dollars(summary.deductionCents):'—'}</b></div>
      <div className={styles.takehome}><span>Take-home</span><b>{summary?dollars(summary.takeHomeCents):'—'}</b></div>
    </div>
    <div className={styles.content}><section className={styles.week}>
      <div className={styles.tabs} role="tablist" aria-label="Weeks">{[0,1].map(index=><button key={index} role="tab" aria-selected={week===index} aria-controls="hours-week" id={`hours-tab-${index}`} onClick={()=>setWeek(index)}>Week {index+1} · {range(calendar.dates[index*7],calendar.dates[index*7+6])}</button>)}</div>
      <div role="tabpanel" id="hours-week" aria-labelledby={`hours-tab-${week}`}><table><colgroup><col className={styles.dayCol}/><col className={styles.scheduleCol}/><col className={styles.startCol}/><col className={styles.endCol}/><col className={styles.leaveCol}/><col className={styles.workedCol}/></colgroup><thead><tr>{['Day','Schedule','Start','End','Leave','Worked'].map(label=><th key={label}>{label}</th>)}</tr></thead><tbody>{draft.days.slice(week*7,week*7+7).map((day,offset)=>{
        const index=week*7+offset;const attendance=day.attendance;let worked:string='—';try{worked=hours(dayTotals(day).worked);}catch{}
        return <tr key={day.date} className={attendance.state==='off'?styles.off:''}><td><button className={styles.dayButton} title="Clear this day to unentered" onClick={()=>setDecision({kind:'clear',index})}>{displayDate(day.date,{weekday:'short'})+' '+Number(day.date.slice(-2))}</button></td><td><button type="button" className={styles.pill} aria-label={`${day.date} schedule: ${attendance.state==='blank'?'Unentered':attendance.state==='work'?'Work':'Day Off'}`} title={attendance.state==='blank'?'Unentered — click to enter Work':'Click to switch Day Off / Work'} onClick={()=>toggle(index)}><span data-active={attendance.state==='off'}>Day Off</span><span data-active={attendance.state==='work'}>Work</span></button></td><td>{attendance.state==='work'?<TimeField label={`${day.date} Start`} value={attendance.start} onChange={value=>changeDay(index,{attendance:{...attendance,start:value}})}/>:<span className={styles.dash}>—</span>}</td><td>{attendance.state==='work'?<><TimeField label={`${day.date} End`} value={attendance.end} onChange={value=>changeDay(index,{attendance:{...attendance,end:value}})}/>{(attendance.end<=attendance.start||attendance.nextDay)&&<label className={styles.overnight}><input type="checkbox" checked={attendance.nextDay} onChange={e=>changeDay(index,{attendance:{...attendance,nextDay:e.target.checked}})}/> Next day</label>}</>:<span className={styles.dash}>—</span>}</td><td className={styles.leaveCell}>{day.leave.map((entry,leaveIndex)=><div className={styles.leaveEntry} key={leaveIndex}><select aria-label={`${day.date} leave type ${leaveIndex+1}`} value={entry.kind} onChange={e=>{if(e.target.value==='remove'){changeDay(index,{leave:day.leave.filter((_,i)=>i!==leaveIndex)});return;}changeDay(index,{leave:day.leave.map((item,i)=>i===leaveIndex?{...item,kind:e.target.value as LeaveKind}:item)});}}><option value="company-pto">PTO</option><option value="illinois-sick">Sick</option><option value="remove">Remove</option></select><input aria-label={`${day.date} leave hours ${leaveIndex+1}`} type="number" min="0.01" max="24" step="0.25" value={entry.minutes/60||''} placeholder="h" onChange={e=>changeDay(index,{leave:day.leave.map((item,i)=>i===leaveIndex?{...item,minutes:Math.round(Number(e.target.value)*60)}:item)})}/></div>)}{day.leave.length<2&&<button className={styles.addLeave} aria-label={`Add leave ${day.date}`} onClick={()=>changeDay(index,{leave:[...day.leave,{kind:day.leave.some(item=>item.kind==='company-pto')?'illinois-sick':'company-pto',minutes:0}]})}>{day.leave.length?'+':'+ Leave'}</button>}</td><td>{attendance.state==='blank'&&!day.leave.length?'—':worked}</td></tr>;
      })}</tbody></table><p className={styles.weekTotals}>Worked {totals?hours(totals.worked):'—'}h · Leave {totals?hours(totals.leave):'—'}h · Paid {totals?hours(totals.paid):'—'}h</p></div>
    </section><aside className={styles.sidebar}>{[0,1].map(index=>{const item=summary?.weeks[index];return <section className={styles.goal} key={index}><div><strong>WEEK {index+1}</strong><b>{item?hours(item.worked):'—'} / 40h</b></div><div className={styles.bar} role="progressbar" aria-label={`Week ${index+1} goal`} aria-valuenow={item?.barPercent||0} aria-valuemax={100} aria-valuetext={`${item?.percent||0}%`}><span style={{width:`${item?.barPercent||0}%`,background:item?.goalMet?'#36c985':'#f44f70'}}/></div><div><span>{item?hours(item.remaining):'—'}h remaining</span><span>{item?Number(item.percent.toFixed(2)):'—'}%</span></div></section>;})}<div className={styles.combined}><span>Combined worked</span><b>{summary?hours(summary.worked):'—'}h</b></div><section className={styles.balances}><strong>LEAVE BALANCES</strong><p>As of {displayDate(calendar.end,{month:'short',day:'numeric',year:'numeric'})}</p>{(['company-pto','illinois-sick'] as const).map(kind=>{const baseline=leaveConfigurationAt(saved?.document.leaveConfigurations||[],kind,calendar.end);const balance=leaveBalance(kind,baseline,saved?.document.periods.flatMap(p=>p.days)||[],calendar.end);return <button key={kind} onClick={()=>openConfiguration(kind)} title="Configure dated baseline and explicit accrual policy"><span>{kind==='company-pto'?'Company PTO':'Illinois Sick'}</span><span>{balance===null?'Unconfigured':hours(balance)+'h'}</span></button>;})}<small>Dated, saved work only</small></section></aside></div></fieldset>
    {(message||validation||saved?.document.clock?.open)&&<p className={styles.message} role="status">{message||validation||(saved?.document.clock?.open ? `Clocked in ${saved.document.clock.open.date} at ${String(Math.floor(saved.document.clock.open.minute/60)).padStart(2,'0')}:${String(saved.document.clock.open.minute%60).padStart(2,'0')} Chicago time. No worked hours count until clock-out.` : '')}</p>}
    <footer className={styles.footer}><span>≥5h: auto 30m break · Estimate, not payroll</span><button disabled={busy} onClick={()=>request({kind:'close'})}>Cancel</button><button className={styles.save} disabled={busy||!!configuration||!!validation} onClick={()=>void save()}>{busy?'Saving…':'Save'}</button></footer>
    {pending&&!decision&&<div className={styles.scrim}><section role="dialog" aria-modal="true" aria-label="Unsaved Hours Tracker changes" className={styles.dialog}><h2>Unsaved changes</h2><p>Save both weeks, discard this draft, or keep editing.</p><p role="status">{message||validation}</p><div><button autoFocus onClick={()=>setPending(null)}>Keep editing</button><button disabled={busy} onClick={()=>finish(pending)}>Discard</button><button disabled={busy||!!validation||!!configuration} onClick={()=>void save(pending)}>Save and continue</button></div></section></div>}
    {configuration&&!pending&&!decision&&<div className={styles.scrim}><section role="dialog" aria-modal="true" aria-label="Dated leave configuration" className={styles.dialog}><h2>{configuration.kind==='company-pto'?'Company PTO':'Illinois Sick'} baseline</h2><p>Enter documented amounts. No employer policy is assumed. Saving replaces only this bank’s baseline on this replay date.</p><label>Statement date<input type="date" value={configuration.statementDate} onInput={e=>setConfiguration({...configuration,statementDate:e.currentTarget.value})}/></label><label>Work covered through<input type="date" value={configuration.coveredThrough} onInput={e=>{const date=e.currentTarget.value;if(date)setConfiguration({...configuration,coveredThrough:date,date:iso(dateTime(date)+DAY)});}}/></label><p>Replay begins {configuration.date}</p><label>Available hours<input type="number" step="0.01" value={baselineEntered?configuration.minutes/60:''} onChange={e=>{setBaselineEntered(e.target.value!=='');setConfiguration({...configuration,minutes:Number(e.target.value)*60});}}/></label><label>Accrual policy<select value={configuration.policy} onChange={e=>setConfiguration({...configuration,policy:e.target.value as 'manual'|'unconfigured',earnedMinutesPerWorkedHour:null})}><option value="unconfigured">Unconfigured</option><option value="manual">Explicit manual rate</option></select></label>{configuration.policy==='manual'&&<label>Minutes earned per worked hour<input type="number" min="0" step="any" value={configuration.earnedMinutesPerWorkedHour??''} onChange={e=>setConfiguration({...configuration,earnedMinutesPerWorkedHour:e.target.value===''?null:Number(e.target.value)})}/></label>}{(['earnedMinutes','carriedInMinutes','usedMinutes'] as const).map(key=><label key={key}>{key==='earnedMinutes'?'Earned':key==='carriedInMinutes'?'Carried in':'Used'} hours (optional)<input type="number" min="0" step="0.01" value={configuration.evidence[key]===null?'':configuration.evidence[key]/60} onChange={e=>setConfiguration({...configuration,evidence:{...configuration.evidence,[key]:e.target.value===''?null:Number(e.target.value)*60}})}/></label>)}<label>Benefit year start (optional)<input type="date" value={configuration.evidence.benefitYearStart||''} onInput={e=>setConfiguration({...configuration,evidence:{...configuration.evidence,benefitYearStart:e.currentTarget.value||null}})}/></label><label>Source / unresolved policy<textarea value={configuration.note} onChange={e=>setConfiguration({...configuration,note:e.target.value})}/></label><p role="status">{message}</p><div><button disabled={busy} onClick={()=>{setConfiguration(null);setMessage('');}}>Cancel</button><button disabled={busy} onClick={()=>void saveConfiguration()}>Save baseline</button></div></section></div>}
    {decision&&<div className={styles.scrim}><section role="dialog" aria-modal="true" aria-label="Confirm Hours Tracker change" className={styles.dialog}><h2>{decision.kind==='rate'?'Change this period’s rate?':decision.kind==='off'?'Mark Day Off?':'Clear this day?'}</h2><p>{decision.kind==='rate'?`Apply ${dollars(draft.rateCents)}/h only to ${range(start,calendar.end)}. Other periods keep their rates.`:decision.kind==='off'?`Remove start/end times for ${displayDate(draft.days[decision.index].date)}? Leave entries remain.`:'Remove this day’s attendance and leave and return it to unentered?'}</p><div><button onClick={()=>setDecision(null)}>Keep editing</button><button onClick={()=>{const confirmed=decision;setDecision(null);if(confirmed.kind==='rate')void save(confirmed.action,true);else changeDay(confirmed.index,confirmed.kind==='off'?{attendance:{state:'off'}}:{attendance:{state:'blank'},leave:[]});}}>Confirm</button></div></section></div>}
  </main>;
}





