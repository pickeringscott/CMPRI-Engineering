"use client";
import {useEffect,useRef} from 'react';
import {mountApprovedMenus} from '@/lib/ui/approved-header-menus';
import {headerActionStyle} from '@/lib/ui/header-palette';
type Action={key:string;label:string};
export default function ApprovedDashboardMenus<T extends Action>({groups,onLaunch,role,locked=false}:{groups:Array<{label:string;items:T[]}>;onLaunch:(action:T,clickedAt:number)=>void;role:string;locked?:boolean}){
 const root=useRef<HTMLDivElement>(null),latest=useRef(onLaunch);useEffect(()=>{latest.current=onLaunch},[onLaunch]);
 const signature=JSON.stringify(groups);
 useEffect(()=>{if(!root.current)return;return mountApprovedMenus(root.current,JSON.parse(signature).map((g:{label:string;items:T[]})=>({...g,items:g.items.map(a=>({...a,style:headerActionStyle(a.label)}))})),(action:T,at:number)=>latest.current(action,at),role,locked)},[signature,role,locked]);
 return <div ref={root} className="cmpri-header-v23"/>;
}
