-- Actual historical receipt dates are unknown; created_at remains the audit insertion time.
alter table public.cmpri_po_receipts add column receipt_kind text not null default 'delivery';
alter table public.cmpri_po_receipts add column reconciliation_batch text;
alter table public.cmpri_po_receipts alter column received_date drop not null;
alter table public.cmpri_po_receipts add constraint cmpri_po_receipts_date_kind check (
 (receipt_kind='delivery' and received_date is not null and reconciliation_batch is null)
 or (receipt_kind='historical' and received_date is null and reconciliation_batch is not null and length(trim(reconciliation_batch))>0)
);
create unique index cmpri_po_receipts_reconciliation_line
 on public.cmpri_po_receipts(hotel_id,reconciliation_batch,line_id) where reconciliation_batch is not null;
comment on column public.cmpri_po_receipts.received_date is 'Actual receipt date; NULL only for explicitly reconciled historical receipts. Never inferred from created_at.';
