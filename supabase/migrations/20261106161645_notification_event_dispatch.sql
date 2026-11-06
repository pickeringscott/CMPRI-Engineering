begin;
create extension if not exists pg_net with schema extensions;
create or replace function cmpri_private.dispatch_notification_event() returns trigger
language plpgsql security definer set search_path='' as $$
declare dispatch_secret text;
begin
 select decrypted_secret into dispatch_secret from vault.decrypted_secrets where name='cmpri_notification_dispatch';
 if dispatch_secret is null then return null; end if;
 -- Delivery leases make concurrent wakes idempotent. The minute cron retries failures.
 perform net.http_post(url := 'https://www.cmpri-engineering.com/api/notifications/dispatch',
  headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||dispatch_secret),
  body := jsonb_build_object('event','delivery_created'), timeout_milliseconds := 5000);
 return null;
exception when others then
 -- HTTP queue failures cannot roll back a ticket. Durable intent remains for recovery.
 return null;
end $$;
revoke all on function cmpri_private.dispatch_notification_event() from public,anon,authenticated;
create trigger notification_event_dispatch after insert on public.cmpri_web_push_deliveries
for each row when (new.status='pending') execute function cmpri_private.dispatch_notification_event();
-- Extend closure indications to every active profile without replaying historical alerts.
do $update$
declare definition text;
begin
 select pg_get_functiondef(oid) into definition from pg_proc where proname='cmpri_pool_reconcile' and pronamespace='public'::regnamespace;
 if definition is null then raise exception 'Pool reconciliation function is required'; end if;
 definition=replace(definition,$old$'frontdeskagent')$old$,$new$'frontdeskagent','housekeeping','housekeeper','seniormanagement','systemadmin','systemadministrator')$new$);
 definition=replace(definition,'public.cmpri_pool_clock(),false','public.cmpri_pool_clock(),true');
 execute definition;
end $update$;
commit;
