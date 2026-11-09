-- Held release: apply only with a separately authorized release.
begin;
create table public.cmpri_pm_close_receipts (
 hotel_id uuid not null references public.hotels(id), actor_id uuid not null references auth.users(id),
 request_id uuid not null, request_hash text not null, client_hash text not null, result jsonb not null,
 created_at timestamptz not null default now(), primary key(hotel_id,actor_id,request_id)
);
alter table public.cmpri_pm_close_receipts enable row level security;
revoke all on public.cmpri_pm_close_receipts from public,anon,authenticated;
grant all on public.cmpri_pm_close_receipts to service_role;
-- PM writes now use the authorized server routes and their transactional guards.
-- Existing SELECT policies and application role capabilities are unchanged.
revoke insert,update,delete on public.cmpri_pm_proposals from anon,authenticated;

create function public.cmpri_pm_pool_completion_guard() returns trigger
language plpgsql security definer set search_path='' as $$
declare log_row public.pool_daily_logs%rowtype; worker public.profiles%rowtype; prior public.cmpri_pm_proposals%rowtype; was_checked boolean;
begin
 if new.template_id <> 'workbook:daily' then return new; end if;
 was_checked := TG_OP='UPDATE' and coalesce(old.payload->'responses'->>'daily-16','false')='true';
 if was_checked then
   if coalesce(new.payload->'responses'->>'daily-16','false') <> 'true' or new.status='rejected'
      or new.submitted_by is distinct from old.submitted_by then raise exception 'Submitted pool completion cannot be undone' using errcode='23514'; end if;
   new.payload := new.payload || jsonb_build_object('pm_pool_worker',old.payload->'pm_pool_worker','pm_pool_log',old.payload->'pm_pool_log');
   if old.payload->'pm_item_roles' ? 'daily-16' then new.payload:=jsonb_set(new.payload,'{pm_item_roles}',coalesce(new.payload->'pm_item_roles','{}')||jsonb_build_object('daily-16',old.payload->'pm_item_roles'->'daily-16')); end if;
   if coalesce(new.payload->'pm_review'->>'daily-16','needs')<>'approved' then new.status:='pending'; end if;
   if coalesce(old.payload->'pm_review'->>'daily-16',case when old.status='approved' then 'approved' else 'needs' end)='approved'
      and coalesce(new.payload->'pm_review'->>'daily-16',case when new.status='approved' then 'approved' else 'needs' end) <> 'approved'
      then raise exception 'Approved pool completion cannot be undone' using errcode='23514'; end if;
   return new;
 end if;
 if coalesce(new.payload->'responses'->>'daily-16','false') <> 'true' then return new; end if;
 perform pg_advisory_xact_lock(hashtextextended(new.hotel_id::text||':pm-pool:'||new.period_start::text,0));
 select * into prior from public.cmpri_pm_proposals where hotel_id=new.hotel_id and template_id=new.template_id
   and period_start=new.period_start and status<>'rejected' and id<>new.id and payload->'responses'->>'daily-16'='true' limit 1;
 if found then raise exception 'Pool work is already submitted; review the original completion' using errcode='40001'; end if;
 select * into log_row from public.pool_daily_logs where hotel_id=new.hotel_id and log_date=new.period_start
   and temperature_f is not null and flow_rate_gpm is not null and main_drain_visible is not null and filter_backwashed is not null
   and ((ph_am is not null and (sanitizer_am is not null or sanitizer_band_am is not null))
     or (ph_pm is not null and (sanitizer_pm is not null or sanitizer_band_pm is not null)))
   order by updated_at desc,id limit 1 for share;
 if not found then raise exception 'Complete the pool log for this date first' using errcode='23514'; end if;
 select * into worker from public.profiles where id=coalesce(log_row.updated_by,log_row.created_by);
 if not found then raise exception 'Pool worker attribution is unavailable' using errcode='23514'; end if;
 new.payload := new.payload || jsonb_build_object(
   'pm_pool_log',jsonb_build_object('id',log_row.id,'created_by',log_row.created_by,'updated_by',log_row.updated_by,'initials',log_row.completed_by_initials),
   'pm_pool_worker',jsonb_build_object('id',worker.id,'name',worker.full_name));
 new.payload := jsonb_set(new.payload,'{pm_review}',coalesce(new.payload->'pm_review','{}')||jsonb_build_object('daily-16',
   case when lower(coalesce(worker.role,'')||' '||coalesce(worker.secondary_roles::text,'')) ~ '(engineer|system.?admin)' or (new.payload->>'pm_pool_approval'='true' and exists(select 1 from public.profiles actor where actor.id=new.submitted_by and lower(coalesce(actor.role,'')||' '||coalesce(actor.secondary_roles::text,'')) ~ '(engineer|system.?admin)')) then 'approved' else 'needs' end));
 new.payload := jsonb_set(new.payload,'{pm_item_roles}',coalesce(new.payload->'pm_item_roles','{}')||jsonb_build_object('daily-16',
   case when lower(coalesce(worker.role,'')||' '||coalesce(worker.secondary_roles::text,'')) ~ '(engineer|system.?admin)' then 'chief' else 'technician' end));
 if new.payload->'pm_review'->>'daily-16'='needs' then new.status:='pending'; end if;
 return new;
end $$;
revoke all on function public.cmpri_pm_pool_completion_guard() from public,anon,authenticated;
create trigger cmpri_pm_pool_guard before insert or update on public.cmpri_pm_proposals
 for each row execute function public.cmpri_pm_pool_completion_guard();

create function public.cmpri_save_pm_entry(p_hotel uuid,p_actor uuid,p_existing uuid,p_revision bigint,p_record jsonb,p_request uuid,p_links jsonb)
returns jsonb language plpgsql security invoker set search_path='' set lock_timeout='3s' as $$
declare receipt public.cmpri_pm_close_receipts%rowtype; saved public.cmpri_pm_proposals%rowtype; input public.cmpri_pm_proposals%rowtype; fingerprint text; item record; latest public.cmpri_pm_proposals%rowtype; original public.cmpri_pm_proposals%rowtype; link jsonb;
begin
 if current_user<>'service_role' then raise exception 'Server-only PM save' using errcode='42501'; end if;
 if p_request is null or p_actor is null or p_record->>'hotel_id' is distinct from p_hotel::text
   or p_record->>'submitted_by' is distinct from p_actor::text then raise exception 'Invalid PM save' using errcode='22023'; end if;
 fingerprint:=p_record->'payload'->>'pm_close_fingerprint';
 perform pg_advisory_xact_lock(hashtextextended(p_hotel::text||':pm-save:'||p_actor::text||':'||p_request::text,0));
 select * into receipt from public.cmpri_pm_close_receipts where hotel_id=p_hotel and actor_id=p_actor and request_id=p_request;
 if found then
   if receipt.request_hash<>fingerprint then raise exception 'Save identity reused with different changes' using errcode='40001'; end if;
   return receipt.result;
 end if;
 input:=jsonb_populate_record(null::public.cmpri_pm_proposals,p_record);
 lock table public.cmpri_pm_proposals in share row exclusive mode;
 for link in select value from jsonb_array_elements(p_links) order by value->>'id' loop
   select * into latest from public.cmpri_pm_proposals where hotel_id=p_hotel and id=(link->>'id')::uuid for update;
   if not found or latest.revision<>(link->>'revision')::bigint or latest.status<>'pending' then raise exception 'Attached form changed before completion' using errcode='40001'; end if;
 end loop;
 if p_existing is not null then select * into original from public.cmpri_pm_proposals where id=p_existing and hotel_id=p_hotel; end if;
 if input.template_id like 'workbook:%' then
   for item in select key,value from jsonb_each(input.payload->'responses') loop
     if p_existing is not null and original.payload->'responses'->item.key = item.value then continue; end if;
     select * into latest from public.cmpri_pm_proposals where hotel_id=p_hotel and template_id=input.template_id
       and period_start=input.period_start and scope_key=input.scope_key and status<>'rejected' and payload->'responses' ? item.key
       order by coalesce(payload->'pm_item_changed_at'->>item.key,updated_at::text) desc,updated_at desc,id desc limit 1;
     if found and latest.payload->'responses'->item.key='true'::jsonb and latest.submitted_by is distinct from p_actor
       then raise exception 'Preserve the original task submission; review its checkbox' using errcode='40001'; end if;
   end loop;
 end if;
 if p_existing is null then
   if p_revision<>0 then raise exception 'PM changed before saving' using errcode='40001'; end if;
   insert into public.cmpri_pm_proposals(hotel_id,template_id,period_start,scope_key,payload,proposed_cells,status,submitted_by,submitted_by_name,reviewed_by,reviewed_at)
    values(p_hotel,input.template_id,input.period_start,input.scope_key,input.payload,'[]',input.status,p_actor,input.submitted_by_name,input.reviewed_by,input.reviewed_at) returning * into saved;
 else
   update public.cmpri_pm_proposals set payload=input.payload,scope_key=input.scope_key,status=input.status,
     reviewed_by=input.reviewed_by,reviewed_at=input.reviewed_at,proposed_cells='[]'
    where hotel_id=p_hotel and id=p_existing and submitted_by=p_actor and status='pending' and revision=p_revision returning * into saved;
   if not found then raise exception 'PM changed before saving' using errcode='40001'; end if;
 end if;
 for link in select value from jsonb_array_elements(p_links) loop
   update public.cmpri_pm_proposals set status='approved',payload=payload||'{"is_complete":true}'::jsonb,reviewed_by=p_actor,reviewed_at=now()
    where id=(link->>'id')::uuid and hotel_id=p_hotel;
 end loop;
 insert into public.cmpri_pm_close_receipts(hotel_id,actor_id,request_id,request_hash,client_hash,result) values(p_hotel,p_actor,p_request,fingerprint,p_record->'payload'->>'pm_close_fingerprint',to_jsonb(saved));
 return to_jsonb(saved);
end $$;
revoke all on function public.cmpri_save_pm_entry(uuid,uuid,uuid,bigint,jsonb,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.cmpri_save_pm_entry(uuid,uuid,uuid,bigint,jsonb,uuid,jsonb) to service_role;

create function public.cmpri_review_pm_items(p_hotel uuid,p_actor uuid,p_proposal uuid,p_revision bigint,p_states jsonb,p_links jsonb,p_final boolean,p_request uuid,p_client_hash text)
returns jsonb language plpgsql security invoker set search_path='' set lock_timeout='3s' as $$
declare original public.cmpri_pm_proposals%rowtype; linked public.cmpri_pm_proposals%rowtype; link jsonb; saved jsonb; receipt public.cmpri_pm_close_receipts%rowtype; fingerprint text;
begin
 if current_user<>'service_role' then raise exception 'Server-only PM review' using errcode='42501'; end if;
 lock table public.cmpri_pm_proposals in share row exclusive mode;
 fingerprint:=p_client_hash;
 perform pg_advisory_xact_lock(hashtextextended(p_hotel::text||':pm-review:'||p_proposal::text,0));
 select * into receipt from public.cmpri_pm_close_receipts where hotel_id=p_hotel and actor_id=p_actor and request_id=p_request;
 if found then
   if receipt.request_hash<>fingerprint then raise exception 'Review identity reused' using errcode='40001'; end if;
   return receipt.result;
 end if;
 select * into original from public.cmpri_pm_proposals where hotel_id=p_hotel and id=p_proposal for update;
 if not found or original.status<>'pending' or original.revision<>p_revision then raise exception 'PM changed before review' using errcode='40001'; end if;
 for link in select value from jsonb_array_elements(p_links) order by value->>'id' loop
   select * into linked from public.cmpri_pm_proposals where hotel_id=p_hotel and id=(link->>'id')::uuid for update;
   if not found or linked.revision<>(link->>'revision')::bigint or linked.status<>'pending' then raise exception 'Attached form changed before review' using errcode='40001'; end if;
 end loop;
 update public.cmpri_pm_proposals set payload=jsonb_set(payload,'{pm_review}',coalesce(payload->'pm_review','{}')||p_states),
   status=case when p_final then 'approved' else status end,reviewed_by=p_actor,reviewed_at=now()
   where id=p_proposal and hotel_id=p_hotel returning to_jsonb(cmpri_pm_proposals.*) into saved;
 for link in select value from jsonb_array_elements(p_links) loop
   update public.cmpri_pm_proposals set status='approved',payload=payload||'{"is_complete":true}'::jsonb,reviewed_by=p_actor,reviewed_at=now()
    where id=(link->>'id')::uuid and hotel_id=p_hotel;
 end loop;
 insert into public.cmpri_pm_close_receipts(hotel_id,actor_id,request_id,request_hash,client_hash,result) values(p_hotel,p_actor,p_request,fingerprint,p_client_hash,saved);
 return saved;
end $$;
revoke all on function public.cmpri_review_pm_items(uuid,uuid,uuid,bigint,jsonb,jsonb,boolean,uuid,text) from public,anon,authenticated;
grant execute on function public.cmpri_review_pm_items(uuid,uuid,uuid,bigint,jsonb,jsonb,boolean,uuid,text) to service_role;

create function public.cmpri_capture_pm_review_event() returns trigger language plpgsql security definer set search_path='' as $$
begin
 insert into public.cmpri_notification_events(hotel_id,kind,source_id,payload)
 values(new.hotel_id,'pm:'||new.revision::text,new.id,to_jsonb(new)) on conflict(kind,source_id) do nothing;
 return new;
end $$;
revoke all on function public.cmpri_capture_pm_review_event() from public,anon,authenticated;
create trigger cmpri_committed_pm_review after insert or update on public.cmpri_pm_proposals
 for each row execute function public.cmpri_capture_pm_review_event();
commit;