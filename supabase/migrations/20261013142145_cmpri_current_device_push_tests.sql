-- Explicit current-device tests only. No work orders or normal notification rows.
create table public.cmpri_web_push_tests (
  id uuid primary key,
  hotel_id uuid not null,
  recipient_user_id uuid not null references public.profiles(id) on delete cascade,
  subscription_id uuid references public.cmpri_web_push_subscriptions(id) on delete set null,
  delay_seconds integer not null check (delay_seconds in (0, 10)),
  created_at timestamptz not null default now(),
  due_at timestamptz not null,
  expires_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending', 'sending', 'accepted', 'failed', 'cancelled', 'expired', 'blocked', 'unknown'))
);
create index cmpri_web_push_tests_due_idx on public.cmpri_web_push_tests (hotel_id, due_at) where status = 'pending';
create index cmpri_web_push_tests_rate_idx on public.cmpri_web_push_tests (hotel_id, recipient_user_id, created_at desc);
alter table public.cmpri_web_push_tests enable row level security;
revoke all on public.cmpri_web_push_tests from public, anon, authenticated;
grant all on public.cmpri_web_push_tests to service_role;

-- User-wide lock protects quotas across devices and concurrent invocations.
-- Idempotency precedes quota checks; a retried request never creates another job.
create function public.cmpri_enqueue_web_push_test(
  p_id uuid, p_hotel_id uuid, p_user_id uuid, p_subscription_id uuid, p_delay_seconds integer
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  existing public.cmpri_web_push_tests;
  test_time timestamptz := clock_timestamp();
begin
  if p_delay_seconds is null or p_delay_seconds not in (0, 10) then
    raise exception 'push_test_invalid_delay';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_hotel_id::text || ':' || p_user_id::text, 0));
  perform 1 from public.cmpri_web_push_subscriptions
    where id = p_subscription_id and hotel_id = p_hotel_id and recipient_user_id = p_user_id and enabled
    for update;
  if not found then raise exception 'push_test_device_unavailable'; end if;
  select * into existing from public.cmpri_web_push_tests where id = p_id;
  if found then
    if existing.hotel_id <> p_hotel_id or existing.recipient_user_id <> p_user_id
      or existing.subscription_id is distinct from p_subscription_id or existing.delay_seconds <> p_delay_seconds then
      raise exception 'push_test_id_conflict';
    end if;
    return to_jsonb(existing);
  end if;
  if exists (select 1 from public.cmpri_web_push_tests
    where hotel_id = p_hotel_id and recipient_user_id = p_user_id and created_at > test_time - interval '30 seconds')
    or (select count(*) from public.cmpri_web_push_tests
      where hotel_id = p_hotel_id and recipient_user_id = p_user_id and created_at > test_time - interval '1 hour') >= 5 then
    raise exception 'push_test_rate_limit';
  end if;
  insert into public.cmpri_web_push_tests (id, hotel_id, recipient_user_id, subscription_id, delay_seconds, created_at, due_at, expires_at)
    values (p_id, p_hotel_id, p_user_id, p_subscription_id, p_delay_seconds, test_time,
      test_time + make_interval(secs => p_delay_seconds), test_time + make_interval(secs => p_delay_seconds + 90))
    returning * into existing;
  return to_jsonb(existing);
end;
$$;
revoke all on function public.cmpri_enqueue_web_push_test(uuid, uuid, uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.cmpri_enqueue_web_push_test(uuid, uuid, uuid, uuid, integer) to service_role;

-- Disabling/removing/reassigning a subscription cancels queued tests. Keep the
-- test history for quota enforcement even if a device unsubscribes/re-subscribes.
create function public.cmpri_cancel_device_push_tests() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if TG_OP = 'DELETE' then
    update public.cmpri_web_push_tests set status = 'cancelled'
      where subscription_id = OLD.id and status = 'pending';
    return OLD;
  end if;
  if not NEW.enabled or NEW.recipient_user_id <> OLD.recipient_user_id or NEW.hotel_id <> OLD.hotel_id
    or NEW.subscription is distinct from OLD.subscription then
    update public.cmpri_web_push_tests set status = 'cancelled'
      where subscription_id = OLD.id and status = 'pending';
  end if;
  return NEW;
end;
$$;
revoke all on function public.cmpri_cancel_device_push_tests() from public, anon, authenticated;
grant execute on function public.cmpri_cancel_device_push_tests() to service_role;
create trigger cmpri_cancel_device_push_tests before delete or update on public.cmpri_web_push_subscriptions
  for each row execute function public.cmpri_cancel_device_push_tests();
