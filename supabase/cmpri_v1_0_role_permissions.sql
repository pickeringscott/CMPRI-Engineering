-- CMPRI V1.0 named-role permission grants.
-- Application role policy remains the upper bound. These rows only allow the
-- mutation capabilities already authorized for each named CMPRI role.

create table if not exists public.role_permissions (
  role text not null,
  permission text not null,
  allowed boolean not null default false
);

-- Do not add a uniqueness constraint here: older CMPRI environments may already
-- contain duplicate historical rows. The application treats conflicting allow/deny
-- rows as denied, and this migration updates every matching canonical row.

with desired(role, permission, allowed) as (
  values
    ('Chief Engineer', 'manage_work_orders', true),
    ('Chief Engineer', 'close_work_orders', true),
    ('Chief Engineer', 'manage_assets', true),
    ('Chief Engineer', 'manage_rooms', true),
    ('Chief Engineer', 'manage_users', true),
    ('Chief Engineer', 'manage_pm', true),
    ('Chief Engineer', 'manage_integrations', true),

    ('Maintenance Technician', 'manage_work_orders', true),
    ('Maintenance Technician', 'close_work_orders', true),
    ('Maintenance Technician', 'manage_assets', true),
    ('Maintenance Technician', 'manage_rooms', true),
    ('Maintenance Technician', 'manage_pm', true),
    ('Maintenance Technician', 'manage_integrations', true),

    ('Regional Maintenance', 'manage_work_orders', true),
    ('Regional Maintenance', 'close_work_orders', true),
    ('Regional Maintenance', 'manage_assets', true),
    ('Regional Maintenance', 'manage_rooms', true),
    ('Regional Maintenance', 'manage_pm', true),
    ('Regional Maintenance', 'manage_integrations', true),

    ('General Manager', 'approve_work_orders', true),
    ('General Manager', 'review_work_orders', true),
    ('General Manager', 'manage_users', true),

    ('System Admin', 'manage_work_orders', true),
    ('System Admin', 'close_work_orders', true),
    ('System Admin', 'manage_assets', true),
    ('System Admin', 'manage_rooms', true),
    ('System Admin', 'manage_users', true),
    ('System Admin', 'manage_pm', true),
    ('System Admin', 'manage_integrations', true)
)
insert into public.role_permissions(role, permission, allowed)
select d.role, d.permission, d.allowed
from desired d
where not exists (
  select 1 from public.role_permissions rp
  where rp.role = d.role and rp.permission = d.permission
);

with desired(role, permission, allowed) as (
  values
    ('Chief Engineer', 'manage_work_orders', true),
    ('Chief Engineer', 'close_work_orders', true),
    ('Chief Engineer', 'manage_assets', true),
    ('Chief Engineer', 'manage_rooms', true),
    ('Chief Engineer', 'manage_users', true),
    ('Chief Engineer', 'manage_pm', true),
    ('Chief Engineer', 'manage_integrations', true),
    ('Maintenance Technician', 'manage_work_orders', true),
    ('Maintenance Technician', 'close_work_orders', true),
    ('Maintenance Technician', 'manage_assets', true),
    ('Maintenance Technician', 'manage_rooms', true),
    ('Maintenance Technician', 'manage_pm', true),
    ('Maintenance Technician', 'manage_integrations', true),
    ('Regional Maintenance', 'manage_work_orders', true),
    ('Regional Maintenance', 'close_work_orders', true),
    ('Regional Maintenance', 'manage_assets', true),
    ('Regional Maintenance', 'manage_rooms', true),
    ('Regional Maintenance', 'manage_pm', true),
    ('Regional Maintenance', 'manage_integrations', true),
    ('General Manager', 'approve_work_orders', true),
    ('General Manager', 'review_work_orders', true),
    ('General Manager', 'manage_users', true),
    ('System Admin', 'manage_work_orders', true),
    ('System Admin', 'close_work_orders', true),
    ('System Admin', 'manage_assets', true),
    ('System Admin', 'manage_rooms', true),
    ('System Admin', 'manage_users', true),
    ('System Admin', 'manage_pm', true),
    ('System Admin', 'manage_integrations', true)
)
update public.role_permissions rp
set allowed = d.allowed
from desired d
where rp.role = d.role and rp.permission = d.permission;
