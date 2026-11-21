"use client";

import { useEffect, useState } from "react";
import { hasCapability, loadCmpriSession } from "@/lib/auth/client-session";
import { enforceSessionPreference } from "@/lib/auth/session-preference";
import { canReadChiefModules } from "@/lib/dashboard/chief-module-access";
import PurchaseOrders from "./PurchaseOrders";

export default function PurchasingPage() {
  const [access, setAccess] = useState<{ canManage: boolean; canImport: boolean } | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        if (!await enforceSessionPreference()) return;
        const session = await loadCmpriSession();
        const canManage = hasCapability(session, "manage_assets");
        if (!canManage && !canReadChiefModules(session.user)) {
          if (active) window.location.replace(session.landing);
          return;
        }
        if (active) setAccess({ canManage, canImport: canManage && hasCapability(session, "operate_integrations") });
      } catch {
        if (active) window.location.replace("/");
      }
    })();
    return () => { active = false; };
  }, []);

  return access && <PurchaseOrders canManage={access.canManage} canImport={access.canImport} />;
}
