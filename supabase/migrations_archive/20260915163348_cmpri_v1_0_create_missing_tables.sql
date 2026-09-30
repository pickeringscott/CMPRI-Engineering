-- Create missing tables referenced by CMPRI v1.0 source code

-- Work order drafts
CREATE TABLE IF NOT EXISTS public.cmpri_work_order_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id uuid NOT NULL,
  user_id uuid NOT NULL,
  location_id uuid,
  room text,
  asset_id uuid,
  asset_name text,
  category text,
  issue text,
  priority text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.cmpri_work_order_drafts ENABLE ROW LEVEL SECURITY;

-- Work order history (audit trail)
CREATE TABLE IF NOT EXISTS public.cmpri_work_order_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id uuid NOT NULL REFERENCES public.work_orders(id) ON DELETE CASCADE,
  hotel_id uuid NOT NULL,
  actor_id uuid,
  action text NOT NULL,
  field text,
  old_value text,
  new_value text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.cmpri_work_order_history ENABLE ROW LEVEL SECURITY;

-- Enseo assignments (TV/STB room assignments)
CREATE TABLE IF NOT EXISTS public.cmpri_enseo_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id uuid NOT NULL,
  room_number text NOT NULL,
  sublocation text,
  device_type text,
  device_id text,
  mac_address text,
  status text,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.cmpri_enseo_assignments ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.cmpri_enseo_assignment_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id uuid NOT NULL REFERENCES public.cmpri_enseo_assignments(id) ON DELETE CASCADE,
  hotel_id uuid NOT NULL,
  actor_id uuid,
  action text NOT NULL,
  old_value jsonb,
  new_value jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.cmpri_enseo_assignment_history ENABLE ROW LEVEL SECURITY;

-- Room operations (daily room status, moves, arrivals, departures)
CREATE TABLE IF NOT EXISTS public.cmpri_room_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id uuid NOT NULL,
  operation_date date NOT NULL,
  room_number text,
  room_type text,
  status text,
  guest_name text,
  guest_code text,
  arrival_date date,
  departure_date date,
  checkout_time text,
  arrival_time text,
  blocked boolean DEFAULT false,
  reserved boolean DEFAULT false,
  is_move boolean DEFAULT false,
  move_details jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.cmpri_room_operations ENABLE ROW LEVEL SECURITY;

-- Room ranker sync queue
CREATE TABLE IF NOT EXISTS public.cmpri_room_ranker_sync_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id uuid NOT NULL,
  room_number text NOT NULL,
  action text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending',
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.cmpri_room_ranker_sync_queue ENABLE ROW LEVEL SECURITY;

-- Vendors
CREATE TABLE IF NOT EXISTS public.cmpri_vendors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id uuid NOT NULL,
  name text NOT NULL,
  website text,
  phone text,
  email text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.cmpri_vendors ENABLE ROW LEVEL SECURITY;

-- Vendor contacts
CREATE TABLE IF NOT EXISTS public.cmpri_vendor_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id uuid NOT NULL REFERENCES public.cmpri_vendors(id) ON DELETE CASCADE,
  name text,
  title text,
  phone text,
  email text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.cmpri_vendor_contacts ENABLE ROW LEVEL SECURITY;

-- Vendor proposals
CREATE TABLE IF NOT EXISTS public.cmpri_vendor_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id uuid NOT NULL,
  vendor_id uuid REFERENCES public.cmpri_vendors(id) ON DELETE SET NULL,
  asset_id uuid REFERENCES public.assets(id) ON DELETE SET NULL,
  work_order_id uuid REFERENCES public.work_orders(id) ON DELETE SET NULL,
  proposal_number text,
  status text NOT NULL DEFAULT 'Submitted',
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.cmpri_vendor_proposals ENABLE ROW LEVEL SECURITY;

-- Inventory items
CREATE TABLE IF NOT EXISTS public.cmpri_inventory_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id uuid NOT NULL,
  name text NOT NULL,
  sku text,
  quantity integer NOT NULL DEFAULT 0,
  min_quantity integer DEFAULT 0,
  location text,
  vendor_id uuid REFERENCES public.cmpri_vendors(id) ON DELETE SET NULL,
  unit_cost numeric(10,2),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.cmpri_inventory_items ENABLE ROW LEVEL SECURITY;

-- Asset-inventory compatibility
CREATE TABLE IF NOT EXISTS public.cmpri_asset_inventory_compatibility (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id uuid NOT NULL REFERENCES public.assets(id) ON DELETE CASCADE,
  inventory_item_id uuid NOT NULL REFERENCES public.cmpri_inventory_items(id) ON DELETE CASCADE,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.cmpri_asset_inventory_compatibility ENABLE ROW LEVEL SECURITY;

-- Work order items (parts used on work orders)
CREATE TABLE IF NOT EXISTS public.cmpri_work_order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id uuid NOT NULL REFERENCES public.work_orders(id) ON DELETE CASCADE,
  hotel_id uuid NOT NULL,
  inventory_item_id uuid REFERENCES public.cmpri_inventory_items(id) ON DELETE SET NULL,
  name text NOT NULL,
  quantity integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.cmpri_work_order_items ENABLE ROW LEVEL SECURITY;

-- Inventory movements (stock in/out tracking)
CREATE TABLE IF NOT EXISTS public.cmpri_inventory_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id uuid NOT NULL,
  inventory_item_id uuid NOT NULL REFERENCES public.cmpri_inventory_items(id) ON DELETE CASCADE,
  quantity integer NOT NULL,
  direction text NOT NULL CHECK (direction IN ('in', 'out')),
  reason text,
  work_order_id uuid REFERENCES public.work_orders(id) ON DELETE SET NULL,
  actor_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.cmpri_inventory_movements ENABLE ROW LEVEL SECURITY;

-- Order ideas (suggested parts from work order language)
CREATE TABLE IF NOT EXISTS public.cmpri_order_ideas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id uuid NOT NULL,
  work_order_id uuid REFERENCES public.work_orders(id) ON DELETE SET NULL,
  name text NOT NULL,
  source text,
  status text NOT NULL DEFAULT 'Idea',
  vendor_id uuid REFERENCES public.cmpri_vendors(id) ON DELETE SET NULL,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.cmpri_order_ideas ENABLE ROW LEVEL SECURITY;

-- AI refresh events (provenance for AI dashboard analysis)
CREATE TABLE IF NOT EXISTS public.cmpri_ai_refresh_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id uuid NOT NULL,
  triggered_by uuid,
  model text,
  provider text,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.cmpri_ai_refresh_events ENABLE ROW LEVEL SECURITY;

-- Maintenance documents (equipment manuals, troubleshooting)
CREATE TABLE IF NOT EXISTS public.maintenance_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id uuid NOT NULL,
  asset_id uuid REFERENCES public.assets(id) ON DELETE CASCADE,
  title text NOT NULL,
  file_url text,
  file_type text,
  verified boolean NOT NULL DEFAULT false,
  error_codes jsonb DEFAULT '[]'::jsonb,
  troubleshooting jsonb DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.maintenance_documents ENABLE ROW LEVEL SECURITY;

-- Troubleshooting cache (issue-specific guidance)
CREATE TABLE IF NOT EXISTS public.troubleshooting_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id uuid NOT NULL,
  asset_id uuid REFERENCES public.assets(id) ON DELETE CASCADE,
  issue_hash text NOT NULL,
  guidance jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.troubleshooting_cache ENABLE ROW LEVEL SECURITY;

-- Pool facilities
CREATE TABLE IF NOT EXISTS public.pool_facilities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id uuid NOT NULL,
  name text NOT NULL,
  type text NOT NULL DEFAULT 'indoor',
  volume_gallons numeric,
  required_flow_gpm numeric,
  sanitizer_type text DEFAULT 'bromine',
  test_kit text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.pool_facilities ENABLE ROW LEVEL SECURITY;

-- Pool log history (audit trail)
CREATE TABLE IF NOT EXISTS public.cmpri_pool_log_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_log_id uuid NOT NULL REFERENCES public.pool_daily_logs(id) ON DELETE CASCADE,
  hotel_id uuid NOT NULL,
  actor_id uuid,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  snapshot jsonb NOT NULL
);
ALTER TABLE public.cmpri_pool_log_history ENABLE ROW LEVEL SECURITY;

-- Work order display ID sequence
CREATE SEQUENCE IF NOT EXISTS public.cmpri_work_order_display_id_seq;