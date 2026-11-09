"use client";

import { useEffect, useState } from "react";
import { authorizationHeaders } from "@/lib/auth/client-session";
import GssSourceReportView, { parseSourceReport, type SourceReportState } from "./GssSourceReportView";

export default function GssSourceReport({ verifiedDate }: { verifiedDate: string }) {
  const [state, setState] = useState<SourceReportState>({ status: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const response = await fetch("/api/engineering/gss/source", { headers: await authorizationHeaders(), cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("Source report unavailable");
        const report = parseSourceReport(await response.json());
        if (!report) throw new Error("Invalid source report");
        if (!controller.signal.aborted) setState({ status: "ready", report });
      } catch {
        if (!controller.signal.aborted) setState({ status: "error" });
      }
    })();
    return () => controller.abort();
  }, []);
  return <GssSourceReportView state={state} verifiedDate={verifiedDate} />;
}
