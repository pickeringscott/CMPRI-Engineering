"use client";
import { useEffect, useRef, type ReactNode } from "react";

/** Native modal focus containment/return; closing never confirms or cancels saved PM data. */
export default function PmIssueDialog({ children, label, busy, onDismiss }: {
  children: ReactNode; label: string; busy: boolean; onDismiss: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement as HTMLElement | null;
    dialog?.showModal();
    return () => { dialog?.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  return <dialog ref={ref} aria-label={label} onCancel={event => {
    event.preventDefault();
    if (!busy) onDismiss();
  }} className="m-auto w-[calc(100%_-_24px)] max-w-xl max-h-[90dvh] overflow-y-auto border-0 bg-transparent p-0 text-white backdrop:bg-black/80">
    {children}
  </dialog>;
}
