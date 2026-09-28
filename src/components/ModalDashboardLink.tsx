"use client";

import type { ReactNode, MouseEvent } from "react";

export default function ModalDashboardLink({
  href = "/engineering",
  className,
  children = "← Dashboard",
}: {
  href?: string;
  className?: string;
  children?: ReactNode;
}) {
  function closeModal(event: MouseEvent<HTMLAnchorElement>) {
    const params = new URLSearchParams(window.location.search);
    if (params.get("embedded") !== "1" || window.parent === window) return;
    event.preventDefault();
    window.parent.postMessage(
      { type: "cmpri-modal-dashboard", modalToken: params.get("modalToken") || "" },
      window.location.origin,
    );
  }

  return <a href={href} onClick={closeModal} className={className}>{children}</a>;
}
