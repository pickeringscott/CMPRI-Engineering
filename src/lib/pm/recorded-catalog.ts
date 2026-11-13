import definitions from './recorded-definitions.json';
import { findPmTemplate, type PmTemplate } from './catalog';

// Definition snapshot from the previously deployed cb9e7a6 lineage. It contains
// source questions/IDs, never inspection answers. Current forms stay in catalog.ts.
export function recordedTemplate(id: string, responses?: Record<string, unknown> | null) {
  const current = findPmTemplate(id);
  const historical = (definitions as PmTemplate[]).find(template => template.id === id) || null;
  if (!current || !historical) return { template: current || historical, mixed: false };
  const oldIds = new Set(historical.checklist.map(item => item.id));
  const currentIds = new Set(current.checklist.map(item => item.id));
  const keys = Object.keys(responses || {});
  const hasHistorical = keys.some(key => oldIds.has(key) && !currentIds.has(key));
  const hasCurrent = keys.some(key => currentIds.has(key) && !oldIds.has(key));
  return { template: hasHistorical ? historical : current, mixed: hasHistorical && hasCurrent };
}
