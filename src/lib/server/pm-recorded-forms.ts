import 'server-only';
import { createHash } from 'node:crypto';
import manifest from './pm-recorded-forms.json';
import type { PmSourcePage } from '@/lib/pm/source-evidence';
import type { RecordedPmForm, RecordedPmPage } from '@/lib/pm/recorded-forms';

const fields = ['page','templateId','category','location','frequency','kind','rawDate','observedOn','evidence','findings','unresolved'] as const;
/** A batch projection of existing immutable evidence, not an update of current inspections.
 * Every page is bound to the reviewed source and exact evidence digest. A different
 * source, amended evidence or template mismatch can never inherit these answers.
 */
export function projectRecordedPmForms(sourceId: string, pages: PmSourcePage[]): Array<PmSourcePage & RecordedPmPage> {
  if (sourceId !== manifest.sourceId) return pages;
  return pages.map(page => {
    const entry = manifest.pages.find(item => item.page === page.page);
    if (!entry) return page;
    const digest = createHash('sha256').update(JSON.stringify(fields.map(field => page[field]))).digest('hex');
    if (entry.templateId !== page.templateId || digest !== entry.fingerprint) return { ...page, recordedFormsConflict: true };
    return { ...page, recordedForms: entry.forms as RecordedPmForm[] };
  });
}
