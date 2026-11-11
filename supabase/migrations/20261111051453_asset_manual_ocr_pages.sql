begin;

-- OCR derivatives are server-controlled and scoped to one registered source.
-- Browser roles cannot write text that could be mistaken for the source PDF.
create table public.cmpri_asset_manual_ocr_jobs (
  hotel_id uuid not null,
  asset_id uuid not null,
  source_path text not null,
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  total_pages integer not null check (total_pages between 1 and 600),
  next_page integer not null default 1 check (next_page between 1 and 601),
  status text not null default 'pending' check (status in ('pending','processing','complete','failed','cancelled')),
  attempts integer not null default 0 check (attempts between 0 and 100),
  lease_token uuid,
  lease_expires_at timestamptz,
  error text,
  updated_at timestamptz not null default now(),
  primary key (hotel_id, asset_id, source_sha256)
);
create index cmpri_asset_manual_ocr_jobs_pending on public.cmpri_asset_manual_ocr_jobs (updated_at)
  where status in ('pending','processing');
alter table public.cmpri_asset_manual_ocr_jobs enable row level security;
revoke all on public.cmpri_asset_manual_ocr_jobs from public, anon, authenticated;
grant select, insert, update, delete on public.cmpri_asset_manual_ocr_jobs to service_role;
create trigger resource_asset_manual_ocr_jobs after insert or update or delete on public.cmpri_asset_manual_ocr_jobs
  for each row execute function cmpri_private.signal_resource('reference');

create table public.cmpri_asset_manual_ocr_pages (
  hotel_id uuid not null,
  asset_id uuid not null,
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  page_number integer not null check (page_number between 1 and 600),
  text text not null check (length(text) <= 50000),
  confidence real not null check (confidence between 0 and 100),
  created_at timestamptz not null default now(),
  primary key (hotel_id, asset_id, source_sha256, page_number),
  foreign key (hotel_id, asset_id, source_sha256) references public.cmpri_asset_manual_ocr_jobs (hotel_id, asset_id, source_sha256) on delete cascade
);
alter table public.cmpri_asset_manual_ocr_pages enable row level security;
revoke all on public.cmpri_asset_manual_ocr_pages from public, anon, authenticated;
grant select, insert, update, delete on public.cmpri_asset_manual_ocr_pages to service_role;

-- The lease is claimed atomically so simultaneous cron invocations cannot
-- process and advance the same job. Expired leases are recoverable.
create function public.cmpri_claim_asset_manual_ocr_job(p_hotel uuid)
returns setof public.cmpri_asset_manual_ocr_jobs
language plpgsql security definer set search_path = '' as $$
declare claimed public.cmpri_asset_manual_ocr_jobs;
begin
  select * into claimed from public.cmpri_asset_manual_ocr_jobs
   where hotel_id = p_hotel and (status = 'pending' or (status = 'processing' and lease_expires_at < now()))
   order by updated_at for update skip locked limit 1;
  if not found then return; end if;
  update public.cmpri_asset_manual_ocr_jobs set status='processing', attempts=attempts+1, lease_token=gen_random_uuid(), lease_expires_at=now()+interval '5 minutes', updated_at=now()
   where hotel_id=claimed.hotel_id and asset_id=claimed.asset_id and source_sha256=claimed.source_sha256
   returning * into claimed;
  return next claimed;
end $$;
revoke all on function public.cmpri_claim_asset_manual_ocr_job(uuid) from public, anon, authenticated;
grant execute on function public.cmpri_claim_asset_manual_ocr_job(uuid) to service_role;
commit;
