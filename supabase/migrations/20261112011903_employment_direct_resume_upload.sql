-- Private direct uploads: no applicant receives read access to Storage or tables.
do $$
begin
 if exists(select 1 from storage.buckets where id='employment-resumes' and (public or file_size_limit is distinct from 104857600 or allowed_mime_types is distinct from array['application/pdf'])) then
  raise exception 'Existing employment resume bucket settings require explicit review';
 end if;
 insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 values('employment-resumes','employment-resumes',false,104857600,array['application/pdf']) on conflict(id) do nothing;
end $$;

alter table public.employment_resumes alter column original_pdf drop not null;
alter table public.employment_resumes add column storage_path text;
alter table public.employment_resumes add column sha256 text;
alter table public.employment_resumes add column file_size bigint;
alter table public.employment_resumes add constraint employment_resume_source_check check (
 (original_pdf is not null and storage_path is null and sha256 is null and file_size is null)
 or (original_pdf is null and storage_path is not null and sha256 is not null and file_size is not null and sha256 ~ '^[a-f0-9]{64}$'
 and file_size between 5 and 104857600 and storage_path=application_id::text||'/'||sha256||'.pdf')
);
create table public.employment_resume_uploads (
 id uuid primary key,
 answers jsonb not null,
 file_name text not null check(length(file_name) between 1 and 180),
 file_size bigint not null check(file_size between 5 and 104857600),
 sha256 text not null check(sha256 ~ '^[a-f0-9]{64}$'),
 capability_hash text not null check(capability_hash ~ '^[a-f0-9]{64}$'),
 ip_hash text not null check(ip_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default now(),
 expires_at timestamptz not null default now()+interval '2 hours',
 completed_at timestamptz
);
alter table public.employment_resume_uploads enable row level security;
revoke all on public.employment_resume_uploads from public,anon,authenticated;
grant select,insert,update,delete on public.employment_resume_uploads to service_role;
create index employment_resume_uploads_created on public.employment_resume_uploads(created_at);

create function public.prepare_employment_resume_upload(p_id uuid,p_answers jsonb,p_file_name text,p_size bigint,p_sha256 text,p_capability_hash text,p_ip_hash text) returns text
language plpgsql security invoker set search_path='' as $$
declare prior public.employment_resume_uploads;
begin
 -- One admission lock makes concurrent quota checks atomic, including global cap.
 perform pg_advisory_xact_lock(hashtextextended('employment-upload-admission',0));
 select * into prior from public.employment_resume_uploads where id=p_id for update;
 if found then
  if prior.answers is distinct from p_answers or prior.file_name is distinct from p_file_name or prior.file_size is distinct from p_size or prior.sha256 is distinct from p_sha256 or prior.capability_hash is distinct from p_capability_hash then raise exception 'Upload identity conflict';end if;
  if prior.completed_at is not null then return 'complete';end if;
  if prior.expires_at<=now() then raise exception 'Upload expired';end if;
  return 'pending';
 end if;
 if exists(select 1 from public.employment_applications where id=p_id) then raise exception 'Submission identity conflict';end if;
 if p_answers->>'department' not in ('maintenance','front') or length(p_answers->>'email') not between 3 and 180 then raise exception 'Invalid application';end if;
 if (select count(*) from public.employment_resume_uploads where completed_at is null)>=100
 or (select count(*) from public.employment_resume_uploads where created_at>now()-interval '1 hour')>=100
 or (select count(*) from public.employment_resume_uploads where ip_hash=p_ip_hash and created_at>now()-interval '1 hour')>=10
 or (select count(*) from public.employment_resume_uploads where lower(answers->>'email')=lower(p_answers->>'email') and created_at>now()-interval '1 hour')>=3
 then raise exception 'Upload admission limit reached';end if;
 insert into public.employment_resume_uploads(id,answers,file_name,file_size,sha256,capability_hash,ip_hash)
 values(p_id,p_answers,p_file_name,p_size,p_sha256,p_capability_hash,p_ip_hash);
 return 'pending';
end $$;

create function public.finalize_employment_resume_upload(p_id uuid,p_capability_hash text) returns uuid
language plpgsql security invoker set search_path='' as $$
declare pending public.employment_resume_uploads;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_id::text,0));
 select * into pending from public.employment_resume_uploads where id=p_id and capability_hash=p_capability_hash for update;
 if not found then raise exception 'Invalid upload capability';end if;
 if pending.completed_at is not null then return p_id;end if;
 if pending.expires_at<=now() then raise exception 'Upload expired';end if;
 -- Reuse the established atomic submission validation and email quota. The PDF
 -- bytes have already been verified server-side; only its immutable path is saved.
 perform public.submit_employment_with_resume(p_id,pending.answers,null,null);
 insert into public.employment_resumes(application_id,file_name,original_pdf,storage_path,sha256,file_size)
 values(p_id,pending.file_name,null,p_id::text||'/'||pending.sha256||'.pdf',pending.sha256,pending.file_size);
 update public.employment_resume_uploads set completed_at=now() where id=p_id;
 return p_id;
end $$;
revoke all on function public.prepare_employment_resume_upload(uuid,jsonb,text,bigint,text,text,text) from public,anon,authenticated;
revoke all on function public.finalize_employment_resume_upload(uuid,text) from public,anon,authenticated;
grant execute on function public.prepare_employment_resume_upload(uuid,jsonb,text,bigint,text,text,text) to service_role;
grant execute on function public.finalize_employment_resume_upload(uuid,text) to service_role;
