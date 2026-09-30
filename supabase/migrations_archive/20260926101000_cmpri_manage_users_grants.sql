-- Restore user-management grants for CMPRI roles that can manage subordinate accounts.
-- Update existing rows too so stale explicit denies cannot block account management.
with desired(role, permission, allowed) as (
  values
    ('Chief Engineer', 'manage_users', true),
    ('Engineering Manager', 'manage_users', true),
    ('Regional Maintenance', 'manage_users', true),
    ('General Manager', 'manage_users', true)
)
update public.role_permissions rp
set allowed = d.allowed
from desired d
where rp.role = d.role and rp.permission = d.permission;

with desired(role, permission, allowed) as (
  values
    ('Chief Engineer', 'manage_users', true),
    ('Engineering Manager', 'manage_users', true),
    ('Regional Maintenance', 'manage_users', true),
    ('General Manager', 'manage_users', true)
)
insert into public.role_permissions(role, permission, allowed)
select d.role, d.permission, d.allowed
from desired d
where not exists (
  select 1 from public.role_permissions rp
  where rp.role = d.role and rp.permission = d.permission
);