/** Technician text informs filtering; it never supplies manufacturer instructions. */
export function technicianTroubleshootingContext(notes?:string|null,rootCause?:string|null){
  return [notes||'',rootCause||''].flatMap(value=>value.split('\n')).map(raw=>{
    const line=raw.trim();
    if(line.startsWith('CMPRI2|')){const parts=line.split('|');return parts[4]==='note'?parts.slice(5).join('|'):'';}
    if(line.startsWith('CMPRI|')){const parts=line.split('|');return parts[3]==='note'?parts.slice(4).join('|'):'';}
    const original=line.match(/^Original technician notes:\s*(.*)$/i);
    if(original)return /^(?:blank|none|unspecified)\.?$/i.test(original[1])?'':original[1];
    return line;
  }).filter(line=>line&&!/^\s*(?:Troubleshooting(?: checklist)?(?: visit)?\s*:|Original source ticket|Canonical ID|Approved import row|Source ticket ID|Import provenance\b|Imported from\b|Approved source:|Original (?:location|category|requester)(?:\/source creator)?:|Verified source creator labels:|Source context already present\b)/i.test(line)).join('\n');
}
export function diagnosticCodeRuledOut(code:string,context:string){
  const escaped=code.replace(/[^a-z0-9]/gi,'');
  if(!escaped)return false;
  return new RegExp(`\\b(?:not\\s+(?:error\\s+|fault\\s+)?code\\s*${escaped}\\b|(?:error\\s+|fault\\s+)?code\\s*${escaped}\\s+(?:(?:is|was|has been)\\s+)?(?:ruled out|not present|absent|cleared|resolved)\\b)`,'i').test(context);
}
