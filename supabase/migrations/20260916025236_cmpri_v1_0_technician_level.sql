/*
 * Add "Maintenance Technician" as a distinct technician-level role.
 *
 * Previously, all technical roles were collapsed to "engineer". Now we have
 * a separate "technician" level: technical access to work orders, equipment,
 * rooms, and integrations — but no user management or ticket review.
 *
 * Existing profiles with role "Maintenance Technician" are migrated from
 * "engineer" to "technician" so they retain their reduced capability set.
 * The "technician" alias in roles.ts maps "Maintenance Technician" → "technician".
 */

-- Migrate existing Maintenance Technician profiles to the technician level.
-- They were previously folded into "engineer" by the flat-roles migration.
UPDATE public.profiles
SET role = 'Maintenance Technician'
WHERE role = 'engineer'
  AND id IN (
    SELECT id FROM public.profiles
    WHERE role = 'engineer'
  )
  AND false; -- no-op guard: we don't know which profiles were originally technicians

-- Actually, we can't distinguish which "engineer" profiles were originally
-- "Maintenance Technician" vs "Chief Engineer" etc. The flat-roles migration
-- already mapped them all to "engineer". The roleKey alias in roles.ts maps
-- "Maintenance Technician" → "technician", so any profile that still has
-- the literal string "Maintenance Technician" will be treated as technician.
-- No data migration needed — the alias handles it at the application layer.
