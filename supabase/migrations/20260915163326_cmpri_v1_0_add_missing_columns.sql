-- Add missing columns to existing tables to match CMPRI v1.0 source expectations

-- cmpri_purchases: add notes, line_items, updated_at
ALTER TABLE public.cmpri_purchases ADD COLUMN IF NOT EXISTS notes text;
ALTER TABLE public.cmpri_purchases ADD COLUMN IF NOT EXISTS line_items jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.cmpri_purchases ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- cmpri_purchase_shipments: add ship_from, delivered_at, eta, last_email_event_id, updated_at
ALTER TABLE public.cmpri_purchase_shipments ADD COLUMN IF NOT EXISTS ship_from text;
ALTER TABLE public.cmpri_purchase_shipments ADD COLUMN IF NOT EXISTS delivered_at timestamptz;
ALTER TABLE public.cmpri_purchase_shipments ADD COLUMN IF NOT EXISTS eta text;
ALTER TABLE public.cmpri_purchase_shipments ADD COLUMN IF NOT EXISTS last_email_event_id uuid;
ALTER TABLE public.cmpri_purchase_shipments ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- cmpri_warranty_cases: add columns expected by source
ALTER TABLE public.cmpri_warranty_cases ADD COLUMN IF NOT EXISTS external_key text;
ALTER TABLE public.cmpri_warranty_cases ADD COLUMN IF NOT EXISTS warranty_case_number text;
ALTER TABLE public.cmpri_warranty_cases ADD COLUMN IF NOT EXISTS rma_number text;
ALTER TABLE public.cmpri_warranty_cases ADD COLUMN IF NOT EXISTS work_order_id uuid;
ALTER TABLE public.cmpri_warranty_cases ADD COLUMN IF NOT EXISTS last_email_event_id uuid;
ALTER TABLE public.cmpri_warranty_cases ADD COLUMN IF NOT EXISTS tracking_numbers jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.cmpri_warranty_cases ADD COLUMN IF NOT EXISTS ship_from text;
ALTER TABLE public.cmpri_warranty_cases ADD COLUMN IF NOT EXISTS eta text;
ALTER TABLE public.cmpri_warranty_cases ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- cmpri_supplier_followups: add columns expected by source
ALTER TABLE public.cmpri_supplier_followups ADD COLUMN IF NOT EXISTS external_key text;
ALTER TABLE public.cmpri_supplier_followups ADD COLUMN IF NOT EXISTS purchase_id uuid;
ALTER TABLE public.cmpri_supplier_followups ADD COLUMN IF NOT EXISTS work_order_id uuid;
ALTER TABLE public.cmpri_supplier_followups ADD COLUMN IF NOT EXISTS topic text;
ALTER TABLE public.cmpri_supplier_followups ADD COLUMN IF NOT EXISTS last_outbound_at timestamptz;
ALTER TABLE public.cmpri_supplier_followups ADD COLUMN IF NOT EXISTS last_inbound_at timestamptz;
ALTER TABLE public.cmpri_supplier_followups ADD COLUMN IF NOT EXISTS last_email_event_id uuid;
ALTER TABLE public.cmpri_supplier_followups ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- cmpri_gss_reports: add columns expected by source
ALTER TABLE public.cmpri_gss_reports ADD COLUMN IF NOT EXISTS report_week date;
ALTER TABLE public.cmpri_gss_reports ADD COLUMN IF NOT EXISTS subject text;
ALTER TABLE public.cmpri_gss_reports ADD COLUMN IF NOT EXISTS scores jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.cmpri_gss_reports ADD COLUMN IF NOT EXISTS source_email_event_id uuid;
ALTER TABLE public.cmpri_gss_reports ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- cmpri_enseo_tickets: add columns expected by source
ALTER TABLE public.cmpri_enseo_tickets ADD COLUMN IF NOT EXISTS external_key text;
ALTER TABLE public.cmpri_enseo_tickets ADD COLUMN IF NOT EXISTS ticket_number text;
ALTER TABLE public.cmpri_enseo_tickets ADD COLUMN IF NOT EXISTS enseo_endpoint text;
ALTER TABLE public.cmpri_enseo_tickets ADD COLUMN IF NOT EXISTS subject text;
ALTER TABLE public.cmpri_enseo_tickets ADD COLUMN IF NOT EXISTS last_email_event_id uuid;
ALTER TABLE public.cmpri_enseo_tickets ADD COLUMN IF NOT EXISTS last_update_at timestamptz;
ALTER TABLE public.cmpri_enseo_tickets ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- work_orders: add display_id, revision, creator_name, submitted_by_name, creator_source
ALTER TABLE public.work_orders ADD COLUMN IF NOT EXISTS display_id text;
ALTER TABLE public.work_orders ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 1;
ALTER TABLE public.work_orders ADD COLUMN IF NOT EXISTS creator_name text;
ALTER TABLE public.work_orders ADD COLUMN IF NOT EXISTS submitted_by_name text;
ALTER TABLE public.work_orders ADD COLUMN IF NOT EXISTS creator_source text;

-- pool_daily_logs: add columns for CMPRI pool log
ALTER TABLE public.pool_daily_logs ADD COLUMN IF NOT EXISTS ph_am numeric;
ALTER TABLE public.pool_daily_logs ADD COLUMN IF NOT EXISTS ph_pm numeric;
ALTER TABLE public.pool_daily_logs ADD COLUMN IF NOT EXISTS sanitizer_am numeric;
ALTER TABLE public.pool_daily_logs ADD COLUMN IF NOT EXISTS sanitizer_pm numeric;
ALTER TABLE public.pool_daily_logs ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 1;
ALTER TABLE public.pool_daily_logs ADD COLUMN IF NOT EXISTS updated_by uuid;

-- profiles: add property_scope
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS property_scope text;

-- Create indexes
CREATE INDEX IF NOT EXISTS cmpri_purchases_work_order_idx ON public.cmpri_purchases(work_order_id);
CREATE INDEX IF NOT EXISTS cmpri_enseo_work_order_idx ON public.cmpri_enseo_tickets(work_order_id);
CREATE INDEX IF NOT EXISTS cmpri_warranty_work_order_idx ON public.cmpri_warranty_cases(work_order_id);
CREATE INDEX IF NOT EXISTS cmpri_email_events_message_at_idx ON public.cmpri_email_events(message_at desc);
CREATE UNIQUE INDEX IF NOT EXISTS cmpri_purchase_shipments_upsert_unique ON public.cmpri_purchase_shipments(purchase_id, tracking_number);