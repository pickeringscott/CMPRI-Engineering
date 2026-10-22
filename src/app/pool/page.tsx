"use client";
import {useEffect,useState} from "react";
import PoolStatus from "@/components/desktop/PoolStatus";
import {loadCmpriSession} from "@/lib/auth/client-session";
import {profileHasRole} from "@/lib/server/roles";
export default function Pool(){const [engineer,setEngineer]=useState(false);useEffect(()=>{void loadCmpriSession().then(s=>setEngineer(profileHasRole(s.user,"engineer"))).catch(()=>{});},[]);return <main className="mx-auto h-[min(480px,100dvh)] max-w-md"><PoolStatus engineer={engineer}/></main>;}
