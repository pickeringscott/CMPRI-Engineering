export type EmailDirection = "inbound" | "outbound";
export type EmailCategory =
  | "purchase"
  | "shipping"
  | "enseo"
  | "gss"
  | "warranty"
  | "supplier_followup"
  | "other";

export type ParsedEmail = {
  category: EmailCategory;
  confidence: number;
  orderNumber?: string;
  vendor?: string;
  purchaseStatus?: string;
  trackingNumbers: string[];
  shipFrom?: string;
  eta?: string;
  enseoTicketNumber?: string;
  roomNumber?: string;
  enseoEndpoint?: string;
  warrantyCaseNumber?: string;
  rmaNumber?: string;
  gssScores: Record<string, number | string>;
  followupStatus?: string;
  workOrderRef?: string;
};

export type EmailForParsing = {
  subject?: string | null;
  text?: string | null;
  from?: string | null;
  to?: string | null;
  direction?: EmailDirection;
  messageAt?: string;
};

const normalize = (value?: string | null) => String(value || "").replace(/\s+/g, " ").trim();

function firstMatch(text: string, patterns: RegExp[]) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return undefined;
}

function extractTrackingNumbers(text: string) {
  const found = new Set<string>();
  const patterns = [
    /(?:tracking|tracking number|tracking #|track(?:ing)? no\.?)[\s:#-]*([A-Z0-9-]{8,30})/gi,
    /\b(1Z[A-Z0-9]{16})\b/gi,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text))) found.add(match[1].toUpperCase());
  }
  return [...found];
}

function extractGssScores(text: string) {
  const scores: Record<string, number | string> = {};
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9 &/()\-.]{2,50})\s*[:=-]\s*(\d{1,3}(?:\.\d+)?)\s*(%|pts?|points?)?\b/i);
    if (!match) continue;
    const label = match[1].trim();
    const value = Number(match[2]);
    scores[label] = Number.isFinite(value) ? value : match[2];
    if (Object.keys(scores).length >= 30) break;
  }
  return scores;
}

export function parseOperationalEmail(input: EmailForParsing): ParsedEmail {
  const subject = normalize(input.subject);
  const body = String(input.text || "").replace(/\r/g, "").trim();
  const from = normalize(input.from);
  const to = normalize(input.to);
  const direction: EmailDirection = input.direction || "inbound";
  const combined = `${subject}\n${body}`;
  const lower = `${combined}\n${from}\n${to}`.toLowerCase();

  const workOrderRef = firstMatch(combined, [
    /\b(WO[- ]?\d{3,})\b/i,
    /\b(AC[- ]?\d{3,})\b/i,
  ]);

  const orderNumber = firstMatch(combined, [
    /\b(?:purchase order|po)\s*(?:number|no\.?|#)?\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{3,})\b/i,
    /\border\s*(?:number|no\.?|#)\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{3,})\b/i,
  ]);

  const trackingNumbers = extractTrackingNumbers(combined);
  const shipFrom = firstMatch(combined, [
    /\bship(?:ped|ping)?\s+from\s*[:#-]?\s*([^\n.;]{2,80})/i,
    /\borigin\s*(?:warehouse|location)?\s*[:#-]\s*([^\n.;]{2,80})/i,
  ]);
  const eta = firstMatch(combined, [
    /\b(?:estimated delivery|expected delivery|eta)\s*[:#-]?\s*([A-Za-z]{3,9}\s+\d{1,2}(?:,\s*\d{4})?)/i,
    /\b(?:estimated delivery|expected delivery|eta)\s*[:#-]?\s*(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)/i,
    /\b(?:estimated delivery|expected delivery|eta)\s*[:#-]?\s*([^\n.;]{3,40})/i,
  ]);

  const enseoTicketNumber = firstMatch(combined, [
    /\b(?:enseo\s*)?(?:ticket|case)\s*(?:number|no\.?|#)?\s*[:#-]?\s*([A-Z0-9-]{3,})\b/i,
  ]);
  const enseoRoom = combined.match(/\b(?:room\s*)?(\d{3})([AB])\b/i) || combined.match(/\broom\s*(\d{3})\b/i);
  const roomNumber = enseoRoom?.[1];
  const enseoEndpoint = enseoRoom?.[2] ? `${enseoRoom[1]}${enseoRoom[2].toUpperCase()}` : undefined;

  const warrantyCaseNumber = firstMatch(combined, [
    /\b(?:warranty|claim)\s*(?:case|claim|number|no\.?|#)?\s*[:#-]?\s*([A-Z0-9-]{3,})\b/i,
  ]);
  const rmaNumber = firstMatch(combined, [
    /\bRMA\s*(?:number|no\.?|#)?\s*[:#-]?\s*([A-Z0-9-]{3,})\b/i,
  ]);

  let category: EmailCategory = "other";
  let confidence = 0.35;

  const isEnseo = /\benseo\b/.test(lower) || (!!enseoTicketNumber && /\b(?:stb|set[- ]?top|television|tv)\b/.test(lower));
  const isGss = /\b(?:gss|guest satisfaction(?: score| survey)?)\b/.test(lower) && (!input.messageAt || new Date(input.messageAt).getUTCDay() === 1);
  const isWarranty = /\b(?:warranty|rma|return merchandise authorization|failed part|replacement part|defective part|refund|credit memo|return authorization)\b/.test(lower);
  const isSupplierFollowup = direction === "outbound" && /\b(?:did(?:n['’]?t| not) receive|not received|missing item|missing part|short shipment|shorted shipment|shipment short|quantity short|never arrived)\b/.test(lower);
  const isShipping = /\b(?:shipped|shipment|tracking|delivered|delivery confirmation|out for delivery|backorder|backordered)\b/.test(lower) && (!!orderNumber || /\b(?:ibuy|i buy|hd supply|purchase order|po)\b/.test(lower));
  const isPurchase = /\b(?:ibuyefficient|i buy efficient|purchase order|order confirmation|hd supply)\b/.test(lower) && (!!orderNumber || /\border\b/.test(lower));

  if (isEnseo) { category = "enseo"; confidence = 0.95; }
  else if (isGss) { category = "gss"; confidence = 0.95; }
  else if (isSupplierFollowup) { category = "supplier_followup"; confidence = 0.9; }
  else if (isWarranty) { category = "warranty"; confidence = 0.9; }
  else if (isShipping) { category = "shipping"; confidence = 0.9; }
  else if (isPurchase) { category = "purchase"; confidence = 0.85; }

  let purchaseStatus: string | undefined;
  if (/\bcancel(?:led|ed|ation)\b/.test(lower)) purchaseStatus = "Cancelled";
  else if (/\bbackorder(?:ed)?\b/.test(lower)) purchaseStatus = "Backordered";
  else if (/\b(?:shipment|items?|goods?)\s+(?:was\s+|were\s+)?received\b|\breceived\s+(?:at|by)\s+(?:the\s+)?(?:hotel|property|front desk|engineering)\b/.test(lower)) purchaseStatus = "Received";
  else if (/\bdelivered\b/.test(lower) && !/\b(?:not|never)\s+delivered\b/.test(lower)) purchaseStatus = "Delivered";
  else if (/\bin transit\b|\bout for delivery\b/.test(lower)) purchaseStatus = "In Transit";
  else if (/\bshipped\b|\bout for delivery\b/.test(lower)) purchaseStatus = "Shipped";
  else if (/\bprocessing\b|\bbeing processed\b/.test(lower)) purchaseStatus = "Processing";
  else if (category === "purchase") purchaseStatus = "Ordered";

  let followupStatus: string | undefined;
  if (category === "supplier_followup") followupStatus = "Vendor Contacted — Awaiting Response";

  let vendor: string | undefined;
  if (/\bhd supply\b/.test(lower)) vendor = "HD Supply";
  else if (/\bibuyefficient\b|\bi buy efficient\b/.test(lower)) vendor = "iBuyEfficient";
  else if (category === "enseo") vendor = "Enseo";

  return {
    category,
    confidence,
    orderNumber,
    vendor,
    purchaseStatus,
    trackingNumbers,
    shipFrom,
    eta,
    enseoTicketNumber,
    roomNumber,
    enseoEndpoint,
    warrantyCaseNumber,
    rmaNumber,
    gssScores: category === "gss" ? extractGssScores(input.text || "") : {},
    followupStatus,
    workOrderRef,
  };
}
