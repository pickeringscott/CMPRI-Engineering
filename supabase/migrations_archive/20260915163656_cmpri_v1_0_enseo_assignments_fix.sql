-- Add missing columns to cmpri_enseo_assignments
ALTER TABLE public.cmpri_enseo_assignments ADD COLUMN IF NOT EXISTS asset_id uuid;
ALTER TABLE public.cmpri_enseo_assignments ADD COLUMN IF NOT EXISTS location_id uuid;
ALTER TABLE public.cmpri_enseo_assignments ADD COLUMN IF NOT EXISTS sub_location text;
ALTER TABLE public.cmpri_enseo_assignments ADD COLUMN IF NOT EXISTS endpoint_code text;
ALTER TABLE public.cmpri_enseo_assignments ADD COLUMN IF NOT EXISTS paired_asset_id uuid;
ALTER TABLE public.cmpri_enseo_assignments ADD COLUMN IF NOT EXISTS active boolean DEFAULT true;
ALTER TABLE public.cmpri_enseo_assignments ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 1;
ALTER TABLE public.cmpri_enseo_assignments ADD COLUMN IF NOT EXISTS created_by uuid;
ALTER TABLE public.cmpri_enseo_assignments ADD COLUMN IF NOT EXISTS updated_by uuid;

-- Add missing columns to cmpri_enseo_assignment_history
ALTER TABLE public.cmpri_enseo_assignment_history ADD COLUMN IF NOT EXISTS batch_id uuid;
ALTER TABLE public.cmpri_enseo_assignment_history ADD COLUMN IF NOT EXISTS assignment_id uuid;
ALTER TABLE public.cmpri_enseo_assignment_history ADD COLUMN IF NOT EXISTS actor_id uuid;
ALTER TABLE public.cmpri_enseo_assignment_history ADD COLUMN IF NOT EXISTS action text;
ALTER TABLE public.cmpri_enseo_assignment_history ADD COLUMN IF NOT EXISTS old_values jsonb;
ALTER TABLE public.cmpri_enseo_assignment_history ADD COLUMN IF NOT EXISTS new_values jsonb;

CREATE INDEX IF NOT EXISTS cmpri_enseo_assignments_location_idx
  ON public.cmpri_enseo_assignments(hotel_id, location_id, sub_location)
  WHERE active = true;