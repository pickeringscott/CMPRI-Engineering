"use client";
import {useEffect,useRef,useState} from 'react';
import styles from './po-receiving.module.css';
type Item={id:string;item_name:string;unit_of_measure:string;active:boolean};
export default function AddItem({items,onSave,onClose,feedback}:{items:Item[];onSave:(body:Record<string,unknown>)=>Promise<boolean>;onClose:()=>void;feedback:string}){
 const [target,setTarget]=useState(''),[unit,setUnit]=useState('EA'),[cost,setCost]=useState(''),[busy,setBusy]=useState(false);
 const operation=useRef(crypto.randomUUID());const [attempt,setAttempt]=useState<Record<string,unknown>|null>(null);
 const dialog=useRef<HTMLDialogElement>(null);
 useEffect(()=>{dialog.current?.showModal();},[]);
 const item=items.find(i=>i.id===target),packaged=unit==='EA'||unit==='CS';
 return <dialog ref={dialog} aria-label="Add Item" className={styles.addItemDialog} onCancel={e=>{e.preventDefault();if(!busy)onClose();}}><form onSubmit={async e=>{e.preventDefault();if(busy)return;const d=new FormData(e.currentTarget);const body=attempt||{action:'add-item',id:operation.current,itemId:target||null,description:item?.item_name||d.get('description'),quantity:Number(d.get('quantity')),uom:unit,packageSize:packaged&&d.get('size')?Number(d.get('size')):null,contentUnit:packaged?d.get('contentUnit')||null:null,sku:d.get('sku'),price:cost===''?null:Number(cost)};setAttempt(body);setBusy(true);try{if(await onSave(body))onClose();else setAttempt(null);}finally{setBusy(false);}}}>
 <h3>Add Item</h3><label>Inventory item<select aria-label="Inventory item" value={target} disabled={busy} onChange={e=>{setTarget(e.target.value);operation.current=crypto.randomUUID();}}><option value="">New item</option>{items.filter(i=>i.active).map(i=><option key={i.id} value={i.id}>{i.item_name} ({i.unit_of_measure})</option>)}</select></label>
 <div className={styles.itemEntryRow}><label>Item description<input name="description" key={target} defaultValue={item?.item_name||''} readOnly={!!item} required maxLength={1000}/></label><label>QTY<input name="quantity" aria-label="Quantity" type="number" min={packaged?1:0.001} step={packaged?'1':'any'} required/></label><label>Order unit<select aria-label="Order unit" value={unit} onChange={e=>setUnit(e.target.value)}>{['EA','CS','LB','OZ','G','KG'].map(u=><option key={u}>{u}</option>)}</select></label></div>
 {packaged&&<div className={styles.packageFields}><label>Contents per package<input name="size" aria-label="Contents per package" type="number" min="0.001" step="any" required={unit==='CS'||item?.unit_of_measure==='LB'}/></label><label>Unit<select name="contentUnit" aria-label="Contents unit" required={unit==='CS'||item?.unit_of_measure==='LB'}><option value="">-</option>{['EA','LB','OZ','G','KG'].map(u=><option key={u}>{u}</option>)}</select></label></div>}
 <div className={styles.itemPriceRow}><label>Part / SKU<input name="sku" maxLength={200}/></label><label>Cost<span className={styles.costField}>$<input aria-label="Cost" inputMode="decimal" type="number" min="0" step="0.01" value={cost} onChange={e=>setCost(e.target.value)} onBlur={()=>{if(cost!==''&&Number.isFinite(Number(cost)))setCost(Number(cost).toFixed(2));}} style={{width:`${Math.max(40,cost.length*7+18)}px`}} placeholder="0.00"/></span></label></div>
 <p>New items start at zero stock. Receipts add contents to the selected inventory item. Case contents must be explicit.</p>{feedback&&feedback!=='Saved.'&&<p role="alert">{feedback}</p>}<div className={styles.addActions}><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button className={styles.primary} disabled={busy}>Add item</button></div>
 </form></dialog>;
}

