export type AskLanguage = "en" | "es";
export type AskSource = "orders" | "assets" | "rooms" | "roomRank" | "staffNotes" | "personalNotes";
export type AskStatus = "all" | "active" | "in-progress" | "completed" | "closed";
export type AskFormat = "brief" | "bullets" | "table";
export type AskRecordReference = { kind: "order" | "asset" | "roomRank" | "staffNote" | "personalNote"; id: string; label?: string };
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
export type AskTableCell = string | { text: string; href?: string; record?: AskRecordReference };
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
  pending?: {
    field: AskProposal["field"];
    needs: "room" | "issue" | "staffName" | "workOrder" | "value" | "photo";
    value?: string;
    priority?: "Low" | "Medium" | "High" | "Urgent";
  };
};
export type AskProposal = {
  token: string;
  id: string;
  field: "create" | "status" | "priority" | "comment" | "staff-note";
  label: string;
  from: string;
  to: string;
};
export type AskResponse = {
  title: string;
  summary: string;
  question?: string;
  items?: AskResultItem[];
  format?: AskFormat;
  table?: AskTable;
  context?: AskContext;
  proposal?: AskProposal;
  savedOrder?: { id: string; displayId: string };
};
