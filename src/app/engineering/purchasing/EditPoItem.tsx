"use client";
import {useEffect,useRef,useState} from 'react';
export type PendingItemEdit={prepare:()=>false|(()=>Promise<boolean>)};
type Line={id:string;description:string;uom:string;inventory_item_id:string|null;units_per_order_unit:number|null};
type Item={id:string;item_name:string;unit_of_measure:string;active:boolean};
export default function EditPoItem({line,items,received,onSave,feedback,register}:{register?:(edit:PendingItemEdit|null)=>void;line:Line;items:Item[];received:number;onSave:(body:Record<string,unknown>)=>Promise<boolean>;feedback:string}){
 const [target,setTarget]=useState('keep'),[busy,setBusy]=useState(false);
 const formRef=useRef<HTMLFormElement>(null);
 const operation=useRef(crypto.randomUUID());
 const prepare=():false|(()=>Promise<boolean>)=>{
  const node=formRef.current;if(!node||busy)return false;
  const d=new FormData(node);
  const description=String(d.get('description')??'');
  const factor=received>0||target==='keep'?line.units_per_order_unit:Number(d.get('factor'));
  const sameMapping=target==='keep'||(target===line.inventory_item_id&&factor===line.units_per_order_unit);
  if(description===line.description&&sameMapping)return async()=>true;
  if(!node.reportValidity())return false;
  const body={action:'edit-item',id:operation.current,lineId:line.id,description:d.get('description'),expectedDescription:line.description,expectedItem:line.inventory_item_id,expectedFactor:line.units_per_order_unit,itemId:target==='keep'?line.inventory_item_id:target==='new'?null:target,createItem:target==='new',stockUnit:target==='new'?d.get('stockUnit'):null,keepMapping:target==='keep',expectedReceived:received,factor:received>0||target==='keep'?line.units_per_order_unit:Number(d.get('factor'))};
  return async()=>{setBusy(true);try{if(await onSave(body)){setTarget("keep");operation.current=crypto.randomUUID();return true;}return false;}finally{setBusy(false);}};
 };
 useEffect(()=>{register?.({prepare});return()=>register?.(null);});
 const form=<form ref={formRef} onSubmit={e=>e.preventDefault()}><h3>{line.description}</h3><fieldset disabled={busy} style={{border:0,padding:0,margin:0}} onChange={()=>{operation.current=crypto.randomUUID();}}>
 <label>Item description<textarea name="description" defaultValue={line.description} required maxLength={1000} rows={3}/></label>
 <label>Inventory item<select value={target} onChange={e=>setTarget(e.target.value)}><option value="keep">{items.find(i=>i.id===line.inventory_item_id)?.item_name||"Unmapped"}</option><option value="new">Create new catalog item</option>{items.filter(i=>i.active||i.id===line.inventory_item_id).sort((a,b)=>a.item_name.localeCompare(b.item_name,"en",{sensitivity:"base"})||a.id.localeCompare(b.id)).map(i=><option key={i.id} value={i.id}>{i.item_name} ({i.unit_of_measure})</option>)}</select></label>
 {received>0&&<p>{target==='keep'?'Description only; stock stays unchanged.':`${received} ${line.uom} already received will move to the selected item, along with future receipts. Used or unavailable stock requires review.`}</p>}{target!=='keep'&&<><p>{received>0?'This transfers existing stock; it does not receive these items again.':'Changing this mapping adds no stock. New catalog items start at zero.'}</p>{target==='new'&&<label>Inventory unit<select name="stockUnit" defaultValue={items.find(i=>i.id===line.inventory_item_id)?.unit_of_measure||line.uom}>{['EA','PKG','BOX','CS','LB','OZ','G','KG'].map(u=><option key={u}>{u}</option>)}</select></label>}{received===0&&<label>Inventory units per {line.uom}<input name="factor" type="number" min="0.001" step="0.001" defaultValue={line.units_per_order_unit??1} required/></label>}</>}
 </fieldset>{feedback&&feedback!=='Saved.'&&<p role="alert">{feedback}</p>}</form>;
 return form;
}
