"use client";
import {useEffect,useMemo,useState} from 'react';
import SearchableSelect from '@/components/SearchableSelect';
import {INVENTORY_TYPES,STOCK_UNITS,matchingInventory,normalizedUnit,validStockCount,type InventoryItem,type InventoryLocation} from '@/lib/inventory';
import type {InventoryCommands} from './useInventoryCommands';
const field='min-h-9 w-full min-w-0 rounded-lg border border-slate-600 bg-transparent px-2 py-1 text-sm';
export default function InventoryItemDialog({item,mode,items,locations,vendors,assets,commands,ready,onClose,onExisting,onRefresh}:{item?:InventoryItem;mode:'create'|'edit'|'adjust'|'return';items:InventoryItem[];locations:InventoryLocation[];vendors:{id:string;company_name:string;active?:boolean}[];assets:{id:string;name:string}[];commands:InventoryCommands;ready:boolean;onClose:()=>void;onExisting:(id:string)=>void;onRefresh?:()=>void}){
 const [name,setName]=useState(item?.item_name||''),[type,setType]=useState(item?.item_type||'Supply'),[unit,setUnit]=useState(normalizedUnit(item?.unit_of_measure||'EA'));
 const [location,setLocation]=useState(item?.storage_location_id||''),[vendor,setVendor]=useState(item?.preferred_vendor_id||''),[sku,setSku]=useState(item?.vendor_sku||''),[manufacturer,setManufacturer]=useState(item?.manufacturer||'');
 const [description,setDescription]=useState(item?.description||''),[quantity,setQuantity]=useState(mode==='return'?'':String(item?.quantity_on_hand||0)),[reorder,setReorder]=useState(item?.reorder_level==null?'':String(item.reorder_level));
 const [orderQty,setOrderQty]=useState(item?.suggested_order_quantity==null?'':String(item.suggested_order_quantity)),[cost,setCost]=useState(item?.current_unit_cost==null?'':String(item.current_unit_cost)),[asset,setAsset]=useState(''),[reason,setReason]=useState(''),[localError,setLocalError]=useState('');
 const [reviewedRevision,setReviewedRevision]=useState(item?.inventory_revision);
 const title=mode==='create'?'Add Inventory':mode==='edit'?'Edit inventory details':mode==='return'?'Return stock':'Adjust stock';
 const changedElsewhere=item&&reviewedRevision!==item.inventory_revision;
 const locked=commands.busy||commands.uncertain||!commands.hydrated;
 const draft=useMemo(()=>({id:item?.id,item_name:name,manufacturer,vendor_sku:sku,preferred_vendor_id:vendor||null,unit_of_measure:unit}),[item?.id,name,manufacturer,sku,vendor,unit]);
 const duplicate=matchingInventory(items,draft);
 const quantityAction=mode==='adjust'||mode==='return';
 const fingerprint=JSON.stringify([name,type,unit,location,vendor,sku,manufacturer,description,quantity,reorder,orderQty,cost,asset,reason]);
 const [initialForm]=useState(fingerprint),dirty=fingerprint!==initialForm;
 useEffect(()=>{const warn=(event:BeforeUnloadEvent)=>{if(dirty){event.preventDefault();event.returnValue='';}};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[dirty]);
 useEffect(()=>{
  const cancel=(event:Event)=>{if(locked){event.preventDefault();return;}if(dirty&&!window.confirm('Discard these unsaved inventory entries?'))event.preventDefault();};
  document.addEventListener('cmpri-modal-cancel-request',cancel);return()=>document.removeEventListener('cmpri-modal-cancel-request',cancel);
 },[dirty,locked]);
 function reviewCurrent(){
  if(!item)return;
  if(mode==='edit'){
   if(dirty&&!window.confirm('Load the saved details and replace these unsaved edits?'))return;
   setName(item.item_name);setType(item.item_type);setUnit(normalizedUnit(item.unit_of_measure));setLocation(item.storage_location_id||'');setVendor(item.preferred_vendor_id||'');setSku(item.vendor_sku||'');setManufacturer(item.manufacturer||'');setDescription(item.description||'');setReorder(item.reorder_level==null?'':String(item.reorder_level));setOrderQty(item.suggested_order_quantity==null?'':String(item.suggested_order_quantity));setCost(item.current_unit_cost==null?'':String(item.current_unit_cost));setReason('');
  }else if(mode==='adjust')setQuantity(String(item.quantity_on_hand));
  setReviewedRevision(item.inventory_revision);setLocalError('');commands.clearError();
 }
 function close(){if(locked)return;if(dirty&&!window.confirm('Discard these unsaved inventory entries?'))return;onClose();}
 async function save(){
  setLocalError('');
  if(changedElsewhere){setLocalError('Counts or details changed. Review the current item before saving.');return;}
  if(duplicate&&!quantityAction){setLocalError('Matching inventory already exists. Open its existing record.');return;}
  if((quantityAction||mode==='create')&&(!validStockCount(Number(quantity),unit)||quantity.trim()===''||(mode==='return'&&Number(quantity)<=0))){setLocalError('Enter a valid quantity. Each requires whole counts.');return;}
  if((quantityAction||mode==='create'&&Number(quantity)>0)&&!reason.trim()){setLocalError('Enter the physical-count or return reason.');return;}
  const optionalNumber=(value:string)=>value.trim()===''?null:Number(value);
  const body:Record<string,unknown>=quantityAction?{kind:'inventory',id:item?.id,action:mode,expected_revision:reviewedRevision,quantity:Number(quantity),reason}:
   {kind:'inventory',...(item?{id:item.id,action:'edit',expected_revision:reviewedRevision}:{}),item_name:name,item_type:type,unit_of_measure:unit,storage_location_id:location,preferred_vendor_id:vendor||null,vendor_sku:sku,manufacturer,description,quantity_on_hand:Number(quantity),reorder_level:optionalNumber(reorder),suggested_order_quantity:optionalNumber(orderQty),current_unit_cost:optionalNumber(cost),compatible_asset_id:asset||null,reason};
  const result=await commands.command(mode==='create'?'POST':'PATCH',body);if(result)onClose();
 }
 return <div className="cmpri-modal-backdrop fixed inset-0 z-[140] flex items-center justify-center bg-black/75 p-2"><section role="dialog" aria-modal="true" aria-label={title} className="cmpri-modal-shell max-h-[94dvh] w-full max-w-xl overflow-y-auto border border-current bg-[var(--cmpri-modal-surface,#181818)] p-4">
  <header className="mb-3 flex items-center justify-between gap-2"><h2 className="text-lg font-bold">{title}</h2><button type="button" aria-label={`Close ${title}`} disabled={locked} onClick={close} className="rounded border border-current px-2 py-1 disabled:opacity-50">Close</button></header>
  <form onSubmit={event=>{event.preventDefault();void save();}} className="space-y-3">
  <fieldset disabled={locked||!ready} className="space-y-3 disabled:opacity-60">
   {quantityAction?<><p className="font-semibold">{item?.item_name}</p><p className="text-sm">On hand {item?.quantity_on_hand} {unit} · Reserved {item?.quantity_reserved} · Available {Number(item?.quantity_on_hand)-Number(item?.quantity_reserved)}</p>
    <label className="block text-sm">{mode==='return'?'Quantity returned':'Physical count'} ({unit})<input aria-label={mode==='return'?'Quantity returned':'Physical count'} required className={field} type="number" min={mode==='return'?'0.001':'0'} max="999999999" step={unit==='EA'?'1':'0.001'} value={quantity} onChange={event=>setQuantity(event.target.value)}/></label></>:
   <><label className="block text-sm">Item name<input aria-label="Inventory item name" required maxLength={300} className={field} value={name} onChange={event=>setName(event.target.value)}/></label>
    <div className="grid grid-cols-2 gap-2"><label className="block text-sm">Type<select aria-label="Inventory type" className={field} value={type} onChange={event=>setType(event.target.value as typeof type)}>{INVENTORY_TYPES.map(value=><option key={value}>{value}</option>)}</select></label>
     <label className="block text-sm">Stock unit<select aria-label="Stock unit" className={field} value={unit} disabled={mode==='edit'&&(item?.unit_locked===true||Number(item?.quantity_on_hand)!==0||Number(item?.quantity_reserved)!==0)} onChange={event=>setUnit(event.target.value)}>{[...new Set([unit,...STOCK_UNITS])].map(value=><option key={value}>{value}</option>)}</select></label></div>
    {mode==='edit'?<p className="text-xs opacity-75">Stock units are locked after stock or transactions are recorded. Earlier zero-stock items without movements can be corrected.</p>:<label className="block text-sm">Opening quantity<input aria-label="Opening quantity" required type="number" min="0" max="999999999" step={unit==='EA'?'1':'0.001'} className={field} value={quantity} onChange={event=>setQuantity(event.target.value)}/></label>}
    <label className="block text-sm">Storage Location<SearchableSelect value={location} options={locations.filter(value=>value.active!==false).map(value=>({value:value.id,label:value.room_number?`Room ${value.room_number} · ${value.name}`:value.name,group:value.area||'Managed locations'}))} onChange={setLocation} placeholder="Choose managed Storage Location" required /></label>
    {mode==='edit'&&!item?.storage_location_id&&<p className="text-xs opacity-80">Earlier storage text is preserved: {item?.storage_location||'Unassigned'}. Select the managed location you have verified.</p>}
    <div className="grid grid-cols-2 gap-2"><label className="text-sm">Preferred vendor<select aria-label="Preferred vendor" className={field} value={vendor} onChange={event=>setVendor(event.target.value)}><option value="">None</option>{vendors.filter(value=>value.active!==false).map(value=><option value={value.id} key={value.id}>{value.company_name}</option>)}</select></label><label className="text-sm">Vendor SKU<input aria-label="Vendor SKU" className={field} value={sku} maxLength={200} onChange={event=>setSku(event.target.value)}/></label></div>
    <label className="block text-sm">Manufacturer<input aria-label="Manufacturer" className={field} value={manufacturer} maxLength={200} onChange={event=>setManufacturer(event.target.value)}/></label>
    <label className="block text-sm">Description<textarea aria-label="Inventory description" className={field} value={description} maxLength={3000} rows={2} onChange={event=>setDescription(event.target.value)}/></label>
    <div className="grid grid-cols-3 gap-2">{[['Reorder at',reorder,setReorder],['Order quantity',orderQty,setOrderQty],['Unit cost',cost,setCost]].map(([label,value,setter])=><label className="text-sm" key={String(label)}>{String(label)}<input aria-label={String(label)} className={field} type="number" min={label==='Order quantity'?'0.001':'0'} step={label==='Unit cost'?'0.01':'0.001'} value={String(value)} onChange={event=>(setter as (value:string)=>void)(event.target.value)}/></label>)}</div>
    <label className="block text-sm">Compatible equipment (optional)<select aria-label="Compatible equipment" className={field} value={asset} onChange={event=>setAsset(event.target.value)}><option value="">None</option>{assets.map(value=><option key={value.id} value={value.id}>{value.name}</option>)}</select></label></>}
   <label className="block text-sm">{mode==='create'?'Opening count note':quantityAction?'Reason':'Details note (optional)'}<textarea aria-label="Inventory reason" className={field} rows={2} maxLength={2000} required={quantityAction||mode==='create'&&Number(quantity)>0} value={reason} onChange={event=>setReason(event.target.value)}/></label>
  </fieldset>
  {duplicate&&!quantityAction&&<div className="rounded-lg border border-current p-2 text-sm">Matching inventory exists: {duplicate.item_name}. <button type="button" disabled={locked} className="underline" onClick={()=>{onExisting(duplicate.id);onClose();}}>View existing item</button></div>}
  {changedElsewhere&&<div role="alert" className="rounded-lg border border-current p-2 text-sm">This item changed after you opened it. Your entries are preserved. Current on hand: {item?.quantity_on_hand} {item?.unit_of_measure}. <button type="button" disabled={locked} className="underline" onClick={reviewCurrent}>{mode==='edit'?'Load saved details':'Review these current counts'}</button></div>}
  {(localError||commands.error)&&<p role="alert" className="rounded-lg border border-current p-2 text-sm">{localError||commands.error}{onRefresh&&<button type="button" className="ml-2 underline" disabled={commands.busy||commands.uncertain} onClick={onRefresh}>Refresh current data</button>}</p>}
  {commands.uncertain?<button type="button" disabled={commands.busy} className="rounded border border-current px-3 py-2" onClick={()=>void commands.retry().then(result=>{if(result)onClose();})}>Retry unconfirmed save</button>:<div className="flex justify-end gap-2"><button type="button" disabled={commands.busy} className="rounded border border-current px-3 py-2" onClick={close}>Cancel</button><button type="submit" disabled={commands.busy||!commands.hydrated||!ready||Boolean(mode==='edit'&&!dirty)||Boolean(duplicate&&!quantityAction)||Boolean(changedElsewhere)} className="rounded border border-current bg-[rgba(var(--cmpri-action-rgb),.2)] px-3 py-2 font-semibold disabled:opacity-50">{commands.busy?'Saving…':mode==='create'?'Add Inventory Item':quantityAction?'Save stock note':'Save details'}</button></div>}
  </form>
 </section></div>;
}
