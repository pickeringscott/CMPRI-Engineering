export type RecordedPmRow = { id: string; label: string; value: string; rawDate: string; notes: string };
export type RecordedPmForm = { id: string; period: string; kind: 'checklist' | 'log'; rows: RecordedPmRow[] };
export type RecordedPmPage = { recordedForms?: RecordedPmForm[]; recordedFormsConflict?: boolean };
