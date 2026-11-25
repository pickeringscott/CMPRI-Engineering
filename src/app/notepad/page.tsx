"use client";

import { useEffect, useRef, useState } from "react";
import Notepad from "@/components/Notepad";
import ModalDashboardLink from "@/components/ModalDashboardLink";
import { useUiLanguage } from "@/components/UiLanguageProvider";
import { notepadTargetId } from "@/lib/ui/notepad-navigation";
import { requestNotepadClose } from "@/lib/ui/notepad-close";
import { modalThemeStyle, modalTitleStyle } from "@/lib/ui/header-palette";
import "./notepad.css";

function finishClose() {
  if (window.parent !== window) window.parent.postMessage({ type: "cmpri-modal-close", modalToken: new URLSearchParams(window.location.search).get("modalToken") || "" }, window.location.origin);
  else window.history.back();
}

/** The independent Notepad window; legacy note URLs re-export this page. */
export default function NotepadPage() {
  const { t } = useUiLanguage();
  const page = useRef<HTMLElement>(null);
  const [targetNoteId, setTargetNoteId] = useState<string>();
  useEffect(() => {
    const target = () => setTargetNoteId(notepadTargetId(new URL(window.location.href)));
    target();
    window.addEventListener("hashchange", target);
    window.addEventListener("popstate", target);
    const onCancel = (event: Event) => {
      if (event.defaultPrevented) return;
      if (!requestNotepadClose(page.current, finishClose)) event.preventDefault();
    };
    document.addEventListener("cmpri-modal-cancel-request", onCancel);
    return () => {
      window.removeEventListener("hashchange", target);
      window.removeEventListener("popstate", target);
      document.removeEventListener("cmpri-modal-cancel-request", onCancel);
    };
  }, []);
  function close() {
    if (!requestNotepadClose(page.current, finishClose)) return;
    finishClose();
  }
  return <main ref={page} className="notepad-page" style={modalThemeStyle("Notepad")} onClickCapture={event => {
    const button = (event.target as Element).closest<HTMLButtonElement>("[data-cmpri-modal-dashboard='true']");
    if (event.defaultPrevented || !button || window.parent !== window) return;
    const href = button.dataset.cmpriModalDashboardHref || "/engineering";
    if (!requestNotepadClose(page.current, () => window.location.assign(href))) event.preventDefault();
  }}>
    <header className="notepad-page-heading" data-cmpri-page-heading style={modalTitleStyle("Notepad")}>
      <h1>{t("Notepad")}</h1>
      <div><ModalDashboardLink className="text-xs" /><button type="button" data-cmpri-modal-close="true" aria-label={t("Close Notepad")} onClick={close}>×</button></div>
    </header>
    <Notepad targetNoteId={targetNoteId} />
  </main>;
}
