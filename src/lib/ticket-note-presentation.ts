import { roleDisplayName } from "./account-display";

export type TicketHistoryEntry = {
  id: string;
  timestamp: string;
  actor: string;
  authorRole?: string;
  kind: "note" | "change" | "system";
  text: string;
  staged?: boolean;
  locked?: boolean;
};

export function parseTicketHistory(raw: string, fallbackTime?: string | null): TicketHistoryEntry[] {
  const lines = String(raw || "").split("\n").map((line) => line.trim()).filter(Boolean);
  const entries: TicketHistoryEntry[] = [];
  const plain: string[] = [];
  lines.forEach((line, index) => {
    const attributed = line.match(/^CMPRI2\|([^|]+)\|([^|]*)\|([^|]*)\|(note|change|system)\|(.*)$/);
    if (attributed) {
      entries.push({ id: `saved-${index}-${attributed[1]}`, timestamp: attributed[1], actor: attributed[2] || "CMPRI User", authorRole: attributed[3], kind: attributed[4] as TicketHistoryEntry["kind"], text: attributed[5] });
      return;
    }
    const match = line.match(/^CMPRI\|([^|]+)\|([^|]*)\|(note|change|system)\|(.*)$/);
    if (match) {
      entries.push({ id: `saved-${index}-${match[1]}`, timestamp: match[1], actor: match[2] || "CMPRI User", kind: match[3] as TicketHistoryEntry["kind"], text: match[4] });
    } else {
      plain.push(line);
    }
  });
  if (plain.length) entries.push({ id: "legacy-notes", timestamp: fallbackTime || new Date().toISOString(), actor: "Existing ticket", kind: "note", text: plain.join(" ") });
  return entries.sort((a,b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}

export function historyLine(entry: TicketHistoryEntry) {
  if (entry.authorRole) return `CMPRI2|${entry.timestamp}|${entry.actor.replace(/\|/g, "/")}|${entry.authorRole.replace(/\|/g, "/")}|${entry.kind}|${entry.text.replace(/\n+/g, " ").replace(/\|/g, "/")}`;
  return `CMPRI|${entry.timestamp}|${entry.actor.replace(/\|/g, "/")}|${entry.kind}|${entry.text.replace(/\n+/g, " ").replace(/\|/g, "/")}`;
}

const ROLE_TRANSLATIONS: Record<string, string> = {
  "Engineer": "Ingeniería", "Chief Engineer": "Jefe de Ingeniería", "General Manager": "Gerente general",
  "Senior Management": "Alta gerencia", "Maintenance Technician": "Técnico de mantenimiento",
  "Front Desk": "Recepción", "Front Desk Manager": "Gerente de Recepción", "Assistant General Manager": "Subgerente general",
  "Lead Housekeeper": "Supervisión de limpieza", "System Administrator": "Administrador del sistema",
};

/** Author snapshot only. Missing/imported attribution never inherits the viewer's role. */
export function noteHeading(authorRole?: string | null, language: "en" | "es" = "en") {
  const roles = (authorRole || "").split(/\s*\+\s*/).map((role) => roleDisplayName(role));
  if (!roles.length || roles.some((role) => !ROLE_TRANSLATIONS[role])) return language === "es" ? "Notas" : "Notes";
  return language === "es" ? `Notas de ${roles.map((role) => ROLE_TRANSLATIONS[role]).join(" + ")}` : `${roles.join(" + ")} Notes`;
}
