"use client";
import { useUiLanguage } from "@/components/UiLanguageProvider";
import type {ManualKnowledge} from '@/lib/manual-knowledge';
export default function ManualCoverage({knowledge}:{knowledge:ManualKnowledge}){
  const { t } = useUiLanguage();
  const sources=knowledge.sources?.length?knowledge.sources:knowledge.source?[knowledge.source]:[];
  return <div className="mt-1 text-xs text-slate-400" aria-label={t("Manual reading coverage")}>{sources.map(source=><p key={`${source.registered_file_id}:${source.sha256}`}>
    {source.source_file_name||source.title}: {source.coverage?t("{indexed} of {total} pages indexed", {indexed: source.coverage.indexed_pages, total: source.coverage.total_pages})+(source.coverage.needs_ocr.length?"; "+t("{count} require recognition or review", {count: source.coverage.needs_ocr.length}):""):t("Source coverage is not available.")}
  </p>)}</div>;
}
