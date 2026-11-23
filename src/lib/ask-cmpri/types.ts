import type { AskStagedFile } from "./files";

export type AskLanguage = "en" | "es";
export type AskSource = "orders" | "assets" | "inventory" | "rooms" | "roomRank" | "staffNotes" | "personalNotes" | "preventiveMaintenance" | "cmpri";
export type AskStatus = "all" | "active" | "in-progress" | "completed" | "closed";
export type AskFormat = "brief" | "bullets" | "table";
export type AskRecordReference = { kind: "order" | "asset" | "roomRank" | "staffNote" | "personalNote" | "file" | "module"; id: string; label?: string; assetId?: string };
export type AskResultItem = {
  id: string;
  title: string;
  text?: string;
  source: string;
  sourceType: "internal" | "web" | "local";
  href?: string;
  hrefLabel?: string;
  record?: AskRecordReference;
  links?: AskRecordReference[];
  facts?: { label: string; value: string }[];
};
export type AskTableCell = string | { text: string; href?: string; record?: AskRecordReference; links?: AskRecordReference[] };
export type AskTable = {
  caption?: string;
  columns: { id: string; label: string }[];
  rows: { id: string; cells: Record<string, AskTableCell> }[];
};
export type AskContext = {
  question?: string;
  language?: AskLanguage;
  sources?: AskSource[];
  rooms?: string[];
  workOrders?: string[];
  terms?: string[];
  status?: AskStatus;
  assignedOnly?: boolean;
  format?: AskFormat;
  fields?: string[];
  sortBy?: string;
  sortDirection?: "asc" | "desc" | "none";
  roomIntent?: "roster" | "availability" | "late-checkouts" | "features";
  locationNames?: string[];
  ticketStatus?: string;
  checkoutAfter?: string;
  roomAvailability?: string;
  assetState?: "active" | "retired" | "all";
  rank?: "A" | "B" | "C";
  fromDate?: string;
  toDate?: string;
  noteAuthor?: string;
  publicEquipment?: { manufacturer: string; model: string; errorCode?: string };
  webIntent?: "none" | "manual" | "manufacturer" | "error-code" | "public-guidance";
  focus?: "error-code" | "equipment";
  evidence?: string[];
  contextProof?: string;
  native?: {
    summary: string;
    reads: { operation: string; parameters?: Record<string, string>; query?: Record<string, string | string[]> }[];
    /** Last six signed user turns, retaining full question values for native follow-ups. */
    userTurns?: string[];
    /** Signed references to the exact originals read for a later document import. */
    documents?: { assetId: string; name: string; sourceUrl: string; token: string }[];
    publicSources?: { url: string; title?: string }[];
    /** Actor-bound original files selected for this conversation, rechecked before use. */
    files?: AskStagedFile[];
  };
  pending?: {
    field: Exclude<AskProposal["field"], "cmpri">;
    needs: "room" | "issue" | "staffName" | "workOrder" | "value" | "photo" | "review";
    value?: string;
    priority?: "Low" | "Medium" | "High" | "Urgent";
    staffName?: string;
    photoRequired?: boolean;
  };
};
export type AskProposal = {
  token: string;
  id: string;
  field: "create" | "status" | "priority" | "comment" | "staff-note" | "cmpri";
  label: string;
  from: string;
  to: string;
  effects?: string[];
  attachments?: AskAttachment[];
};
export type AskAttachment = { uploadId: string; name: string; type: string; size: number; sha256?: string };
export type AskResponse = {
  title: string;
  summary: string;
  question?: string;
  items?: AskResultItem[];
  format?: AskFormat;
  table?: AskTable;
  context?: AskContext;
  proposal?: AskProposal;
  savedOrder?: { id: string; displayId: string; attachments?: AskAttachment[]; attachmentToken?: string };
  code?: string;
  downloads?: ({ id: string; name: string; mimeType: string } & (
    { content: string; encoding: "utf8" | "base64" } | { downloadToken: string }
  ))[];
};
