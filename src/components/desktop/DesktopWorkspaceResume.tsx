"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { loadCmpriSession, type CmpriClientSession } from "@/lib/auth/client-session";
import { canResumeWorkspaceView } from "@/lib/ui/workspace-route-access";
import { clearWorkspace, normalizeWorkspaceHref, readWorkspace, saveWorkspace, workspaceIdentity, type WorkspaceState, type WorkspaceView } from "@/lib/ui/workspace-resume";

type Props = {
  session: CmpriClientSession;
  allowedHrefs: string[];
  views: WorkspaceView[];
  zOrder: string[];
  onRestore: (desktop: WorkspaceState["desktop"]) => void;
  onSessionChanged: () => void;
  onStorageError: () => void;
};

/** Route/window recovery only; each editor owns its durable draft and save rules. */
export default function DesktopWorkspaceResume(props: Props) {
  const scope = JSON.stringify(workspaceIdentity(props.session));
  const desktopKey = JSON.stringify({ views: props.views, zOrder: props.zOrder });
  const latest = useRef(props);
  const ready = useRef("");
  const mountedScope = useRef(scope);
  const signedOut = useRef(false);
  const verifying = useRef(false);
  const warned = useRef(false);
  const [restoredScope, setRestoredScope] = useState("");
  useLayoutEffect(() => { latest.current = props; });

  useEffect(() => {
    const current = latest.current;
    const identity = workspaceIdentity(current.session);
    const origin = window.location.origin;
    const isAllowed = (view: WorkspaceView) => canResumeWorkspaceView(current.session, view);
    const options = { origin, isAllowed };
    const routes = new Set(current.allowedHrefs.flatMap(href => {
      const value = normalizeWorkspaceHref(href, origin);
      return value ? [new URL(value, origin).pathname] : [];
    }));
    const canRestore = (view: WorkspaceView) => {
      if (!isAllowed(view)) return false;
      if (view.kind !== "frame") return true;
      const path = new URL(view.href!, origin).pathname;
      return routes.has(path) || path === "/notes" || path === "/profile/ai-connection"
        || /^\/work-orders\/[^/]+$/.test(path) || view.key.startsWith("work-order-draft:");
    };
    ready.current = ""; signedOut.current = false; verifying.current = false; warned.current = false;
    let live = true;
    // The external-storage result and parent window restoration are committed
    // together before persistence is enabled for this freshly verified scope.
    void Promise.resolve().then(() => {
      if (!live || signedOut.current) return;
      if (mountedScope.current !== scope) {
        // Mounted editors belong to the previous verified principal. Rebuild
        // the dashboard before adopting a different account/property scope.
        signedOut.current = true;
        current.onSessionChanged();
        return;
      }
      try {
        const saved = readWorkspace(window.localStorage, identity, options);
        if (saved) {
          const views = saved.desktop.views.filter(canRestore);
          const keys = new Set(views.map(view => view.key));
          current.onRestore({ views, zOrder: saved.desktop.zOrder.filter(key => keys.has(key)) });
        }
        setRestoredScope(scope);
      } catch { current.onStorageError(); }
    });
    return () => {
      live = false;
      ready.current = "";
    };
  }, [scope]);

  useEffect(() => {
    if (restoredScope !== scope || signedOut.current || verifying.current) return;
    ready.current = scope;
    const current = latest.current;
    try {
      const saved = saveWorkspace(window.localStorage, workspaceIdentity(current.session), {
        desktop: { views: current.views, zOrder: current.zOrder },
      }, { origin: window.location.origin, isAllowed: view => canResumeWorkspaceView(current.session, view) });
      if (!saved && !warned.current) { warned.current = true; current.onStorageError(); }
    } catch { if (!warned.current) { warned.current = true; current.onStorageError(); } }
  }, [scope, restoredScope, desktopKey]);

  useEffect(() => {
    let live = true;
    const persist = () => {
      if (ready.current !== scope || signedOut.current || verifying.current) return;
      const current = latest.current;
      try {
        const saved = saveWorkspace(window.localStorage, workspaceIdentity(current.session), {
          desktop: { views: current.views, zOrder: current.zOrder },
        }, { origin: window.location.origin, isAllowed: view => canResumeWorkspaceView(current.session, view) });
        if (!saved && !warned.current) { warned.current = true; current.onStorageError(); }
      } catch { if (!warned.current) { warned.current = true; current.onStorageError(); } }
    };
    const signOut = () => {
      signedOut.current = true; ready.current = "";
      try { clearWorkspace(window.localStorage, workspaceIdentity(latest.current.session)); } catch {}
    };
    const visibility = () => { if (document.hidden) persist(); };
    const sessionChanged = (event: Event) => {
      if (signedOut.current || verifying.current
        || !(event as CustomEvent<{ topics?: string[] }>).detail?.topics?.includes("session")) return;
      verifying.current = true; ready.current = "";
      void loadCmpriSession().then(session => {
        if (!live || signedOut.current) return;
        if (JSON.stringify(workspaceIdentity(session)) !== scope) {
          signedOut.current = true;
          latest.current.onSessionChanged();
          return;
        }
        verifying.current = false; ready.current = scope;
        persist();
      }).catch(() => {
        if (!live || signedOut.current) return;
        signedOut.current = true;
        latest.current.onSessionChanged();
      });
    };
    window.addEventListener("pagehide", persist);
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("cmpri-workspace-sign-out", signOut);
    window.addEventListener("cmpri-data-cache-invalidated", sessionChanged);
    return () => {
      live = false;
      window.removeEventListener("pagehide", persist);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("cmpri-workspace-sign-out", signOut);
      window.removeEventListener("cmpri-data-cache-invalidated", sessionChanged);
    };
  }, [scope]);
  return null;
}
