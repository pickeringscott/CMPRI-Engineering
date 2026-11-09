-- Employment-only additive release. No grants to public applicants or staff roles.
begin;
create table public.employment_applications (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  answers jsonb not null check (jsonb_typeof(answers) = 'object' and octet_length(answers::text) <= 20000)
);
alter table public.employment_applications enable row level security;
revoke all on public.employment_applications from public, anon, authenticated;
grant select, insert, delete on public.employment_applications to service_role;
create index employment_applications_created_idx on public.employment_applications(created_at desc);
create index employment_applications_email_idx on public.employment_applications(lower(answers->>'email'),created_at);
create function public.submit_employment_application(p_answers jsonb) returns void
language plpgsql security invoker set search_path = '' as $$
begin
  -- Serialized per-email throttling, without saving IP addresses or adding a service.
  perform pg_advisory_xact_lock(hashtextextended(lower(p_answers->>'email'), 0));
  if (select count(*) from public.employment_applications a where lower(a.answers->>'email') = lower(p_answers->>'email') and a.created_at > now()-interval '1 hour') >= 3 then
    raise exception 'Submission limit reached';
  end if;
  insert into public.employment_applications(answers) values (p_answers);
end;
$$;
revoke all on function public.submit_employment_application(jsonb) from public, anon, authenticated;
grant execute on function public.submit_employment_application(jsonb) to service_role;
commit;

