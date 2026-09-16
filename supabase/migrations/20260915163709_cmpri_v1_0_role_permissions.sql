-- Insert missing role permissions with human-readable role names
INSERT INTO public.role_permissions(role, permission, allowed)
SELECT d.role, d.permission, d.allowed
FROM (VALUES
    ('Chief Engineer', 'manage_rooms', true),
    ('Chief Engineer', 'manage_integrations', true),
    ('Maintenance Technician', 'manage_rooms', true),
    ('Maintenance Technician', 'manage_integrations', true),
    ('Regional Maintenance', 'manage_rooms', true),
    ('Regional Maintenance', 'manage_integrations', true),
    ('General Manager', 'approve_work_orders', true),
    ('General Manager', 'review_work_orders', true),
    ('System Admin', 'manage_rooms', true),
    ('System Admin', 'manage_integrations', true)
) AS d(role, permission, allowed)
WHERE NOT EXISTS (
  SELECT 1 FROM public.role_permissions rp
  WHERE rp.role = d.role AND rp.permission = d.permission
);