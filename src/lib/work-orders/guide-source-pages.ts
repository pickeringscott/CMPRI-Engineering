import type { ManualKnowledge } from '../manual-knowledge';
import { relevantSourcePassages } from '../manual-source';
import type { TroubleshootingChecklistStep } from './troubleshooting-checklist';

/** Keep the guide's source pages tied to the same steps as its saved checklist. */
export function guideSourcePages(knowledge: ManualKnowledge | null, issue: string, technicianContext: string, steps: TroubleshootingChecklistStep[]) {
  const passages = knowledge?.source_passages || [];
  if (!steps.length) return relevantSourcePassages(passages, issue, technicianContext);
  return passages.filter(passage => steps.some(step => step.sourcePages.includes(passage.page)
    && (step.source_document_id || knowledge?.source?.registered_file_id) === (passage.source_document_id || knowledge?.source?.registered_file_id)
    && (step.source_sha256 || knowledge?.source?.sha256) === (passage.source_sha256 || knowledge?.source?.sha256)));
}
