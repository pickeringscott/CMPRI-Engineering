begin;

-- Find only users with retryable intent and an enabled device. This is a
-- discovery query, not a claim: the existing per-delivery compare-and-swap
-- claim remains authoritative when webhook and cron workers overlap.
create index if not exists cmpri_web_push_retry_recipient_idx
  on public.cmpri_web_push_deliveries (hotel_id, recipient_user_id)
  where status in ('pending', 'sending', 'suppressed', 'failed');

create or replace function public.cmpri_pending_push_recipients(
  p_hotel uuid, p_after uuid default null, p_limit integer default 500
) returns table(recipient_user_id uuid)
language sql stable security invoker set search_path = '' as $$
  select distinct d.recipient_user_id
  from public.cmpri_web_push_deliveries d
  where d.hotel_id = p_hotel
    and d.status in ('pending', 'sending', 'suppressed', 'failed')
    and (p_after is null or d.recipient_user_id > p_after)
    and exists (
      select 1 from public.cmpri_web_push_subscriptions s
      where s.hotel_id = d.hotel_id and s.recipient_user_id = d.recipient_user_id
        and s.enabled = true
    )
  order by d.recipient_user_id
  limit least(greatest(coalesce(p_limit, 500), 1), 500);
$$;
revoke all on function public.cmpri_pending_push_recipients(uuid,uuid,integer) from public, anon, authenticated;
grant execute on function public.cmpri_pending_push_recipients(uuid,uuid,integer) to service_role;

-- One request per INSERT statement, with only its affected users. If the wake
-- fails the durable rows remain and the existing minute cron retries them.
create or replace function cmpri_private.dispatch_notification_event() returns trigger
language plpgsql security definer set search_path = '' as $$
declare dispatch_secret text; recipients jsonb;
begin
  select jsonb_agg(distinct recipient_user_id) into recipients
    from new_deliveries where status = 'pending';
  if recipients is null then return null; end if;
  select decrypted_secret into dispatch_secret from vault.decrypted_secrets where name = 'cmpri_notification_dispatch';
  if dispatch_secret is null then return null; end if;
  perform net.http_post(url := 'https://www.cmpri-engineering.com/api/notifications/dispatch',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || dispatch_secret),
    body := jsonb_build_object('event', 'delivery_created', 'recipient_user_ids', recipients), timeout_milliseconds := 5000);
  return null;
exception when others then
  return null;
end $$;
revoke all on function cmpri_private.dispatch_notification_event() from public, anon, authenticated;
drop trigger if exists notification_event_dispatch on public.cmpri_web_push_deliveries;
create trigger notification_event_dispatch after insert on public.cmpri_web_push_deliveries
  referencing new table as new_deliveries for each statement
  execute function cmpri_private.dispatch_notification_event();

commit;
