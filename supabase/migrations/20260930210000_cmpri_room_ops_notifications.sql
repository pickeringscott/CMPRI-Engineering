-- Extend the persistent dashboard inbox to store Daily Room Ops alerts.
alter table public.cmpri_dashboard_notifications
  alter column work_order_id drop not null;

alter table public.cmpri_dashboard_notifications
  add column if not exists target_path text;

alter table public.cmpri_dashboard_notifications
  drop constraint if exists cmpri_dashboard_notifications_message_len;

alter table public.cmpri_dashboard_notifications
  add constraint cmpri_dashboard_notifications_message_len
  check (char_length(message) between 1 and 120000);

alter table public.cmpri_dashboard_notifications
  drop constraint if exists cmpri_dashboard_notifications_target;

alter table public.cmpri_dashboard_notifications
  add constraint cmpri_dashboard_notifications_target check (
    (work_order_id is not null and target_path is null)
    or (work_order_id is null and target_path = '/engineering/room-operations')
  );
