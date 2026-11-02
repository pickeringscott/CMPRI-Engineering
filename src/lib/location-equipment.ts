import type {Location, EquipmentForm, PmLog} from './location-records';
import type {PmTemplate} from './pm/catalog';
import rules from './location-form-rules.json';
import identities from './location-form-identities.json';
export type EquipmentAsset={id:string;name:string;asset_type:string;location_id:string|null};
export type SourceLog=PmLog & {payload: {form_data?:{logEntries?:Record<string,unknown>[]};responses?:Record<string,unknown>;[key:string]:unknown}};
export function buildLocationEquipment(locations:Location[],assets:EquipmentAsset[],logs:SourceLog[],templates:PmTemplate[]){
 // Reviewed identity anchors preserve form relationships through name/type edits.
 // Live inventory remains authoritative: absent IDs are never added by this map.
 const canonical=locations.map(l=>({...l,...(identities as Record<string,{name:string|null;location_type:string|null}>)[l.id]}));
 locations=canonical;
 const byName=new Map(locations.map(l=>[l.name,l])),byId=new Map(locations.map(l=>[l.id,l])),catalog=new Map(templates.map(t=>[t.id,t]));
 const forms=new Map<string,EquipmentForm>();
 function add(l:Location|undefined,tid:string,evidence:string,asset?:EquipmentAsset,items:string[]=[]){
  const t=catalog.get(tid);if(!l||!t)return;
  const key=l.id+'/'+tid;let f=forms.get(key);
  if(!f){f={location_id:l.id,template_id:tid,title:t.title,cadence:t.cadence,months:t.months,source:t.sourceReference,asset_ids:[],asset_names:[],evidence:[],item_ids:[]};forms.set(key,f);}
  if(!f.evidence.includes(evidence))f.evidence.push(evidence);
  if(asset&&!f.asset_ids.includes(asset.id)){f.asset_ids.push(asset.id);f.asset_names.push(asset.name);}
  for(const i of items)if(!f.item_ids.includes(i))f.item_ids.push(i);
 }
 for(const l of locations){
  if(l.location_type==='Guest Room')add(l,'pdf:room-pm-checklist',`Recorded Guest Room identity ${l.room_number}; catalog room-scoped checklist`);
  const tid=(rules.area_forms as Record<string,string>)[l.name||''];if(tid)add(l,'pdf:'+tid,`Recorded location '${l.name}' matches functional scope of '${catalog.get('pdf:'+tid)?.title}'`);
 }
 for(const [name,numbers] of Object.entries(rules.walk_items)){
  const tid='pdf:property-walk-guide',items=numbers.map(n=>`property-walk-guide-item-${n}`);
  add(byName.get(name),tid,'Explicit source tasks: '+catalog.get(tid)?.checklist.filter(i=>items.includes(i.id)).map(i=>i.label).join('; '),undefined,items);
 }
 for(const l of locations){
  if(l.name?.endsWith('Supply Closet'))add(l,'pdf:storage','Recorded supply closet is a storage location; blank historical storage headers remain unresolved.');
  if(['Lower Roof','5th Floor Roof'].includes(l.name||''))add(l,'pdf:exterior-site-maintenance','Recorded roof; explicit ROOFING section. Conditional checks remain conditional.',undefined,[33,37,38,39,40,41].map(n=>`exterior-site-maintenance-item-${n}`));
  if(l.name==='Parking Lot')add(l,'pdf:exterior-site-maintenance','Recorded Parking Lot; explicit PARKING LOT/GARAGE section.',undefined,[4,7,8,9,10,11,12].map(n=>`exterior-site-maintenance-item-${n}`));
 }
 for(const a of assets){
  const l=byId.get(a.location_id||'');if(!l||l.location_type==='Guest Room')continue;
  const typ=a.asset_type;let targets:string[]=[];
  if(['Washer','Dryer'].includes(typ))targets=[l.name==='Guest Laundry'?'pdf:laundry-guest':'pdf:laundry-commercial'];
  if(typ==='Ice Maker')targets=['pdf:ice-machine-areas'];
  if(typ==='HVAC'&&/RTU|Rooftop/i.test(a.name))targets=['pdf:rtu-quarterly','pdf:rtu-monthly'];
  if(typ==='Fire Protection'&&a.name==='Fire Sprinkler System')targets=['pdf:monthly-sprinkler-valve-insp','pdf:sprinkler-flow-tamper-test'];
  if(['Pool Filter','Pool Filtration / Chemistry','Pool Heater','Pool Equipment'].includes(typ))targets=['pdf:pool'];
  if(typ==='Employee Bathroom')targets=['pdf:public-restrooms'];
  if(typ==='Signage')targets=['pdf:exterior-site-maintenance'];
  if(typ==='Lighting'&&['Elevator #1','Elevator #2'].includes(l.name||''))targets=['pdf:elevator-checklist'];
  if(typ==='Exercise Equipment')targets=['pdf:fitness-center'];
  if(typ==='Shop Tools')targets=['pdf:tool-inventory'];
  for(const tid of targets)add(l,tid,`assets/${a.id}.location_id → ${l.id}; recorded ${typ}: ${a.name}; ${catalog.get(tid)?.sourceReference}`,a);
  for(const t of templates.filter(t=>t.id.startsWith('workbook:'))){
   const matches=t.checklist.filter(i=>{const label=i.label.toLowerCase();return (typ==='Water Heating'&&(/water heating|water heaters\/boilers/.test(label)))||(typ==='Fire Alarm System'&&label.includes('fire panel'))||(['Washer','Dryer'].includes(typ)&&/commercial washers|commercial dryers/.test(label))||(['Pool Filter','Pool Filtration / Chemistry','Pool Heater','Pool Equipment'].includes(typ)&&label.includes('pool readings'));});
   if(matches.length)add(l,t.id,`assets/${a.id}.location_id; applicable tasks: `+matches.map(i=>`${i.source} ${i.label}`).join('; '),a,matches.map(i=>i.id));
  }
 }
 const normal=(s:string)=>s.toLowerCase().replace(/[^a-z0-9]/g,'');
 for(const f of [...forms.values()].filter(f=>f.template_id.startsWith('pdf:'))){
  const source=normal(catalog.get(f.template_id)!.sourceFile);if(!source)continue;
  for(const t of templates.filter(t=>t.id.startsWith('workbook:monthly:'))){const matches=t.checklist.filter(i=>normal(i.source||'').includes(source));if(matches.length)add(byId.get(f.location_id),t.id,`Workbook references confirmed applicable form ${f.template_id}: `+matches.map(i=>i.source).join('; '),undefined,matches.map(i=>i.id));}
 }
 const log_links:{log_id:string;location_id:string;row_index:number;recorded_location:string}[]=[],unresolved_rows:{log_id:string;row_index:number;recorded_location:string}[]=[];
 for(const p of logs)for(const [index,row] of (p.payload?.form_data?.logEntries||[]).entries()){
  const label=String(row.location||''),text=label.toLowerCase();let l=byName.get((rules.named as Record<string,string>)[label]);
  if(!l&&text.includes('hall')&&!/stair|mechanical|electrical|foyer/.test(text)){const floor=text.match(/\b([1-4])(?:st|nd|rd|th)\b/)||text.match(/room\s*([1-4])\d\d/);if(floor)l=byName.get(['1st','2nd','3rd','4th'][Number(floor[1])-1]+' Floor Hall');}
  if(l){log_links.push({log_id:p.id,location_id:l.id,row_index:index,recorded_location:label});add(l,p.template_id,`Recorded log ${p.id} row ${index}: ${label}`);}else unresolved_rows.push({log_id:p.id,row_index:index,recorded_location:label});
 }
 const mappedLogs=new Set(log_links.map(l=>l.log_id)),formTemplates=new Set([...forms.values()].map(f=>f.template_id));
 const residual_logs=logs.filter(p=>!mappedLogs.has(p.id)),unmatched_logs=residual_logs.filter(p=>!formTemplates.has(p.template_id));
 return {forms:[...forms.values()],log_links,unresolved_rows,unmatched_log_ids:unmatched_logs.map(p=>p.id),unmapped_locations:locations.filter(l=>![...forms.values()].some(f=>f.location_id===l.id)).map(l=>({id:l.id,name:l.name})),counts:{unmatched_logs:unmatched_logs.length,shared_logs:residual_logs.length-unmatched_logs.length,unresolved_rows:unresolved_rows.length,logs_without_confirmed_location:residual_logs.length}};
}
