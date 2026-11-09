import type { ManualKnowledge, TroubleshootingStepMedia } from '../manual-knowledge';
export type { TroubleshootingStepMedia } from '../manual-knowledge';
import { manualMatchesEquipment } from '../manual-document-match';
import { reportedDiagnosticCode } from '../manual-source';
import type { PmTaskActor, PmTaskState } from '../pm/task-review';
import { taskComplete } from '../pm/task-review';
import { guideRulesForIssue } from './guide-selection';

export type TroubleshootingChecklistAsset = {
  id: string;
  manufacturer?: string | null;
  model_family?: string | null;
  model_number?: string | null;
  documentation_key?: string | null;
  documentation_revision_id?: string | null;
  documentation_verified_at?: string | null;
};
export type TroubleshootingChecklistStep = {
  id: string;
  label: string;
  sourcePages: number[];
  sourceUrl?: string;
  kind: 'symptom' | 'error-code';
  code?: string;
  media?: TroubleshootingStepMedia[];
};
export type TroubleshootingChecklist = {
  contextKey: string | null;
  contextIdentity: string | null;
  revision: number;
  actor: PmTaskActor;
  canEdit: boolean;
  canClearAll: boolean;
  canClearOwn: boolean;
  canSeePendingReview: boolean;
  steps: TroubleshootingChecklistStep[];
  taskStates: Record<string, PmTaskState>;
  pendingVisits: { visitId: string; startedAt: string; lastEventAt: string | null; eventCount: number }[];
  reason?: string;
};

/** Pending review is red only for an actual Chief; other readers see completion. */
export function troubleshootingTaskVisual(state: PmTaskState | undefined, canSeePendingReview: boolean) {
  return canSeePendingReview ? state?.status || 'empty' : taskComplete(state) ? 'approved' : 'empty';
}

/**
 * A client-safe identity lets the screen reject a ledger for a different saved
 * issue or manual. URLs are deliberately omitted: private access links rotate.
 * The server hashes this identity and derives every allowed step independently.
 */
export function deriveTroubleshootingChecklistContext(input: {
  issue: string;
  reporter_notes?: string | null;
  asset?: TroubleshootingChecklistAsset | null;
}, knowledge: ManualKnowledge | null | undefined): { contextIdentity: string | null; steps: TroubleshootingChecklistStep[] } {
  const asset = input.asset;
  if (!asset || knowledge?.source?.verified !== true || knowledge.source.source_kind !== 'asset-upload'
    || !knowledge.source.storage_path || !knowledge.source.registered_file_id || !/^[a-f0-9]{64}$/.test(knowledge.source.sha256 || '')
    || !manualMatchesEquipment(asset, knowledge)) return { contextIdentity: null, steps: [] };
  const evidence = `${input.issue} ${input.reporter_notes || ''}`.trim();
  const steps: TroubleshootingChecklistStep[] = [];
  const seen = new Set<string>();
  const append = (label: string, kind: TroubleshootingChecklistStep['kind'], pages: number[] = [], sourceUrl?: string, code?: string) => {
    label = label.trim();
    if (!label) return;
    const sourcePages = [...new Set(pages.filter(page => Number.isSafeInteger(page) && page > 0))].sort((a, b) => a - b);
    const identity = JSON.stringify({ label, sourcePages, kind, code });
    if (seen.has(identity)) return;
    seen.add(identity);
    const media = (knowledge.step_media || []).filter(item => item.stepLabel === label && sourcePages.includes(item.sourcePage));
    steps.push({ id: `step-${steps.length + 1}`, label, sourcePages, ...(sourceUrl ? { sourceUrl } : {}), kind, ...(code ? { code } : {}), ...(media.length ? { media } : {}) });
  };
  for (const rule of guideRulesForIssue(knowledge, evidence)) {
    for (const step of rule.steps) append(step, 'symptom', rule.source_pages, rule.source_url);
  }
  // A displayed alarm must actually be reported. Nearby temperature numbers,
  // imported ticket IDs, and symptom similarity do not establish an alarm.
  const code = reportedDiagnosticCode(evidence);
  if (code) for (const entry of knowledge.error_codes || []) {
    if (entry.code.replace(/[^a-z0-9]/gi, '').toUpperCase() === code) {
      append(entry.action, 'error-code', entry.source_pages, entry.source_url, entry.code);
    }
  }
  const text = (value: string | null | undefined) => value || '';
  const contextIdentity = JSON.stringify({
    version: 2,
    issue: input.issue,
    reporter_notes: text(input.reporter_notes),
    asset: {
      id: asset.id, manufacturer: text(asset.manufacturer), model_family: text(asset.model_family), model_number: text(asset.model_number),
      documentation_key: text(asset.documentation_key), documentation_revision_id: text(asset.documentation_revision_id), documentation_verified_at: text(asset.documentation_verified_at),
    },
    source: {
      title: text(knowledge.source.title), file: text(knowledge.source.source_file_name), type: text(knowledge.source.type),
      kind: knowledge.source.source_kind, storage_path: knowledge.source.storage_path, sha256: knowledge.source.sha256,
      registered_file_id: knowledge.source.registered_file_id, registered_updated_at: knowledge.source.registered_updated_at || null,
    },
    steps: steps.map(step => ({ id: step.id, label: step.label, sourcePages: step.sourcePages, kind: step.kind, ...(step.code ? { code: step.code } : {}), ...(step.media?.length ? { media: step.media } : {}) })),
  });
  return { contextIdentity, steps };
}
