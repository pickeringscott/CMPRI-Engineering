-- Sandbox-reviewed schema change: retain the authorized Chief Engineer identity.
-- No existing profile is reclassified; no RLS policy, grant, or account is changed.
DO $$
DECLARE
  definition text;
  expression text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO definition
  FROM pg_constraint
  WHERE conrelid = 'public.profiles'::regclass AND conname = 'profiles_role_check';
  IF definition IS NULL THEN
    RAISE EXCEPTION 'Expected profiles_role_check to exist';
  END IF;
  IF position(quote_literal('chief_engineer') IN definition) = 0 THEN
    expression := substring(definition FROM 8 FOR char_length(definition) - 8);
    ALTER TABLE public.profiles DROP CONSTRAINT profiles_role_check;
    EXECUTE format(
      'ALTER TABLE public.profiles ADD CONSTRAINT profiles_role_check CHECK (role = %L OR (%s))',
      'chief_engineer', expression
    );
  END IF;

  SELECT pg_get_constraintdef(oid) INTO definition
  FROM pg_constraint
  WHERE conrelid = 'public.profiles'::regclass AND conname = 'profiles_secondary_roles_check';
  IF definition IS NULL THEN
    RAISE EXCEPTION 'Expected profiles_secondary_roles_check to exist';
  END IF;
  IF position(quote_literal('chief_engineer') IN definition) = 0 THEN
    expression := substring(definition FROM 8 FOR char_length(definition) - 8);
    -- Preserve the previous allowed set; only the new value is removed before
    -- applying the existing subset check. Unknown secondary roles still fail.
    expression := replace(expression, 'secondary_roles', 'array_remove(secondary_roles, ''chief_engineer'')');
    ALTER TABLE public.profiles DROP CONSTRAINT profiles_secondary_roles_check;
    EXECUTE format('ALTER TABLE public.profiles ADD CONSTRAINT profiles_secondary_roles_check CHECK (%s)', expression);
  END IF;
END $$;
