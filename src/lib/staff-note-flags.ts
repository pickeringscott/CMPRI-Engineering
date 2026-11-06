import { HOTEL_TIME_ZONE } from './constants';
function localParts(date: Date, timezone: string) {
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(date);
  const get=(type:string)=>Number(parts.find(p=>p.type===type)?.value);
  return {year:get('year'),month:get('month'),day:get('day'),hour:get('hour'),minute:get('minute'),second:get('second')};
}
function localInstant(year:number,month:number,day:number,hour:number,timezone:string) {
  const target=Date.UTC(year,month-1,day,hour);let value=target;
  for(let n=0;n<3;n++){const p=localParts(new Date(value),timezone),difference=target-Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second);value+=difference;if(!difference)break}
  return new Date(value).toISOString();
}
/** Calendar days, not a 72-hour duration; six AM is after Chicago's DST transition. */
export function staffNoteFlagExpiry(createdAt:string,timezone=HOTEL_TIME_ZONE) {
  const p=localParts(new Date(createdAt),timezone),day=new Date(Date.UTC(p.year,p.month-1,p.day+3));
  return localInstant(day.getUTCFullYear(),day.getUTCMonth()+1,day.getUTCDate(),6,timezone);
}
export function staffNoteFlagCutoff(now=new Date(),timezone=HOTEL_TIME_ZONE) {
  const p=localParts(now,timezone),day=new Date(Date.UTC(p.year,p.month-1,p.day-(p.hour<6?3:2)));
  return localInstant(day.getUTCFullYear(),day.getUTCMonth()+1,day.getUTCDate(),0,timezone);
}
export type StaffFlagWindow={expiresAt:string;count:number};
export function staffNoteFlagWindows(notes:{created_at:string}[],now=new Date(),timezone=HOTEL_TIME_ZONE):StaffFlagWindow[]{
  const windows=new Map<string,number>();
  for(const note of notes){const expiresAt=staffNoteFlagExpiry(note.created_at,timezone);if(Date.parse(expiresAt)>now.getTime())windows.set(expiresAt,(windows.get(expiresAt)||0)+1)}
  return [...windows].sort(([a],[b])=>a.localeCompare(b)).map(([expiresAt,count])=>({expiresAt,count}));
}
