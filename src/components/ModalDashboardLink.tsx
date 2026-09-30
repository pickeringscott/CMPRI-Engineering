"use client";

import type { MouseEvent, ReactNode } from "react";

export default function ModalDashboardLink({
  href = "/engineering",
  className,
  children = "Dashboard",
}: {
  href?: string;
  className?: string;
  children?: ReactNode;
}) {
  const label = typeof children === "string"
    ? children.replace(/^\s*←\s*/, "")
    : children;

  function returnToDashboard(event: MouseEvent<HTMLButtonElement>) {
    if (event.defaultPrevented) return;
    if (window.parent !== window) {
      window.parent.postMessage({
        type: "cmpri-modal-dashboard",
        modalToken: new URLSearchParams(window.location.search).get("modalToken") || "",
      }, window.location.origin);
      return;
    }
    window.location.assign(href);
  }

  return <button type="button" data-cmpri-modal-dashboard="true" data-cmpri-modal-dashboard-href={href} onClick={returnToDashboard} className={className}>{label}</button>;
}
