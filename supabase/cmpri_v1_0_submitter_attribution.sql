-- CMPRI V1.0 submitter attribution and submit-only review guard.
-- Direct authenticated inserts cannot bypass Pending Verification for submit-only roles.

begin;

alter table public.work_orders add column if not exists submitted_by_name text;
alter table public.work_orders add column if not exists submitted_by_user_id uuid references auth.users(id) on delete set null;

create or replace function public.cmpri_check_work_order_submitter()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  caller public.profiles%rowtype;
  caller_membership public.hotel_members%rowtype;
  staff_name text;
  normalized_role text;
begin
  -- Trusted server workflows must set their own explicit provenance columns.
  if caller_id is null then
    if auth.role() = 'service_role' then
      return new;
    end if;
    raise exception 'An authenticated active account is required';
  end if;

  select * into caller
  from public.profiles
  where id = caller_id;
  if not found or caller.active is distinct from true then
    raise exception 'An active account is required';
  end if;

  select * into caller_membership
  from public.hotel_members
  where user_id = caller_id
    and hotel_id = new.hotel_id
    and active = true;
  if not found then
    raise exception 'An active membership for this property is required';
  end if;

  normalized_role := regexp_replace(lower(coalesce(caller.role, '')), '[[:space:]_-]', '', 'g');
  new.created_by := caller_id;
  new.creator_account_user_id := caller_id;
  new.submitted_by_user_id := caller_id;

  if normalized_role = 'frontdesk' then
    staff_name := btrim(coalesce(new.submitted_by_name, ''));
    if length(staff_name) < 1 or length(staff_name) > 80 or staff_name !~ '^[[:alpha:]][[:alpha:] ''’-]*$' then
      raise exception 'Enter your first name before submitting';
    end if;
    new.submitted_by_name := staff_name;
    new.creator_name := staff_name;
    new.creator_source := 'front_desk_pending_verification';
    new.status := 'Pending Verification';
  elsif normalized_role in (
    'assistantgm',
    'assistantgeneralmanager',
    'assistantmanager',
    'leadhousekeeper',
    'executivehousekeeper',
    'salesmanager'
  ) then
    new.submitted_by_name := null;
    new.creator_name := coalesce(nullif(btrim(caller.full_name), ''), 'Unknown User');
    new.creator_source := 'department_pending_verification';
    new.status := 'Pending Verification';
  else
    new.submitted_by_name := null;
    new.creator_name := coalesce(nullif(btrim(caller.full_name), ''), 'Unknown User');
    new.creator_source := 'signed_in_user';
  end if;

  return new;
end;
$$;

drop trigger if exists cmpri_work_order_submitter on public.work_orders;
create trigger cmpri_work_order_submitter
before insert on public.work_orders
for each row execute function public.cmpri_check_work_order_submitter();

commit;
