import {loyaltyTier} from "./loyalty-tier";
import { pmsTable, normalizePrintedDate, normalizePrintedTime, hotelDateAt, checkoutDeadlinePassed } from "./room-operations-reports";

/** JSONB may reorder object keys. Identity must survive a database round trip. */
export function guestReportIdentity(value:unknown):string{
  const canonical=(item:unknown):unknown=>Array.isArray(item)?item.map(canonical):item&&typeof item==="object"?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b)).map(([key,v])=>[key,canonical(v)])):item;
  return JSON.stringify(canonical(value));
}
export type GuestReportKind="guests"|"arrivals"|"departures";
export type GuestReport={kind:GuestReportKind;name:string;date:string;time:string;rows:Record<string,string>[]};
export type GuestRoom=Record<string,unknown>&{room:string;guest_name:string;room_status:string;checkout_date:string|null;checkout_time:string|null};
export function guestDisplayName(value:string){
  const parts=value.trim().split(/,\s*/);
  return (parts.length===2?`${parts[1]} ${parts[0]}`:value).trim().toLocaleLowerCase("en-US").replace(/(^|[\s'-])\p{L}/gu,c=>c.toLocaleUpperCase("en-US"));
}
export function guestIdentity(value:string){return guestDisplayName(value).replace(/\s+/g," ").toLowerCase();}
export function guestReportName(name:string){
  const match=name.match(/^(In House Guest List Details(?: - AR)?|Housekeeping Arrivals|Housekeeping Departures)_CMPRI_(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})\.(csv|png|jpe?g|webp|pdf)$/i);
  const date=match?normalizePrintedDate(match[2]):"",time=match?normalizePrintedTime(`${match[3]}:${match[4]}:${match[5]}`):null;
  if(!match||!date||!time)throw Error("Choose the original timestamped CMPRI In House Guest List Details, Housekeeping Arrivals, or Housekeeping Departures report.");
  const kind:GuestReportKind=/^In House/i.test(match[1])?"guests":/Arrivals$/i.test(match[1])?"arrivals":"departures";
  return {kind,name,date,time};
}
export function parseGuestReport(name:string,csv:string):GuestReport{
  const meta=guestReportName(name),table=pmsTable(csv,meta.kind==="departures"?{"ROOM #":"ROOM NUMBER"}:{});
  const required=meta.kind==="guests"?["ROOM NUMBER","GUEST NAME","ARRIVAL","DEPARTURE","NIGHTS"]:["ROOM NUMBER","GUEST NAME"];
  for(const key of required)if(!table.headers.includes(key))throw Error(`${name}: missing ${key} column.`);
  return {...meta,rows:table.rows};
}
const field=(row:Record<string,string>,...names:string[])=>names.map(n=>row[n]?.trim()).find(Boolean)||"";
const dateField=(row:Record<string,string>,...names:string[])=>normalizePrintedDate(field(row,...names));
const epoch=(report:GuestReport)=>Date.parse(`${report.date}T${report.time}Z`); // Compare hotel-local wall times on the same date.
export function validateGuestReportBatch(reports:GuestReport[],previous:Partial<Record<GuestReportKind,GuestReport>>,today:string){
  if(!reports.length||reports.length>3||new Set(reports.map(r=>r.kind)).size!==reports.length)throw Error("Choose one to three different report types.");
  const next={...previous};
  const core=reports.find(r=>r.kind==="guests")||previous.guests;
  if(!core||core.date!==today)throw Error("Import today's In House Guest List Details before or with optional reports.");
  for(const report of reports){
    if(report.date!==today)throw Error("Reports must be dated today in the hotel timezone.");
    const prior=previous[report.kind];
    if(prior && epoch(report)<=epoch(prior) && guestReportIdentity(report)!==guestReportIdentity(prior))throw Error(`${report.name}: a newer report is required.`);
    if(report.kind!=="guests" && epoch(report)<epoch(core)-300000)throw Error("Optional reports may be at most five minutes earlier than the guest list.");
    next[report.kind]=report;
  }
  if(reports.some(r=>r.kind==="guests"))for(const kind of ["arrivals","departures"] as const){
    if(next[kind] && (next[kind]!.date!==today||epoch(next[kind]!)<epoch(core)-300000))delete next[kind];
  }
  return next as Partial<Record<GuestReportKind,GuestReport>>&{guests:GuestReport};
}

export function roomsFromGuestReports(reports:Partial<Record<GuestReportKind,GuestReport>>&{guests:GuestReport},inventory:string[],previous:GuestRoom[]):GuestRoom[]{
  const rows=new Map(inventory.map(room=>[room,{room,guest_name:"",room_status:"Vacant Ready",checkout_date:null,checkout_time:null,company:"",group_name:"",pets:0,vip:false,reserved:false,incoming_name:""} as GuestRoom]));
  const seen=new Set<string>();
  for(const guest of reports.guests.rows){
    const room=field(guest,"ROOM NUMBER");
    if(!rows.has(room)||seen.has(room))throw Error(`Guest list room ${room} is unknown or duplicated.`);
    seen.add(room);
    const name=field(guest,"GUEST NAME"),arrival=dateField(guest,"ARRIVAL"),departure=dateField(guest,"DEPARTURE");
    if(!name||!arrival||!departure||arrival>reports.guests.date||departure<reports.guests.date||arrival>departure)throw Error(`Room ${room}: invalid guest stay dates or name.`);
    const nights=Number(guest.NIGHTS),petText=field(guest,"PETS","PET COUNT","NUMBER OF PETS"),pets=petText?Number(petText):0;
    if(!Number.isInteger(nights)||nights<0||nights>3650||!Number.isInteger(pets)||pets<0||pets>100)throw Error(`Room ${room}: invalid nights or pet count.`);
    const company=field(guest,"COMPANY","COMPANY NAME","GROUP","GROUP NAME"),vip=field(guest,"VIP","VIP STATUS");
    rows.set(room,{...rows.get(room)!,guest_name:guestDisplayName(name),room_status:"Occupied",guest_arrival_date:arrival,checkout_date:departure,checkout_time:"11:00:00",stay_nights:nights,room_type:field(guest,"ROOM TYPE"),company,group_name:field(guest,"GROUP NAME","GROUP"),pets,vip:!!vip&&!/^(no|n|0|false|none)$/i.test(vip),guest_code:field(guest,"GUEST CODE","RATE CODE"),source_report_date:reports.guests.date});
  }
  for(const departure of reports.departures?.rows||[]){
    const room=rows.get(field(departure,"ROOM NUMBER"));
    if(!room||guestIdentity(room.guest_name)!==guestIdentity(field(departure,"GUEST NAME")))continue;
    const date=dateField(departure,"DEPARTURE","DEPARTURE DATE","CHECKOUT DATE")||reports.departures!.date;
    if(date!==room.checkout_date)continue;
    const rawTime=field(departure,"DEPARTURE TIME","CHECKOUT TIME","TIME"),time=normalizePrintedTime(rawTime);
    if(rawTime&&!time)throw Error(`Room ${room.room}: invalid departure time.`);
    if(time)room.checkout_time=time;
  }
  for(const arrival of reports.arrivals?.rows||[]){
    const room=rows.get(field(arrival,"ROOM NUMBER")),name=field(arrival,"GUEST NAME");
    if(!room||!name)throw Error("Arrivals contain an unknown room or missing guest name.");
    if(guestIdentity(room.guest_name)===guestIdentity(name)){
      const tier=loyaltyTier(field(arrival,"LOYALTY TIER"));
      const stayStart=dateField(arrival,"ARRIVAL","ARRIVAL DATE");
      if(tier&&(!stayStart||stayStart===room.guest_arrival_date))room.loyalty_tier=tier;
      continue;
    }
    if(room.incoming_name && guestIdentity(String(room.incoming_name))===guestIdentity(name))continue;
    if(room.incoming_name)throw Error(`Room ${room.room}: multiple incoming reservations require correction.`);
    const date=dateField(arrival,"ARRIVAL","ARRIVAL DATE")||reports.arrivals!.date;
    Object.assign(room,{incoming_name:guestDisplayName(name),incoming_loyalty_tier:loyaltyTier(field(arrival,"LOYALTY TIER")),incoming_company:field(arrival,"GROUP NAME","GROUP","COMPANY","COMPANY NAME"),reserved:true,incoming_reserved:true,arrival_date:date,arrival_time:normalizePrintedTime(field(arrival,"ARRIVAL TIME","TIME"))||"15:00:00"});
  }
  for(const row of rows.values()){
    const key=guestIdentity(row.guest_name);if(!key)continue;
    const sameStay=previous.filter(r=>guestIdentity(r.guest_name)===key && r.guest_arrival_date===row.guest_arrival_date);
    const arrivingStay=previous.filter(r=>guestIdentity(String(r.incoming_name||""))===key && r.arrival_date===row.guest_arrival_date);
    if(!row.loyalty_tier && sameStay.length===1)row.loyalty_tier=loyaltyTier(sameStay[0].loyalty_tier);
    if(!row.loyalty_tier && arrivingStay.length===1)row.loyalty_tier=loyaltyTier(arrivingStay[0].incoming_loyalty_tier);
    const old=previous.filter(r=>guestIdentity(r.guest_name)===key),current=[...rows.values()].filter(r=>guestIdentity(r.guest_name)===key);
    if(old.length===1&&current.length===1&&old[0].room!==row.room)Object.assign(row,{move_from:old[0].room,move_to:row.room});
  }
  for(const row of rows.values())if(row.incoming_name&&!row.incoming_loyalty_tier){
    const old=previous.filter(r=>guestIdentity(String(r.incoming_name||""))===guestIdentity(String(row.incoming_name))&&r.arrival_date===row.arrival_date);
    if(old.length===1)row.incoming_loyalty_tier=loyaltyTier(old[0].incoming_loyalty_tier);
  }
  return [...rows.values()];
}

/** Display-only projection. No timers in this function, no writes or network reads. */
export function projectGuestRoom<T extends GuestRoom>(source:T,now:Date,timeZone:string):T{
  const row={...source},today=hotelDateAt(now,timeZone);
  const checkedOut=!!row.checkout_date&&checkoutDeadlinePassed(row.checkout_date,row.checkout_time||"11:00:00",now,timeZone);
  if(checkedOut){
    Object.assign(row,{guest_name:"",loyalty_tier:null,company:"",group_name:"",pets:0,vip:false,checkout_date:null,checkout_time:null,guest_arrival_date:null,stay_nights:0,room_status:"Vacant Dirty"});
    const oldDay=source.checkout_date!<today;
    const early=(normalizePrintedTime(source.checkout_time)||"11:00:00")<="15:00:00";
    if(oldDay||(early&&checkoutDeadlinePassed(today,"15:00:00",now,timeZone)))row.room_status="Vacant Ready";
  }
  if(/vacant dirty/i.test(row.room_status)&&checkoutDeadlinePassed(today,"16:00:00",now,timeZone))row.room_status="Vacant Ready";
  if(row.incoming_name && typeof row.arrival_date==="string" && row.arrival_date<=today && !row.guest_name && checkoutDeadlinePassed(row.arrival_date,String(row.arrival_time||"15:00:00"),now,timeZone)){
    Object.assign(row,{guest_name:row.incoming_name,loyalty_tier:loyaltyTier(row.incoming_loyalty_tier),incoming_loyalty_tier:null,company:row.incoming_company||"",group_name:row.incoming_company||"",incoming_name:"",incoming_company:"",incoming_reserved:false,reserved:false,room_status:"Occupied",guest_arrival_date:row.arrival_date});
  }
  return row;
}

/** One local display wake-up at the next boundary; never schedules a network read. */
export function nextGuestDisplayChange(rows:GuestRoom[],now:Date,timeZone:string):number{
  const today=hotelDateAt(now,timeZone),tomorrow=new Date(Date.parse(today+"T12:00:00Z")+86400000).toISOString().slice(0,10);
  const boundaries:[[string,string],...[string,string][]]=[[tomorrow,"00:00:00"],[today,"15:00:00"],[today,"16:00:00"]];
  for(const row of rows){if(row.checkout_date)boundaries.push([row.checkout_date,row.checkout_time||"11:00:00"]);if(typeof row.arrival_date==="string")boundaries.push([row.arrival_date,String(row.arrival_time||"15:00:00")]);}
  let next=now.getTime()+86400000;
  for(const [date,time] of boundaries){
    if(checkoutDeadlinePassed(date,time,now,timeZone))continue;
    let lo=now.getTime(),hi=lo+172800000;
    if(!checkoutDeadlinePassed(date,time,new Date(hi),timeZone))continue;
    while(hi-lo>1){const mid=Math.floor((lo+hi)/2);if(checkoutDeadlinePassed(date,time,new Date(mid),timeZone))hi=mid;else lo=mid;}
    next=Math.min(next,hi);
  }
  return next;
}
