-- Private service-only inbox. No email bodies or bearer credentials are stored here.
create table public.cmpri_email_push_state (
 hotel_id uuid not null references public.hotels(id),
 provider text not null check(provider in ('gmail','microsoft365')),
 mailbox text not null,
 enabled boolean not null default false,
 subscription_id text,
 history_id text,
 page_token text,
 expires_at timestamptz,
 watch_status text not null default 'not-enrolled',
 last_received_at timestamptz,
 last_processed_at timestamptz,
 last_error text,
 lease_owner uuid,
 lease_until timestamptz,
 primary key(hotel_id,provider)
);
create table public.cmpri_email_push_events (
 id bigint generated always as identity primary key,
 hotel_id uuid not null,
 provider text not null,
 event_key text not null,
 message_id text,
 history_id text,
 received_at timestamptz not null default now(),
 processed_at timestamptz,
 foreign key(hotel_id,provider) references public.cmpri_email_push_state(hotel_id,provider),
 unique(hotel_id,provider,event_key)
);
create index cmpri_email_push_pending on public.cmpri_email_push_events(hotel_id,provider,id) where processed_at is null;
alter table public.cmpri_email_push_state enable row level security;
alter table public.cmpri_email_push_events enable row level security;
revoke all on public.cmpri_email_push_state,public.cmpri_email_push_events from public,anon,authenticated;
grant all on public.cmpri_email_push_state,public.cmpri_email_push_events to service_role;
grant usage,select on sequence public.cmpri_email_push_events_id_seq to service_role;
create function public.cmpri_claim_email_push(p_hotel uuid,p_provider text,p_owner uuid)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
begin
 if p_owner is null then return false;end if;
 update public.cmpri_email_push_state set lease_owner=p_owner,lease_until=now()+interval '6 minutes'
 where hotel_id=p_hotel and provider=p_provider and (lease_until is null or lease_until<now());
 return found;
end $$;
revoke all on function public.cmpri_claim_email_push(uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.cmpri_claim_email_push(uuid,text,uuid) to service_role;
