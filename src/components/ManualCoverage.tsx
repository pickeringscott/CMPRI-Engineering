import type {ManualKnowledge} from '@/lib/manual-knowledge';
export default function ManualCoverage({knowledge}:{knowledge:ManualKnowledge}){
  const sources=knowledge.sources?.length?knowledge.sources:knowledge.source?[knowledge.source]:[];
  return <div className="mt-1 text-xs text-slate-400" aria-label="Manual reading coverage">{sources.map(source=><p key={`${source.registered_file_id}:${source.sha256}`}>
    {source.source_file_name||source.title}: {source.coverage?`${source.coverage.indexed_pages} of ${source.coverage.total_pages} pages indexed${source.coverage.needs_ocr.length?`; ${source.coverage.needs_ocr.length} require recognition or review`:''}`:'Source coverage is not available.'}
  </p>)}</div>;
}
