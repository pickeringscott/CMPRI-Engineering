"use client";
import { useUiLanguage } from "@/components/UiLanguageProvider";
import type { PartStatus } from '@/lib/work-order-parts';
const colors:Record<PartStatus,string> = {
  'In-House':'border-gray-500 bg-gray-800 text-gray-200',
  'Need to Order':'border-amber-400/50 bg-amber-950/45 text-amber-200',
  'On Order':'border-blue-400/50 bg-blue-950/45 text-blue-200',
  'Received':'border-green-400/50 bg-green-950/45 text-green-200',
};
export default function PartsStatusPill({status}:{status?:PartStatus|null}) {
  const { t, tt } = useUiLanguage();
  if(!status || !colors[status]) return null;
  return <span data-parts-status={status} aria-label={t("Parts: {value0}", { value0: String(t(status)) })} title={tt("Parts status; mixed parts show the first unresolved stage")} className={`cmpri-parts-status-pill ${colors[status]}`}>{t(status)}</span>;
}
