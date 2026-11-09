-- Additive rollout: old producers default to no new intent. No backfill.
alter table public.cmpri_dashboard_notifications
  add column push_requested boolean not null default false;
alter table public.cmpri_web_push_deliveries
  add column inbox_id uuid references public.cmpri_dashboard_notifications(id) on delete cascade;
create index cmpri_web_push_deliveries_inbox_idx
  on public.cmpri_web_push_deliveries (inbox_id) where inbox_id is not null;

create table public.cmpri_event_push_rollout (
  singleton boolean primary key default true check (singleton),
  activated_at timestamptz not null default clock_timestamp()
);
alter table public.cmpri_event_push_rollout enable row level security;
revoke all on public.cmpri_event_push_rollout from public, anon, authenticated;
grant select on public.cmpri_event_push_rollout to service_role;
insert into public.cmpri_event_push_rollout (singleton) values (true);

create function public.cmpri_queue_dashboard_event_push()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not new.push_requested or new.recorded_at < (
    select activated_at from public.cmpri_event_push_rollout where singleton
  ) then return new; end if;
  -- Re-read after the existing technician-resolution INSERT trigger. Rows
  -- already resolved when created are not a new visible notification.
  insert into public.cmpri_web_push_deliveries
    (hotel_id, recipient_user_id, subscription_id, notification_key, status, inbox_id)
  select n.hotel_id, n.recipient_user_id, s.id, n.notification_key, 'pending', n.id
  from public.cmpri_dashboard_notifications n
  join public.cmpri_web_push_subscriptions s
    on s.hotel_id = n.hotel_id and s.recipient_user_id = n.recipient_user_id and s.enabled
  join public.profiles p on p.id = n.recipient_user_id and p.active
  where n.id = new.id and n.read_at is null and n.cleared_at is null
    and exists (select 1 from public.hotel_members m
      where m.hotel_id = n.hotel_id and m.user_id = n.recipient_user_id and m.active)
  on conflict (hotel_id, recipient_user_id, subscription_id, notification_key) do nothing;
  return new;
end;
$$;
revoke all on function public.cmpri_queue_dashboard_event_push() from public, anon, authenticated;
-- PostgreSQL runs triggers of the same kind alphabetically.
create trigger zz_cmpri_queue_dashboard_event_push
after insert on public.cmpri_dashboard_notifications
for each row execute function public.cmpri_queue_dashboard_event_push();
