'use client';
import { useUiLanguage } from '@/components/UiLanguageProvider';
import {useEffect,useRef} from 'react';
import styles from './po-receiving.module.css';
export default function PoCompactMenu({label,value,onChange,options}:{label:string;value:string;onChange:(value:string)=>void;options:{value:string;label:string}[]}){
 const {t: ui}=useUiLanguage();
 const ref=useRef<HTMLDetailsElement>(null);
 useEffect(()=>{const close=(e:PointerEvent)=>{if(ref.current&&!ref.current.contains(e.target as Node))ref.current.open=false;};document.addEventListener('pointerdown',close);return()=>document.removeEventListener('pointerdown',close);},[]);
 return <details data-cmpri-dropdown="compact" ref={ref} className={styles.compactMenu} onKeyDown={e=>{if(e.key==='Escape'&&ref.current){ref.current.open=false;ref.current.querySelector('summary')?.focus();}}}><summary aria-label={ui(label)}>{ui(options.find(o=>o.value===value)?.label||label)}</summary><div data-cmpri-dropdown-panel className={styles.menuOptions}>{options.map(o=><button key={o.value} type="button" aria-pressed={o.value===value} onClick={()=>{onChange(o.value);if(ref.current){ref.current.open=false;ref.current.querySelector('summary')?.focus();}}}>{ui(o.label)}</button>)}</div></details>;
}
