"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export const SeasonalAnimationControls = createContext<(host: HTMLDivElement | null) => void>(() => {});
const ControlHost = createContext<HTMLDivElement | null>(null);

export function SeasonalAnimationControlProvider({ children }: { children: ReactNode }) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  return <SeasonalAnimationControls.Provider value={setHost}>
    <ControlHost.Provider value={host}>{children}</ControlHost.Provider>
  </SeasonalAnimationControls.Provider>;
}

export function SeasonalAnimationControl({ children }: { children: ReactNode }) {
  const host = useContext(ControlHost);
  return host ? createPortal(children, host) : children;
}
