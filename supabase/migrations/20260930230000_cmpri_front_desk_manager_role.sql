-- Add Front Desk Manager without changing any existing profile role constraints.
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

  if normalized_role in ('frontdesk', 'frontdeskmanager') then
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

do $$
declare
  check_definition text;
  check_expression text;
begin
  select pg_get_constraintdef(oid)
  into check_definition
  from pg_constraint
  where conrelid = 'public.profiles'::regclass
    and conname = 'profiles_role_check';

  if check_definition is null then
    raise exception 'Expected public.profiles.profiles_role_check to exist';
  end if;

  if position(quote_literal('front_desk_manager') in check_definition) = 0 then
    check_expression := substring(check_definition from 8 for char_length(check_definition) - 8);
    execute 'alter table public.profiles drop constraint profiles_role_check';
    execute format(
      'alter table public.profiles add constraint profiles_role_check check (role = %L or (%s))',
      'front_desk_manager',
      check_expression
    );
  end if;
end $$;
