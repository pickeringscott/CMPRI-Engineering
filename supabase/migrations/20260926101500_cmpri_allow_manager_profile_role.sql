-- Add the normalized manager role while retaining all existing profile-role checks.
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

  if position(quote_literal('manager') in check_definition) = 0 then
    check_expression := substring(check_definition from 8 for char_length(check_definition) - 8);
    execute 'alter table public.profiles drop constraint profiles_role_check';
    execute format(
      'alter table public.profiles add constraint profiles_role_check check (role = %L or (%s))',
      'manager',
      check_expression
    );
  end if;
end $$;