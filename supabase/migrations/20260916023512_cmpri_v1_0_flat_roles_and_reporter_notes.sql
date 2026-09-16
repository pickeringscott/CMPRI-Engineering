/*
# Flatten roles to Engineer/Front Desk/Housekeeping + add reporter_notes column

## Role simplification
The role hierarchy is collapsed to three flat roles:
- "engineer" — all technical staff (was chief_engineer, maintenance_technician, regional_maintenance, general_manager, senior_management)
- "front_desk" — unchanged
- "housekeeping" — was lead_housekeeper, sales_manager, assistant_gm
- "system_admin" — retained as internal bootstrap role

Existing profiles are migrated to the new role names so nobody loses access.

## Reporter notes
A new `reporter_notes` column is added to `work_orders` to hold extra commentary
that the system separates from the core issue symptom when a ticket is submitted.
This lets the issue field stay concise while still preserving everything the
reporter said.

1. New columns
- `work_orders.reporter_notes` (text, nullable) — separated commentary from the reporter

2. Data migration
- UPDATE profiles SET role = 'engineer' WHERE role IN ('chief_engineer','maintenance_technician','regional_maintenance','general_manager','senior_management')
- UPDATE profiles SET role = 'housekeeping' WHERE role IN ('lead_housekeeper','sales_manager','assistant_gm')

3. Security
- No RLS policy changes (work_orders already has RLS enabled)
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'work_orders' AND column_name = 'reporter_notes'
  ) THEN
    ALTER TABLE public.work_orders ADD COLUMN reporter_notes text;
  END IF;
END $$;

UPDATE public.profiles
SET role = 'engineer'
WHERE role IN ('chief_engineer', 'maintenance_technician', 'regional_maintenance', 'general_manager', 'senior_management')
  AND role IS NOT NULL;

UPDATE public.profiles
SET role = 'housekeeping'
WHERE role IN ('lead_housekeeper', 'sales_manager', 'assistant_gm')
  AND role IS NOT NULL;
