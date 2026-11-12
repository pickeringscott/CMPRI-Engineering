import type { ManualKnowledge, ManualSymptomRule } from "../manual-knowledge";
import { reportedDiagnosticCode } from '../manual-source';

export function equipmentSearchAliases(value: string): string[] {
  return [value, ...(/\b(friedrich|frederick)\b/i.test(value) ? ["Friedrich", "Frederick"] : []),
    ...(/\bvert[ -]?i?[ -]?pak\b/i.test(value) ? ["Vert-I-Pak", "Vertipak", "Verti Pak"] : [])];
}

function symptomText(value: string) {
  return value.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/[’‘]/g, "'")
    .replace(/\bwon'?t\b/g, 'will not').replace(/\bcan'?t\b/g, 'cannot')
    .replace(/\bdoesn'?t\b/g, 'does not').replace(/\bdon'?t\b/g, 'do not')
    .replace(/\bisn'?t\b/g, 'is not').replace(/\baren'?t\b/g, 'are not')
    .replace(/\bwasn'?t\b/g, 'was not').replace(/\bweren'?t\b/g, 'were not')
    .replace(/\b(noisy|noises|loud)\b/g, "noise")
    .replace(/\b(rattling|rattles)\b/g, "rattle").replace(/\b(vibrating|vibrates)\b/g, "vibration")
    .replace(/[^a-z0-9]+/g, " ").replace(/\bnoise(?:\s+noise)+\b/g, 'noise').trim();
}

type Symptom = 'power' | 'operation' | 'heat' | 'cool' | 'drain' | 'fill' | 'leak' | 'noise' | 'rattle' | 'vibration';
const failure = '(?:will not|does not|do not|cannot|can not|not|no longer|unable to|fails? to)';
const symptomPatterns: { symptom: Symptom; pattern: RegExp }[] = [
  { symptom: 'power', pattern: new RegExp(`\\b(?:no\\s*power|${failure} (?:turn on|switch on|power on|start(?:ing)?))\\b`, 'g') },
  { symptom: 'operation', pattern: /\b(?:(?:will not|does not|do not|is not|not|no longer) (?:work(?:ing)?|operat(?:e|ing))|inoperative|inoperable)\b/g },
  { symptom: 'heat', pattern: new RegExp(`\\b(?:no\\s*heat|no hot water|${failure} (?:heat(?:ing)?|(?:get(?:ting)?|become) (?:hot|warm)))\\b`, 'g') },
  { symptom: 'cool', pattern: new RegExp(`\\b(?:no\\s*cool(?:ing)?|${failure} (?:cool(?:ing)?|(?:get(?:ting)?|become) cold))\\b`, 'g') },
  { symptom: 'drain', pattern: new RegExp(`\\b(?:no\\s*drain(?:ing)?|${failure} drain(?:ing)?|drain (?:failure|failed))\\b`, 'g') },
  { symptom: 'fill', pattern: new RegExp(`\\b(?:no\\s*fill(?:ing)?|${failure} fill(?:ing)?|fill (?:failure|failed))\\b`, 'g') },
  { symptom: 'leak', pattern: /\b(?:water leak(?:age|ing|s)?|leak(?:age|ing|s)?|drip(?:ping|s)?|water (?:is |was )?(?:all )?(?:over|on|across) (?:the )?(?:floor|ground))\b/g },
  { symptom: 'noise', pattern: /\b(?:(?:abnormal|unusual|excessive) )?noise\b/g },
  { symptom: 'rattle', pattern: /\brattle\b/g },
  { symptom: 'vibration', pattern: /\bvibration\b/g },
];

function concepts(text: string, everyday = false) {
  const result = new Set<Symptom>();
  for (const { symptom, pattern } of symptomPatterns) if ([...text.matchAll(pattern)].length) result.add(symptom);
  if (everyday && result.has('rattle')) result.add('noise');
  if (everyday && /\bbroken\b/.test(text)) result.add('operation');
  if (everyday && [...result].some(symptom => symptom !== 'operation')) result.delete('operation');
  return result;
}

function topics(text: string) {
  const found = concepts(text, true);
  for (const [symptom, pattern] of [
    ['power', /\b(?:power|start|starting|turn on)\b/], ['operation', /\b(?:working|operating|operate|broken)\b/],
    ['heat', /\b(?:heat|heating|hot|warm)\b/], ['cool', /\b(?:cool|cooling|cold)\b/],
    ['drain', /\bdrain(?:ing)?\b/], ['fill', /\bfill(?:ing)?\b/],
  ] as const) if (pattern.test(text)) found.add(symptom);
  return found;
}

/** Keep denials and normal operating reports out of both literal and alias matching. */
function issueEvidence(issue: string) {
  const latest = new Map<Symptom, boolean>();
  const clauses: { text: string; symptoms: Set<Symptom> }[] = [];
  for (const raw of issue.split(/[.;!?\n,]+|\b(?:but|however|although|yet|and)\b/i)) {
    let text = symptomText(raw);
    if (!text) continue;
    const metaDenial = /\b(?:no (?:issues?|problems?|trouble|concerns?|faults?)|no (?:cooling|heating|power|draining|filling|leakage|noise) (?:issues?|problems?|faults?)|without (?:any )?(?:issues?|problems?)|not (?:an? )?(?:issue|problem)|nothing wrong|denies|denied|ruled out|unconfirmed|do not think|do not believe|no longer (?:not|does not|will not|cannot))\b/.test(text);
    const hypothetical = /^(?:if|unless|suppose|what if|in case|could|might|would)\b|\b(?:maybe|perhaps|possibly|hypothetical|suspected|not sure)\b/.test(text);
    const operatingNormally = /\b(?:works?|working|operates?|operating) (?:fine|normally|properly|ok|okay)\b|\b(?:heating|cooling|draining|filling|power|noise|rattle|vibration) (?:is |are )?(?:fine|normal|normally|ok|okay|works?)\b/.test(text)
      && !/\bnot (?:work|working|operat|operating)/.test(text);
    if (metaDenial || hypothetical || operatingNormally) {
      for (const topic of topics(text)) latest.set(topic, false);
      continue;
    }
    // A coordinated absence such as "no leaks or noise" denies both nouns.
    const coordinatedAbsence = /\b(?:no|not|never|no longer) (?:(?:a|an|any|the|visible|abnormal|unusual|excessive) )*(?:water )?(?:leak(?:age|ing|s)?|noise|rattle|vibration)(?: or (?:(?:a|an|any|the|visible|abnormal|unusual|excessive) )*(?:water )?(?:leak(?:age|ing|s)?|noise|rattle|vibration))+/g;
    for (const absent of text.matchAll(coordinatedAbsence)) for (const symptom of concepts(absent[0], true)) latest.set(symptom, false);
    text = text.replace(coordinatedAbsence, ' ').replace(/\s+/g, ' ').trim();
    // The absence of a leak/noise is normal; "not heating" is a failure and
    // deliberately follows a different path. Only explicit absence is removed.
    for (const [symptom, pattern] of [
      ['leak', /\b(?:(?:does not|is not|not|never|no longer) (?:a )?(?:water )?(?:leak(?:age|ing|s)?|drip(?:ping|s)?)|no (?:(?:signs?|evidence|indication) of )?(?:(?:any|visible|active|current|actual) )*(?:water )?leak(?:age|ing|s)?|no water (?:on|over) (?:the )?floor)\b/g],
      ['noise', /\b(?:(?:is not|not|never|no longer) (?:(?:abnormal|unusual|excessive) )?noise|(?:does not|do not|cannot|never|not) (?:make|making|hear|hearing|get|gets|getting) (?:(?:a|an|any|the) )?noise|no (?:(?:signs?|evidence|indication) of )?(?:(?:abnormal|unusual|excessive) )?noise)\b/g],
      ['rattle', /\b(?:(?:does not|is not|not|never|no longer) (?:(?:abnormal|unusual|excessive) )?rattle|no (?:(?:abnormal|unusual|excessive) )?rattle)\b/g],
      ['vibration', /\b(?:(?:is not|not|never|no longer) (?:(?:abnormal|unusual|excessive) )?vibration|no (?:(?:abnormal|unusual|excessive) )?vibration)\b/g],
    ] as const) {
      if ([...text.matchAll(pattern)].length) { latest.set(symptom, false); text = text.replace(pattern, ' ').replace(/\s+/g, ' ').trim(); }
    }
    const symptoms = concepts(text, true);
    for (const symptom of symptoms) latest.set(symptom, true);
    if (text) clauses.push({ text, symptoms });
  }
  return clauses.filter(clause => ![...clause.symptoms].some(symptom => latest.get(symptom) === false));
}

const sourceEquipmentWords = new Set('a an the is are does do will can cannot not no to this that has have unit units equipment appliance machine washer washing dryer drying system device room hvac ac air conditioner conditioning heater boiler television tv pump door lock water'.split(' '));
const sourceComponentWords = new Set('compressor motor fan controller sensor filter'.split(' '));

function sourceAliasMatches(phrase: string, evidence: ReturnType<typeof issueEvidence>) {
  // These headings contain additional operating conditions or diagnostic IDs.
  // Retain their full literal requirement rather than guessing the conditions.
  if (/\b(?:when|while|during|after|before|only|unless|if|below|above|without|with|and|or)\b|\d/.test(phrase)) return false;
  const sourceSymptoms = concepts(phrase);
  if (!sourceSymptoms.size) return false;
  let remainder = phrase;
  for (const { pattern } of symptomPatterns) remainder = remainder.replace(pattern, ' ');
  const requiredWords = remainder.split(/\s+/).filter(word => word && !sourceEquipmentWords.has(word));
  // A bare equipment symptom can be translated. Arbitrary qualifiers such as
  // "gas odor present" or "flow switch open" must retain their full literal
  // wording; an unordered bag of words cannot establish their polarity.
  if (requiredWords.some(word => !sourceComponentWords.has(word))) return false;
  return evidence.some(clause => {
    if (requiredWords.some(word => !(` ${clause.text} `).includes(` ${word} `))) return false;
    return [...sourceSymptoms].some(symptom => clause.symptoms.has(symptom) || (symptom === 'operation' && clause.symptoms.has('power')));
  });
}

function literalMatches(phrase: string, evidence: ReturnType<typeof issueEvidence>) {
  return evidence.some(clause => {
    const haystack = ` ${clause.text} `, needle = ` ${phrase} `;
    let index = haystack.indexOf(needle);
    while (index >= 0) {
      const before = haystack.slice(0, index).trim();
      const after = haystack.slice(index + needle.length).trim();
      // Remove the matched heading before looking for qualification. Its own
      // "no/not" describes the failure; a remaining denial or uncertainty
      // means this literal heading was mentioned rather than positively reported.
      const denied = /\b(?:no|not|never|without|ruled out|unconfirmed|unsure|uncertain|maybe|perhaps|possibly|suspected|hypothetical|if|unless|whether|might|could)\b/.test(`${before} ${after}`);
      if (!denied) return true;
      index = haystack.indexOf(needle, index + needle.length - 1);
    }
    return false;
  });
}

/** Route only text already extracted from verified documentation; never invent steps. */
export function guideRulesForIssue(knowledge: ManualKnowledge | null | undefined, issue: string): ManualSymptomRule[] {
  if (knowledge?.source?.verified !== true) return [];
  const evidence = issueEvidence(issue);
  const reportedCode = reportedDiagnosticCode(issue);
  const rules = [...(knowledge.symptom_rules || []), ...(knowledge.manual_tests || []).filter(test => test.match?.length).map(test => ({
    match: test.match || [], steps: test.steps?.length ? test.steps : [test.test || test.action || ""].filter(Boolean), source_pages: test.source_pages,
  }))];
  const matched = rules.filter(rule => !('reference_only' in rule && rule.reference_only) && !!rule.match?.length && rule.match.some(phrase => {
    const normalized = symptomText(phrase);
    // Code-qualified headings require the same positive exact report as the
    // diagnostic-code section. Literal text in a denial cannot bypass it.
    const sourceCodes = [...normalized.matchAll(/\b[a-z]{1,4} ?\d{1,4}[a-z0-9]{0,6}\b/g)].map(match => match[0].replace(/ /g, '').toUpperCase());
    const numericCode = reportedDiagnosticCode(normalized);
    if (numericCode) sourceCodes.push(numericCode);
    if (sourceCodes.length && sourceCodes.some(code => code !== reportedCode)) return false;
    return normalized !== "" && (literalMatches(normalized, evidence) || sourceAliasMatches(normalized, evidence));
  }));
  return matched;
}
