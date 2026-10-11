import { classifyAsset } from "./asset-category";
import { normalizeWorkOrderCategory } from "./work-order-categories";

export type SuggestionAsset = {
  id: string; name: string; asset_type: string; location_id?: string | null;
  manufacturer?: string | null; model_number?: string | null; generation?: string | null;
  asset_tag?: string | null; documentation_key?: string | null; active?: boolean | null;
  status?: string | null; binder_tag?: string | null; quantity?: number | null;
};
export type SmartSuggestion = { assetId: string | null; category: string | null; priority: string | null; reason: string };

function categoryForAsset(asset: SuggestionAsset) {
  return classifyAsset(asset);
}

function normalizedIssueText(value: string) {
  return value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

export function assetTermsForPlumbingIssue(issue: string) {
  const text = normalizedIssueText(issue);
  return ["toilet", "sink", "faucet", "shower", "drain", "pipe", "plumbing"]
    .filter((term) => new RegExp(`\\b${term}\\b`).test(text));
}

export function priorityForCategory(category: string) {
  switch (normalizeWorkOrderCategory(category) || category) {
    case "Safety":
    case "HVAC":
    case "Pool/Spa":
    case "Doors/Locks":
      return "High";
    case "Furniture":
      return "Low";
    default:
      return "Medium";
  }
}

export function categoryFromIssue(issue: string) {
  const text = normalizedIssueText(issue);

  if (/\b(saflok|door lock|lockset|key card|keycard|rfid lock|door won't lock|door will not lock|door won't unlock|door will not unlock|cerradura|tarjeta llave|tarjeta de acceso|puerta no cierra|puerta no abre)\b/.test(text)) return "Doors/Locks";
  if (/\b(fire|alarm|smoke|sprinkler|life safety|carbon monoxide|co detector|incendio|alarma|humo|rociador|monoxido de carbono)\b/.test(text)) return "Safety";
  if (/\b(vtac|hvac|ac|heat|heating|cooling|not cooling|not heating|air conditioner|thermostat|compressor|friedrich|carrier|rtu|aire acondicionado|no enfria|no calienta|calefaccion|termostato|cuarto caliente|habitacion caliente|frio|calor)\b/.test(text)) return "HVAC";
  if (/\b(pool|spa|bromine|chlorine|filter pressure|pool filter|pool pump|piscina|bromo|cloro|filtro de piscina|bomba de piscina)\b/.test(text)) return "Pool/Spa";
  if (/\b(leak|leaking|drain|toilet|sink|faucet|shower|plumbing|water leak|fuga|gotea|goteando|desague|inodoro|lavabo|fregadero|grifo|ducha|plomeria)\b/.test(text)) return "Plumbing";
  if (/\b(light|lighting|lamp|bulb|outlet|breaker|electrical|power outlet|switch|luz|luces|bombilla|foco|enchufe|tomacorriente|interruptor|electrico|electricidad)\b/.test(text)) return "Electrical";
  if (/\b(tv|television|no signal|enseo|channel|remote control|set top|set-top|televisor|sin senal|control remoto|canal)\b/.test(text)) return "TV / AV";
  if (/\b(washer|dryer|laundry|lint|unimac|lavadora|secadora|lavanderia|pelusa)\b/.test(text)) return "Laundry";
  if (/\b(refrigerator|fridge|dishwasher|microwave|ice machine|ice maker|exercise bike|blower|compressor tool|appliance|refrigerador|nevera|lavavajillas|microondas|maquina de hielo|electrodomestico)\b/.test(text)) return "Appliances";
  if (/\b(lobby|corridor|hallway|breakfast area|study|public restroom|public area|entrance|exterior|vestibulo|pasillo|area de desayuno|bano publico|area publica|entrada)\b/.test(text)) return "Public Area";
  if (/\b(chair|table|desk|sofa|couch|bed|furniture|cabinet|silla|mesa|escritorio|cama|mueble|gabinete)\b/.test(text)) return "Furniture";
  return null;
}

function findAssetByTerms(assets: SuggestionAsset[], terms: string[]) {
  for (const term of terms) {
    const matches = assets.filter((asset) =>
      `${asset.name} ${asset.asset_type}`.toLowerCase().includes(term),
    );
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return undefined;
  }
  return undefined;
}

function findAirConditioningAsset(assets: SuggestionAsset[]) {
  const terms = ["vtac", "ptac", "air conditioner", "air conditioning", "friedrich", "carrier", "hvac"];
  for (const term of terms) {
    const matches = assets.filter((item) => `${item.name} ${item.asset_type}`.toLowerCase().includes(term));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return undefined;
  }
  return undefined;
}

export function smartSuggestionForIssue(issue: string, availableAssets: SuggestionAsset[]): SmartSuggestion {
  const text = normalizedIssueText(issue).trim();
  if (!text) return { assetId: null, category: null, priority: null, reason: "" };

  let asset: SuggestionAsset | undefined;
  if (/\b(friedrich|vert[- ]?i[- ]?pak|vpak|vtac)\b/.test(text)) asset = findAssetByTerms(availableAssets, ["friedrich", "vert-i-pak"]);
  else if (/\b(?:no|not working|broken|not cooling|stopped|down)\s+(?:the\s+)?(?:ac|air conditioner|air conditioning)\b|\b(?:ac|air conditioner|air conditioning)\s+(?:is\s+)?(?:not working|broken|not cooling|is out|out)\b/.test(text)) asset = findAirConditioningAsset(availableAssets);
  else if (/\b(shower valve|temptrol)\b/.test(text)) asset = findAssetByTerms(availableAssets, ["symmons", "temptrol"]);
  else if (/\b(saflok|door lock|key card|keycard|rfid lock)\b/.test(text)) asset = findAssetByTerms(availableAssets, ["saflok", "dormakaba"]);
  else if (/\b(verdant|room thermostat|energy management thermostat)\b/.test(text)) asset = findAssetByTerms(availableAssets, ["verdant"]);
  else if (/\b(hayward|sand filter|bromine system|bromine feeder)\b/.test(text)) asset = findAssetByTerms(availableAssets, ["hayward"]);
  else if (/\b(nordic|pool conditioner|pool heat pump)\b/.test(text)) asset = findAssetByTerms(availableAssets, ["nordic", "maritime"]);
  else if (/\b(navien|tankless|water heater|no hot water|hot water)\b/.test(text)) asset = findAssetByTerms(availableAssets, ["navien"]);
  else if (/\b(edwards|est3x|fire alarm panel)\b/.test(text)) asset = findAssetByTerms(availableAssets, ["edwards", "est3x"]);
  else if (/\b(scotsman|ice maker|ice machine)\b/.test(text)) asset = findAssetByTerms(availableAssets, ["scotsman", "ice maker"]);
  else if (/\b(life fitness|exercise bike)\b/.test(text)) asset = findAssetByTerms(availableAssets, ["life fitness"]);
  else if (/\b(enseo)\b/.test(text)) asset = findAssetByTerms(availableAssets, ["enseo"]);
  else if (/\b(persona|brand sign|signage)\b/.test(text)) asset = findAssetByTerms(availableAssets, ["persona"]);
  else if (/\b(carrier|rooftop|rtu)\b/.test(text)) asset = findAssetByTerms(availableAssets, ["carrier"]);

  if (!asset && /\bwasher\b/.test(text)) {
    const matches = availableAssets.filter((item) => item.asset_type.toLowerCase().includes("washer"));
    if (matches.length === 1) asset = matches[0];
  }
  if (!asset && /\bdryer\b/.test(text)) {
    const matches = availableAssets.filter((item) => item.asset_type.toLowerCase().includes("dryer"));
    if (matches.length === 1) asset = matches[0];
  }

  const category = asset ? categoryForAsset(asset) : categoryFromIssue(text);
  return {
    assetId: asset?.id ?? null,
    category,
    priority: category ? priorityForCategory(category) : null,
    reason: asset ? `Matched ${asset.name}` : category ? `Matched ${category} from reported issue` : "",
  };
}

/** Canonical local-only guess, used by both the locked form and submission API. */
export function inferWorkOrder(text: string, assets: SuggestionAsset[]): SmartSuggestion {
  // A unit number identifies equipment, not a room, temperature, or diagnostic code.
  const numberedUnit = normalizedIssueText(text).match(/\b(washer|dryer|pump)\s*(?:#|no\.?\s*|number\s*)?\s*(\d+)\b/);
  const available = assets.filter((asset) => asset.active !== false
    && (!numberedUnit || new RegExp(`\\b${numberedUnit[1]}\\s*(?:#|no\\.?\\s*|number\\s*)?\\s*0*${Number(numberedUnit[2])}\\b`, "i")
      .test(`${asset.name} ${asset.asset_tag || ""}`)))
    .sort((a, b) => a.id.localeCompare(b.id));
  const suggestion = smartSuggestionForIssue(text, available);
  if (suggestion.assetId || !suggestion.category || suggestion.category === "General") return suggestion;
  const terms = [...new Set(normalizedIssueText(text).split(/[^a-z0-9]+/).filter((term) => term.length >= 3))];
  const candidates = available.filter((asset) => normalizeWorkOrderCategory(classifyAsset(asset)) === suggestion.category).map((asset) => {
    const words = new Set(normalizedIssueText([asset.name, asset.asset_type, asset.manufacturer, asset.model_number, asset.generation, asset.asset_tag].filter(Boolean).join(" ")).split(/[^a-z0-9]+/));
    // Documentation availability cannot break a tie about physical identity.
    return { asset, score: terms.reduce((score, term) => score + (words.has(term) ? 20 : 0), 0) };
  }).sort((a, b) => b.score - a.score || a.asset.id.localeCompare(b.asset.id));
  const best = candidates[0];
  const tied = best && candidates[1]?.score === best.score;
  const uniquelyBest = candidates.length === 1 || (best && best.score > 0 && !tied);
  return { ...suggestion, assetId: uniquelyBest ? best?.asset.id ?? null : null };
}

/**
 * Separates the core issue symptom from extra reporter commentary.
 * Returns the cleaned issue and any commentary that was filtered out.
 *
 * The symptom is the actionable problem statement — what's broken, what's not
 * working. Reporter notes are everything else: opinions, context, guesses
 * about cause, urgency pleas, and background that doesn't describe the fault
 * itself.
 */
export function separateIssueFromReporterNotes(rawIssue: string): {
  issue: string;
  reporterNotes: string;
} {
  const text = rawIssue.trim();
  if (!text) return { issue: "", reporterNotes: "" };

  const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);

  const notePatterns = [
    /^(?:please|pls|por favor|hi|hey|hello|greetings|fwiw|btw|just so you know|heads up|n\.b\.|note:|comment:|additional (?:info|details)|for context|background:?)\b/i,
    /^(?:i think|i believe|i guess|maybe|perhaps|posiblemente|creo que|pienso que|not sure|i'm not sure|no estoy seguro)\b/i,
    /^(?:also|additionally|furthermore|ademas|tambien|fyi|for your information|para su informacion)\b/i,
    /^(?:urgent|asap|priority|importante|urgente)\b/i,
    /^(?:previously|earlier|again|already|still waiting|follow(?:ing)? up|called (?:yesterday|last week|earlier)|reported before|ya llame|ya reporte)\b/i,
    /^(?:the\s+)?guest(?:s)?\s+(?:is\s+)?(?:going\s+to\s+leave|will\s+leave|is\s+leaving|to return|will return|return(?:s)?|is expected|are expected|expecting|is upset|is waiting|is concerned|doesn't want|does not want|asked|requested|mentioned|said)\b/i,
    /^(?:the\s+)?(?:customer|caller|staff|employee)\s+(?:is\s+)?(?:waiting|upset|concerned|called|asked|requested|mentioned|said|would like|wants?|needs?)\b/i,
    /^(?:i|we)\s+(?:was told|were told|heard|called|spoke with|already called|already reported|will follow up|need to follow up|would like to note)\b/i,
    /^(?:room|guest room)\s+(?:is\s+)?occupied\b/i,
    /^(?:after|before|during)\s+(?:checkout|check-out|check in|check-in|the guest(?:'s)? stay|the event)\b/i,
    /^(?:at|by)\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i,
    /^(?:it|this|the issue|the problem)\s+(?:started|began|first started|first began|has been happening|has continued)\b/i,
    /\b(?:just a heads up|just wanted to let you know|wanted to report|for your information)\b/i,
  ];

  const symptomLines: string[] = [];
  const noteLines: string[] = [];
  const inlineNotePatterns = [
    /\bguest(?:s)?\s+(?:is\s+)?(?:leaving|left|will leave|going to leave|is upset|is waiting|is concerned|doesn't want|does not want|asked|requested|mentioned|said)\b.*$/i,
    /\b(?:customer|caller|staff|employee)\s+(?:is\s+)?(?:waiting|upset|concerned|asked|requested|mentioned|said|would like|wants?|needs?)\b.*$/i,
    /\bguest(?:s)?\s+(?:to return|will return|return(?:s)?|is expected|are expected|expecting)\b.*$/i,
    /\b(?:room|guest room)\s+(?:is\s+)?occupied\b.*$/i,
    /\b(?:guest|room)\s+(?:will\s+)?return\s+by\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b.*$/i,
    /\b(?:the\s+)?guest(?:s)?\s+(?:says?|said|reports?|reported|mentions?|mentioned)\s+(?:that\s+)?(?:it|this|the issue|the problem)\s+(?:started|began|first started|first began|has been happening|has continued)\b.*$/i,
    /\b(?:previously|earlier|already reported|already called|called (?:yesterday|last week)|follow(?:ing)? up|still waiting|after checkout|before checkout|during checkout)\b.*$/i,
    /\b(?:just so you know|heads up|for context|additional (?:info|details)|fyi|please|pls|btw|note:|comment:)\b.*$/i,
  ];

  const reportedIssuePrefix = /^(?:(?:the\s+)?(?:guest|customer|caller|staff member|employee)\s+(?:reports?|reported|says?|said|mentions?|mentioned|noticed|observed)\s+(?:that\s+)?|(?:i|we)\s+(?:am reporting|reported|noticed|observed)\s+(?:that\s+)?)/i;

  for (const sourceLine of lines) {
    let line = sourceLine;
    const reportedIssue = line.replace(reportedIssuePrefix, "").trim();
    if (reportedIssue !== line) {
      if (notePatterns.some((pattern) => pattern.test(reportedIssue))) {
        noteLines.push(line);
        continue;
      }
      line = reportedIssue;
    }

    const isNote = notePatterns.some((pattern) => pattern.test(line));
    if (isNote) {
      noteLines.push(line);
    } else {
      const inlineMatch = inlineNotePatterns
        .map((pattern) => pattern.exec(line))
        .filter((match): match is RegExpExecArray => Boolean(match))
        .sort((a, b) => a.index - b.index)[0];
      if (inlineMatch && inlineMatch.index > 0) {
        const symptom = line.slice(0, inlineMatch.index).replace(/[;,:-]+\s*$/, "").trim();
        if (symptom) symptomLines.push(symptom);
        noteLines.push(line.slice(inlineMatch.index).trim());
      } else {
        symptomLines.push(line);
      }
    }
  }

  if (symptomLines.length === 0 && noteLines.length > 0) {
    return { issue: "", reporterNotes: noteLines.join("\n") };
  }

  const issue = symptomLines.join(" ").replace(/\s{2,}/g, " ").trim();
  const reporterNotes = noteLines.join("\n").trim();
  return { issue, reporterNotes };
}
