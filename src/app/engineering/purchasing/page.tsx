"use client";
import {useEffect,useState} from 'react';
import {hasCapability,loadCmpriSession} from '@/lib/auth/client-session';
import {enforceSessionPreference} from '@/lib/auth/session-preference';
import PurchaseOrders from './PurchaseOrders';
export default function PurchasingPage(){
 const [allowed,setAllowed]=useState(false),[canImport,setCanImport]=useState(false);
 useEffect(()=>{let active=true;void(async()=>{try{if(!await enforceSessionPreference())return;const session=await loadCmpriSession();if(!hasCapability(session,'manage_assets')){window.location.replace(session.landing);return;}if(active){setAllowed(true);setCanImport(hasCapability(session,"operate_integrations"));}}catch{window.location.replace('/');}})();return()=>{active=false;};},[]);
 if(!allowed)return null;
 return <PurchaseOrders canImport={canImport===true}/>;
}
