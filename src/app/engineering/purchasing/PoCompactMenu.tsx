'use client';
import {useEffect,useRef} from 'react';
import styles from './po-receiving.module.css';
export default function PoCompactMenu({label,value,onChange,options}:{label:string;value:string;onChange:(value:string)=>void;options:{value:string;label:string}[]}){
 const ref=useRef<HTMLDetailsElement>(null);
 useEffect(()=>{const close=(e:PointerEvent)=>{if(ref.current&&!ref.current.contains(e.target as Node))ref.current.open=false;};document.addEventListener('pointerdown',close);return()=>document.removeEventListener('pointerdown',close);},[]);
 return <details ref={ref} className={styles.compactMenu} onKeyDown={e=>{if(e.key==='Escape'&&ref.current){ref.current.open=false;ref.current.querySelector('summary')?.focus();}}}><summary aria-label={label}>{options.find(o=>o.value===value)?.label}</summary><div className={styles.menuOptions}>{options.map(o=><button key={o.value} type="button" aria-pressed={o.value===value} onClick={()=>{onChange(o.value);if(ref.current){ref.current.open=false;ref.current.querySelector('summary')?.focus();}}}>{o.label}</button>)}</div></details>;
}
