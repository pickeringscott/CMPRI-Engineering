"use client";
import {useEffect,useRef,useState} from 'react';
import EditPoItem, {type PendingItemEdit} from './EditPoItem';
import styles from './po-receiving.module.css';
type Line={id:string;description:string;uom:string;inventory_item_id:string|null;units_per_order_unit:number|null};
type Item={id:string;item_name:string;unit_of_measure:string;active:boolean};
export default function EditPoItems({lines,items,received,onSave,onClose,}:{lines:Line[];items:Item[];received:(id:string)=>number;onSave:(body:Record<string,unknown>)=>Promise<boolean>;onClose:()=>void}){
 const edits=useRef(new Map<string,PendingItemEdit>()),lock=useRef(false);
 const dialog=useRef<HTMLDialogElement>(null);
 const [saving,setSaving]=useState(false),[feedback,setFeedback]=useState<Record<string,string>>({});
 useEffect(()=>{dialog.current?.showModal();},[]);
 const close=async()=>{
  if(lock.current)return;
  const pending:Array<()=>Promise<boolean>>=[];
  let complete=true;
  for(const line of lines){
   const save=edits.current.get(line.id)?.prepare();
   if(!save){setFeedback(current=>({...current,[line.id]:'Please correct the highlighted fields.'}));complete=false;continue;}
   pending.push(save);
  }
  lock.current=true;setSaving(true);
  try{for(const save of pending){if(!await save())complete=false;}if(complete)onClose();}
  catch(error){setFeedback(current=>({...current,global:error instanceof Error?error.message:'Could not save changes.'}));}
  finally{lock.current=false;setSaving(false);}
 };
 return <dialog ref={dialog} aria-label="Edit Items" className={`${styles.addItemDialog} ${styles.editItemsDialog}`} style={{width:600}} onCancel={e=>{e.preventDefault();void close();}}>
  <h3>Edit Items</h3>
  <p>{lines.length} items on this PO. Changes save when you close.</p>
  <fieldset disabled={saving} style={{border:0,padding:0,margin:0}}>
   {lines.map(line=><section key={line.id} aria-label={`Edit PO line ${line.id}`} style={{borderTop:'1px solid #3c4d67',padding:'5px 0'}}>
    <EditPoItem register={edit=>{if(edit)edits.current.set(line.id,edit);else edits.current.delete(line.id);}} line={line} items={items} received={received(line.id)} feedback={feedback[line.id]||''} onSave={async body=>{
     try{const ok=await onSave(body);setFeedback(current=>({...current,[line.id]:ok?'Saved this item.':'Could not save this item.'}));return ok;}catch(error){setFeedback(current=>({...current,[line.id]:error instanceof Error?error.message:'Could not save this item.'}));return false;}
    }}/>
   </section>)}
  </fieldset>
  {feedback.global&&<p role="alert">{feedback.global}</p>}
  <div className={styles.addActions}><button type="button" disabled={saving} onClick={()=>void close()}>Close</button></div>
 </dialog>;
}
