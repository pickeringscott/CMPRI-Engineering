begin;
create table public.employment_resumes (
 application_id uuid primary key references public.employment_applications(id) on delete cascade,
 file_name text not null check(length(file_name) between 1 and 180),
 original_pdf bytea not null check(octet_length(original_pdf) between 5 and 3145728)
);
alter table public.employment_resumes enable row level security;
revoke all on public.employment_resumes from public,anon,authenticated;
grant select,insert,delete on public.employment_resumes to service_role;
create function public.submit_employment_with_resume(p_id uuid,p_answers jsonb,p_file_name text,p_pdf bytea) returns uuid
language plpgsql security invoker set search_path='' as $$
declare existing jsonb; prior_name text; prior_pdf bytea;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_id::text,0));
 select answers into existing from public.employment_applications where id=p_id;
 if found then
  select file_name,original_pdf into prior_name,prior_pdf from public.employment_resumes where application_id=p_id;
  if existing is distinct from p_answers or prior_name is distinct from p_file_name or prior_pdf is distinct from p_pdf then raise exception 'Submission identity conflict';end if;
  return p_id;
 end if;
 if p_answers->>'department' not in ('maintenance','front') then raise exception 'Invalid department';end if;
 if (p_pdf is null) <> (p_file_name is null) then raise exception 'Incomplete attachment';end if;
 if p_pdf is not null and substring(p_pdf from 1 for 5)<>decode('255044462d','hex') then raise exception 'PDF required';end if;
 perform pg_advisory_xact_lock(hashtextextended(lower(p_answers->>'email'),0));
 if (select count(*) from public.employment_applications where lower(answers->>'email')=lower(p_answers->>'email') and created_at>now()-interval '1 hour')>=3 then raise exception 'Submission limit reached';end if;
 insert into public.employment_applications(id,answers) values(p_id,p_answers);
 if p_pdf is not null then insert into public.employment_resumes values(p_id,p_file_name,p_pdf);end if;
 return p_id;
end $$;
revoke all on function public.submit_employment_with_resume(uuid,jsonb,text,bytea) from public,anon,authenticated;
grant execute on function public.submit_employment_with_resume(uuid,jsonb,text,bytea) to service_role;
commit;
