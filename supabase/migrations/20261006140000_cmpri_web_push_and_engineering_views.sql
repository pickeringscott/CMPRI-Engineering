create table if not exists public.cmpri_user_notification_schedules (
  hotel_id uuid not null,
  user_id uuid not null references public.profiles(id) on delete cascade,
  timezone text not null,
  schedule jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (hotel_id, user_id),
  constraint cmpri_user_notification_schedules_timezone_len check (char_length(timezone) between 1 and 100)
);

create table if not exists public.cmpri_web_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null,
  recipient_user_id uuid not null references public.profiles(id) on delete cascade,
  endpoint text not null unique,
  subscription jsonb not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cmpri_web_push_subscription_endpoint_len check (char_length(endpoint) between 1 and 2000)
);

create index if not exists cmpri_web_push_subscriptions_recipient_idx
  on public.cmpri_web_push_subscriptions (hotel_id, recipient_user_id)
  where enabled;

create table if not exists public.cmpri_web_push_deliveries (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null,
  recipient_user_id uuid not null references public.profiles(id) on delete cascade,
  subscription_id uuid not null references public.cmpri_web_push_subscriptions(id) on delete cascade,
  notification_key text not null,
  status text not null check (status in ('pending', 'sent', 'suppressed', 'failed')),
  created_at timestamptz not null default now(),
  unique (hotel_id, recipient_user_id, subscription_id, notification_key)
);

create table if not exists public.cmpri_work_order_engineering_views (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null,
  work_order_id uuid not null references public.work_orders(id) on delete cascade,
  work_order_display_id text not null default '',
  engineering_user_id uuid not null references public.profiles(id) on delete cascade,
  viewed_at timestamptz not null default now(),
  unique (hotel_id, work_order_id, engineering_user_id)
);

alter table public.cmpri_user_notification_schedules enable row level security;
alter table public.cmpri_web_push_subscriptions enable row level security;
alter table public.cmpri_web_push_deliveries enable row level security;
alter table public.cmpri_work_order_engineering_views enable row level security;

revoke all on table public.cmpri_user_notification_schedules from anon, authenticated;
revoke all on table public.cmpri_web_push_subscriptions from anon, authenticated;
revoke all on table public.cmpri_web_push_deliveries from anon, authenticated;
revoke all on table public.cmpri_work_order_engineering_views from anon, authenticated;

grant all on table public.cmpri_user_notification_schedules to service_role;
grant all on table public.cmpri_web_push_subscriptions to service_role;
grant all on table public.cmpri_web_push_deliveries to service_role;
grant all on table public.cmpri_work_order_engineering_views to service_role;

create or replace function public.cmpri_resolve_technician_new_order_notification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_role text;
begin
  if new.actor_user_id is null or new.event_type = 'created' then
    return new;
  end if;

  select regexp_replace(lower(coalesce(p.role, '')), '[^a-z0-9]', '', 'g')
    into actor_role
    from public.profiles p
    join public.hotel_members hm on hm.user_id = p.id
   where p.id = new.actor_user_id
     and p.active = true
     and hm.hotel_id = new.hotel_id
     and hm.active = true;

  if actor_role is null or actor_role not in (
    'chiefengineer', 'engineer', 'engineering', 'engineeringmanager',
    'regionalmaintenance', 'regionalengineer', 'systemadmin',
    'systemadministrator', 'administrator', 'admin'
  ) then
    return new;
  end if;

  insert into public.cmpri_work_order_engineering_views (
    hotel_id, work_order_id, work_order_display_id, engineering_user_id, viewed_at
  ) values (
    new.hotel_id, new.work_order_id, coalesce(new.snapshot->>'display_id', ''),
    new.actor_user_id, new.recorded_at
  )
  on conflict (hotel_id, work_order_id, engineering_user_id) do nothing;

  update public.cmpri_dashboard_notifications n
     set cleared_at = new.recorded_at
   where n.hotel_id = new.hotel_id
     and n.work_order_id = new.work_order_id
     and n.notification_key = 'new-order:' || new.work_order_id::text
     and n.cleared_at is null
     and n.recipient_user_id in (
       select p.id
         from public.profiles p
         join public.hotel_members hm on hm.user_id = p.id
        where p.active = true
          and hm.hotel_id = new.hotel_id
          and hm.active = true
          and regexp_replace(lower(coalesce(p.role, '')), '[^a-z0-9]', '', 'g')
              in ('technician', 'maintenancetechnician')
     );

  return new;
end;
$$;

revoke all on function public.cmpri_resolve_technician_new_order_notification() from public, anon, authenticated;

drop trigger if exists cmpri_resolve_technician_new_order_notification on public.cmpri_work_order_history;
create trigger cmpri_resolve_technician_new_order_notification
after insert on public.cmpri_work_order_history
for each row execute function public.cmpri_resolve_technician_new_order_notification();
