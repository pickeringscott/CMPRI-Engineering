/** Technician text informs filtering; it never supplies manufacturer instructions. */
export function technicianTroubleshootingContext(notes?:string|null,rootCause?:string|null){
  return [notes||'',rootCause||''].flatMap(value=>value.split('\n')).map(line=>line.startsWith('CMPRI2|')?line.split('|').slice(5).join('|'):line)
    .filter(line=>!/^\s*(?:Troubleshooting(?: checklist)?(?: visit)?\s*:|Original source ticket|Canonical ID|Approved import row|Source ticket ID)/i.test(line)).join('\n');
}
export function diagnosticCodeRuledOut(code:string,context:string){
  const escaped=code.replace(/[^a-z0-9]/gi,'');
  if(!escaped)return false;
  return new RegExp(`\\b(?:not\\s+(?:error\\s+|fault\\s+)?code\\s*${escaped}\\b|(?:error\\s+|fault\\s+)?code\\s*${escaped}\\s+(?:(?:is|was|has been)\\s+)?(?:ruled out|not present|absent|cleared|resolved)\\b)`,'i').test(context);
}
