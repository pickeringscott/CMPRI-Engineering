"use client";
import {createElement,useEffect} from "react";
import {registerApprovedNotificationBell} from "@/lib/ui/approved-notification-bell";
export default function DashboardNotificationBell({count,label,title,onClick}:{count:number;label:string;title?:string;onClick:()=>void}){
 useEffect(()=>{registerApprovedNotificationBell()},[]);
 return <button type="button" onClick={onClick} aria-label={label} title={title} className="cmpri-approved-bell">{createElement("notification-bell",{count:Math.max(0,Math.floor(count)),"aria-hidden":"true"})}</button>;
}
