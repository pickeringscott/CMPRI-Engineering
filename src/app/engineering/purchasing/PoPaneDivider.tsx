'use client';
import {useEffect,useRef} from 'react';
import {paneBounds} from '@/lib/po-presentation';
import styles from './po-receiving.module.css';
export default function PoPaneDivider(){
 const ref=useRef<HTMLDivElement>(null);
 useEffect(()=>{
  const el=ref.current,workspace=el?.parentElement;if(!el||!workspace)return;
  let width=230,height=230,drag:{id:number;start:number;value:number;vertical:boolean}|null=null;
  const stacked=()=>window.matchMedia('(max-width:560px)').matches;
  const apply=(value:number)=>{const vertical=!stacked(),rect=workspace.getBoundingClientRect(),b=paneBounds(vertical?rect.width:rect.height,!vertical),current=Math.max(b.min,Math.min(b.max,value));if(vertical)width=current;else height=current;workspace.style.setProperty(vertical?'--po-orders-width':'--po-orders-height',`${current}px`);el.setAttribute('aria-orientation',vertical?'vertical':'horizontal');el.setAttribute('aria-valuemin',String(Math.round(b.min)));el.setAttribute('aria-valuemax',String(Math.round(b.max)));el.setAttribute('aria-valuenow',String(Math.round(current)));};
  const down=(e:PointerEvent)=>{if(e.button!==0)return;e.preventDefault();el.focus();const vertical=!stacked();drag={id:e.pointerId,start:vertical?e.clientX:e.clientY,value:vertical?width:height,vertical};el.setPointerCapture(e.pointerId);};
  const move=(e:PointerEvent)=>{if(drag?.id===e.pointerId)apply(drag.value+(drag.vertical?e.clientX:e.clientY)-drag.start);};
  const finish=(e:PointerEvent)=>{if(drag?.id===e.pointerId){drag=null;if(el.hasPointerCapture(e.pointerId))el.releasePointerCapture(e.pointerId);}};
  const key=(e:KeyboardEvent)=>{const vertical=!stacked(),rect=workspace.getBoundingClientRect(),b=paneBounds(vertical?rect.width:rect.height,!vertical),step=e.shiftKey?30:10;let n=vertical?width:height;if(e.key===(vertical?'ArrowLeft':'ArrowUp'))n-=step;else if(e.key===(vertical?'ArrowRight':'ArrowDown'))n+=step;else if(e.key==='Home')n=b.min;else if(e.key==='End')n=b.max;else return;e.preventDefault();apply(n);};
  const observer=new ResizeObserver(()=>apply(stacked()?height:width));observer.observe(workspace);apply(stacked()?height:width);
  el.addEventListener('pointerdown',down);el.addEventListener('pointermove',move);el.addEventListener('pointerup',finish);el.addEventListener('pointercancel',finish);el.addEventListener('keydown',key);
  return()=>{observer.disconnect();el.removeEventListener('pointerdown',down);el.removeEventListener('pointermove',move);el.removeEventListener('pointerup',finish);el.removeEventListener('pointercancel',finish);el.removeEventListener('keydown',key);};
 },[]);
 return <div ref={ref} className={styles.paneDivider} role="separator" tabIndex={0} aria-label="Resize orders and order details" aria-controls="po-orders-pane po-detail-pane" aria-orientation="vertical" title="Drag to resize; arrow keys, Home and End"/>;
}
