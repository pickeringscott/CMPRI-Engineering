import { classifyAsset } from "./asset-category";
import { normalizeWorkOrderCategory } from "./work-order-categories";

export type SuggestionAsset = {
  id: string; name: string; asset_type: string; location_id?: string | null;
  manufacturer?: string | null; model_number?: string | null; generation?: string | null;
  asset_tag?: string | null; documentation_key?: string | null; active?: boolean | null;
};
export type SmartSuggestion = { assetId: string | null; category: string | null; priority: string | null; reason: string };

function categoryForAsset(asset: SuggestionAsset) {
  return classifyAsset(asset);
}

function normalizedIssueText(value: string) {
  return value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
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
  if (/\b(vtac|hvac|heat|heating|cooling|not cooling|not heating|air conditioner|thermostat|compressor|friedrich|carrier|rtu|aire acondicionado|no enfria|no calienta|calefaccion|termostato|cuarto caliente|habitacion caliente|frio|calor)\b/.test(text)) return "HVAC";
  if (/\b(pool|spa|bromine|chlorine|filter pressure|pool filter|pool pump|piscina|bromo|cloro|filtro de piscina|bomba de piscina)\b/.test(text)) return "Pool/Spa";
  if (/\b(leak|leaking|drain|toilet|sink|faucet|shower|plumbing|water leak|fuga|gotea|goteando|desague|inodoro|lavabo|fregadero|grifo|ducha|plomeria)\b/.test(text)) return "Plumbing";
  if (/\b(light|lighting|outlet|breaker|electrical|power outlet|switch|luz|luces|bombilla|foco|enchufe|tomacorriente|interruptor|electrico|electricidad)\b/.test(text)) return "Electrical";
  if (/\b(tv|television|no signal|enseo|channel|remote control|set top|set-top|televisor|sin senal|control remoto|canal)\b/.test(text)) return "TV / AV";
  if (/\b(washer|dryer|laundry|lint|unimac|lavadora|secadora|lavanderia|pelusa)\b/.test(text)) return "Laundry";
  if (/\b(refrigerator|fridge|dishwasher|microwave|ice machine|ice maker|exercise bike|blower|compressor tool|appliance|refrigerador|nevera|lavavajillas|microondas|maquina de hielo|electrodomestico)\b/.test(text)) return "Appliances";
  if (/\b(lobby|corridor|hallway|breakfast area|study|public restroom|public area|entrance|exterior|vestibulo|pasillo|area de desayuno|bano publico|area publica|entrada)\b/.test(text)) return "Public Area";
  if (/\b(chair|table|desk|sofa|couch|bed|furniture|cabinet|silla|mesa|escritorio|cama|mueble|gabinete)\b/.test(text)) return "Furniture";
  return null;
}

function findAssetByTerms(assets: SuggestionAsset[], terms: string[]) {
  return assets.find((asset) => {
    const haystack = `${asset.name} ${asset.asset_type}`.toLowerCase();
    return terms.some((term) => haystack.includes(term));
  });
}

export function smartSuggestionForIssue(issue: string, availableAssets: SuggestionAsset[]): SmartSuggestion {
  const text = normalizedIssueText(issue).trim();
  if (!text) return { assetId: null, category: null, priority: null, reason: "" };

  let asset: SuggestionAsset | undefined;
  if (/\b(friedrich|vert[- ]?i[- ]?pak|vpak|vtac)\b/.test(text)) asset = findAssetByTerms(availableAssets, ["friedrich", "vert-i-pak"]);
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
  const available = assets.filter((asset) => asset.active !== false).sort((a, b) => a.id.localeCompare(b.id));
  const suggestion = smartSuggestionForIssue(text, available);
  if (suggestion.assetId || !suggestion.category || suggestion.category === "General") return suggestion;
  const terms = text.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length >= 3);
  const candidates = available.filter((asset) => classifyAsset(asset) === suggestion.category).map((asset) => {
    const words = [asset.name, asset.asset_type, asset.manufacturer, asset.model_number, asset.generation, asset.asset_tag].filter(Boolean).join(" ").toLowerCase();
    return { asset, score: terms.reduce((score, term) => score + (words.includes(term) ? 20 : 0), 0) + (asset.documentation_key ? 5 : 0) };
  }).sort((a, b) => b.score - a.score || a.asset.id.localeCompare(b.asset.id));
  return { ...suggestion, assetId: candidates[0]?.asset.id ?? null };
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
    /^(?:please|pls|por favor|hi|hey|hello|greetings|fwiw|btw|just so you know|heads up|n\.b\.|note:)\b/i,
    /^(?:i think|i believe|i guess|maybe|perhaps|posiblemente|creo que|pienso que)\b/i,
    /^(?:this is|this has been|this keeps|this started|esto es|esto ha estado|esto sigue)\b/i,
    /^(?:it's been|it has been|it's been doing|ha estado)\b/i,
    /^(?:the guest|guests|el huesped|los huespedes)\b/i,
    /^(?:not sure|i'm not sure|no estoy seguro)\b/i,
    /^(?:also|additionally|furthermore|ademas|tambien)\b/i,
    /^(?:fyi|for your information|para su informacion)\b/i,
    /^(?:urgent|asap|priority|importante|urgente)\b/i,
    /^(?:called yesterday|called last week|reported before|ya llame|ya reporte)\b/i,
    /\b(?:just a heads up|just wanted to let you know|wanted to report)\b/i,
  ];

  const symptomLines: string[] = [];
  const noteLines: string[] = [];

  for (const line of lines) {
    const isNote = notePatterns.some((pattern) => pattern.test(line));
    if (isNote) {
      noteLines.push(line);
    } else {
      symptomLines.push(line);
    }
  }

  if (symptomLines.length === 0 && noteLines.length > 0) {
    return { issue: noteLines[0], reporterNotes: noteLines.slice(1).join("\n") };
  }

  const issue = symptomLines.join(" ").replace(/\s{2,}/g, " ").trim();
  const reporterNotes = noteLines.join("\n").trim();
  return { issue, reporterNotes };
}
