ALTER TABLE public.cmpri_vendors
  ADD COLUMN IF NOT EXISTS website text NOT NULL DEFAULT '';

ALTER TABLE public.cmpri_inventory_items
  ADD COLUMN IF NOT EXISTS notes text NOT NULL DEFAULT '';

ALTER TABLE public.cmpri_vendor_proposals
  ADD COLUMN IF NOT EXISTS asset_id uuid REFERENCES public.assets(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS work_order_id uuid REFERENCES public.work_orders(id) ON DELETE SET NULL;

ALTER TABLE public.cmpri_order_ideas
  ADD COLUMN IF NOT EXISTS work_order_id uuid REFERENCES public.work_orders(id) ON DELETE SET NULL;
