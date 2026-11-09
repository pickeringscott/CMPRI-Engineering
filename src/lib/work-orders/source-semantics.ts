export type SourceSemantics = {
  kind: 'urgent' | 'caution' | 'success' | 'information';
  label: string;
  color: string;
};

const badges: Record<SourceSemantics['kind'], SourceSemantics> = {
  urgent: { kind: 'urgent', label: 'Urgent', color: '#ef4444' },
  caution: { kind: 'caution', label: 'Caution', color: '#fbbf24' },
  success: { kind: 'success', label: 'Complete', color: '#34d399' },
  information: { kind: 'information', label: 'Information', color: '#7dd3fc' },
};
const priority: SourceSemantics['kind'][] = ['urgent', 'caution', 'success', 'information'];

function negativeOutcome(text: string) {
  const value = text.trim().replace(/^[:：!–—\-('"“‘]+\s*/, '');
  return /^(?:not|no|never|false|incomplete|unsuccessful|fail(?:ed|ure)?)\b/i.test(value)
    || /\b(?:fail(?:ed|ures?)?|unsuccessful|incomplete)\b/i.test(value)
    || /\b(?:not|never)\s+(?:(?:yet|been)\s+)*(?:achieved|complete(?:d)?|successful?|passed?|confirmed|done)\b/i.test(value);
}

function markerKind(line: string): SourceSemantics['kind'] | null {
  // Accept visible source labels, not a safety word buried in ordinary prose.
  const text = line.trim().replace(/^#{1,6}\s+/, '').replace(/\s+#{1,6}\s*$/, '').replace(/^(?:[-+*]\s+|\d+[.)]\s+)/, '').replace(/\*\*|__/g, '').trim();
  const match = /^(?:\[\s*(URGENT|DANGER|EMERGENCY|CAUTION|WARNING|COMPLETE|SUCCESS|INFORMATION|NOTICE|(?:TEST\s+)?RESULT)\s*\]|(URGENT|DANGER|EMERGENCY|CAUTION|WARNING|COMPLETE|SUCCESS|INFORMATION|NOTICE|(?:TEST\s+)?RESULT)(?=\s*(?:[:：!–—-]|$)))(?:\s*[:：!–—-])?\s*(.*)$/i.exec(text);
  if (!match) return null;
  const marker = (match[1] || match[2]).toUpperCase();
  if (['URGENT', 'DANGER', 'EMERGENCY'].includes(marker)) return 'urgent';
  if (['CAUTION', 'WARNING'].includes(marker)) return 'caution';
  if (['COMPLETE', 'SUCCESS'].includes(marker)) return negativeOutcome(match[3]) ? null : 'success';
  if (['INFORMATION', 'NOTICE'].includes(marker)) return 'information';
  // A result heading is green only when its explicit outcome is positive.
  const result = /^(complete(?:d)?|success(?:ful)?|pass(?:ed)?|ok)(?:\s*[.!]?\s*$|\s*[:：–—-]|\s*\()/i.exec(match[3]);
  return result && !negativeOutcome(match[3].slice(result[1].length)) ? 'success' : null;
}

function immediateCall(line: string) {
  // Quoted mentions and questions do not instruct the reader to place a call.
  const unquoted = line.replace(/"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’|(?<!\w)'[^'\n]*'(?!\w)/g, ' ');
  for (const clause of unquoted.split(/[.;\n]/)) {
    if (clause.includes('?')) continue;
    const instruction = /\b(?:call|contact)\b[^.!?;\n]{0,160}\bimmediately\b|\bimmediately\s+(?:call|contact)\b/i.exec(clause);
    if (!instruction) continue;
    const preceding = clause.slice(0, instruction.index);
    // A negated symptom in an explicit conditional does not negate the call:
    // "If it does not restart, call service immediately."
    const conditionalEnd = /^\s*(?:if|when|unless|after|once)\b/i.test(preceding) ? preceding.lastIndexOf(',') : -1;
    const directive = preceding.slice(conditionalEnd + 1) + instruction[0];
    if (/\b(?:no|not|never|without|avoid|cannot)\b|\b(?:don['’]t|can['’]t|shouldn['’]t|mustn['’]t|needn['’]t|wouldn['’]t)\b/i.test(directive)) continue;
    if (/\b(?:example|quotation|quoted|says?|said|reads?|mentions?|whether|might|could|may)\b/i.test(preceding)) continue;
    const following = clause.slice(instruction.index + instruction[0].length);
    if (/^\s*(?:(?:is|are|was|were|should|must|would|could|may|will|can|need)\s+(?:not|never)\b|(?:isn|aren|wasn|weren|shouldn|mustn|wouldn|couldn|won|can|needn)['’]t\b|(?:not|never)\s+(?:needed|required|necessary)\b|(?:is|are|was|were)\s+(?:unnecessary|optional|prohibited|forbidden)\b)/i.test(following)) continue;
    return true;
  }
  return false;
}

/** Visual source labels only: callers must supply step labels/captions, never issue priority or checkbox state. */
export function sourceSemantics(...sourceTexts: string[]): SourceSemantics | null {
  const found = new Set<SourceSemantics['kind']>();
  for (const source of sourceTexts) {
    if (typeof source !== 'string') continue;
    for (const line of source.split(/\r?\n/)) {
      const kind = markerKind(line);
      if (kind) found.add(kind);
      if (immediateCall(line)) found.add('urgent');
    }
  }
  const kind = priority.find(value => found.has(value));
  return kind ? { ...badges[kind] } : null;
}
