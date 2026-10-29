"use client";

import { useEffect, useState } from "react";
import GssLive from "./GssLive";
import styles from "./GssScorecard.module.css";
import { enforceSessionPreference } from "@/lib/auth/session-preference";
import { hasCapability, loadCmpriSession } from "@/lib/auth/client-session";
import ModalDashboardLink from "@/components/ModalDashboardLink";



export default function GssPage() {

  const [pageAllowed, setPageAllowed] = useState(false);
  useEffect(() => { (async () => {
    try {
      if (!await enforceSessionPreference()) return;
      const session = await loadCmpriSession();
      if (!hasCapability(session, "view_engineering_operations")) {
        window.location.replace(session.landing);
        return;
      }
      setPageAllowed(true);

    } catch {
      window.location.replace("/");
    }
  })(); }, []);
  if (!pageAllowed) return null;
  return <main className={styles.page}><div className="mx-auto w-full px-3 py-4 sm:px-4">
    <ModalDashboardLink className="rounded-lg border border-amber-400/55 px-3 py-1 text-xs text-amber-400">Dashboard</ModalDashboardLink>
    <GssLive />
  </div></main>;
}
