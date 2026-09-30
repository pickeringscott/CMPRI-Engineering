-- Server-side dashboard notification inbox.
-- Notifications follow each user to every computer and stay until that user
-- clears them. Technician actions never clear another user's notifications.
-- Access is only through the API (service role); anon/authenticated are revoked.

create table if not exists public.cmpri_dashboard_notifications (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null,
  recipient_user_id uuid not null references public.profiles(id) on delete cascade,
  notification_key text not null,
  work_order_id uuid not null,
  message text not null,
  recorded_at timestamptz not null default now(),
  cleared_at timestamptz,
  created_at timestamptz not null default now(),
  constraint cmpri_dashboard_notifications_key_len check (char_length(notification_key) between 1 and 200),
  constraint cmpri_dashboard_notifications_message_len check (char_length(message) between 1 and 500),
  constraint cmpri_dashboard_notifications_recipient_key unique (hotel_id, recipient_user_id, notification_key)
);

create index if not exists cmpri_dashboard_notifications_open_idx
  on public.cmpri_dashboard_notifications (hotel_id, recipient_user_id, recorded_at desc)
  where cleared_at is null;

create table if not exists public.cmpri_dashboard_notification_cursors (
  hotel_id uuid not null,
  recipient_user_id uuid not null references public.profiles(id) on delete cascade,
  checked_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (hotel_id, recipient_user_id)
);

create index if not exists work_orders_hotel_created_at_idx
  on public.work_orders (hotel_id, created_at);

create index if not exists cmpri_work_order_technician_views_viewed_idx
  on public.cmpri_work_order_technician_views (hotel_id, viewed_at);

alter table public.cmpri_dashboard_notifications enable row level security;
alter table public.cmpri_dashboard_notification_cursors enable row level security;

revoke all on table public.cmpri_dashboard_notifications from anon, authenticated;
revoke all on table public.cmpri_dashboard_notification_cursors from anon, authenticated;
grant all on table public.cmpri_dashboard_notifications to service_role;
grant all on table public.cmpri_dashboard_notification_cursors to service_role;
