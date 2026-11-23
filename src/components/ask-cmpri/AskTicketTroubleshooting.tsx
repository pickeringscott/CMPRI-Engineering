"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useUiLanguage } from "@/components/UiLanguageProvider";
import type { AskResponse } from "@/lib/ask-cmpri/types";
import { authorizationHeaders } from "@/lib/auth/client-session";
import { AskCmpriAnswer } from "./AskCmpriAnswer";

type Props = { workOrderId: string; assetId: string; assetLabel: string; active: boolean };

export default function AskTicketTroubleshooting({ workOrderId, assetId, assetLabel, active }: Props) {
  const { language, t } = useUiLanguage();
  const request = useRef<AbortController>(null);
  const [result, setResult] = useState<AskResponse | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async (web: boolean) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/ask-cmpri/troubleshooting", {
        method: "POST", cache: "no-store", signal: controller.signal,
        headers: { ...await authorizationHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ workOrderId, assetId, language, web }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || typeof body?.summary !== "string") throw new Error(body?.error || "Ask CMPRI could not complete this troubleshooting request.");
      if (!controller.signal.aborted) setResult(body);
    } catch (error) {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Ask CMPRI is unavailable.");
    } finally {
      if (request.current === controller && !controller.signal.aborted) setPending(false);
    }
  }, [assetId, language, workOrderId]);

  useEffect(() => {
    if (!active) return;
    const start = window.setTimeout(() => void load(true), 0);
    return () => {
      window.clearTimeout(start);
      request.current?.abort();
    };
  }, [active, load]);

  return <section className="mt-1 rounded-xl border border-slate-700 bg-slate-950 p-2 text-sm" aria-label={t("Ask CMPRI troubleshooting", "Diagnóstico con Ask CMPRI")}>
    <h3 className="flex items-center gap-1 font-semibold"><i className="ask-gemini-mark" aria-hidden="true" />Ask CMPRI</h3>
    <p>{t("Selected equipment", "Equipo seleccionado")} · {assetLabel}</p>
    {pending && <p role="status">{t("Checking equipment sources…", "Consultando las fuentes del equipo…")}</p>}
    {error && <p role="alert" className="text-amber-200">{error}</p>}
    {result && <AskCmpriAnswer result={result} openRecord={() => {}} />}
    <button type="button" onClick={() => void load(true)} disabled={!active || pending} className="mt-1 rounded border border-sky-500 px-2 py-1 text-sky-200">
      {t("Search manufacturer sources", "Buscar fuentes del fabricante")}
    </button>
  </section>;
}
