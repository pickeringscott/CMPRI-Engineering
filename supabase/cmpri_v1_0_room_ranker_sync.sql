-- CMPRI V1.0 Room Ranker synchronization outbox.
-- Work-order state is committed first. This queue then mirrors one tagged line
-- per active guest-room ticket into the corporate Room Ranker notes field.
-- Closing/Will Not Do removes only that exact tagged line and preserves all
-- unrelated corporate-sheet notes.

begin;
create extension if not exists pgcrypto;

create table if not exists public.cmpri_room_ranker_sync_queue (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  work_order_id uuid not null references public.work_orders(id) on delete cascade,
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  processed_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists cmpri_room_ranker_sync_queue_work_order_uidx
  on public.cmpri_room_ranker_sync_queue(hotel_id, work_order_id);
create index if not exists cmpri_room_ranker_sync_queue_due_idx
  on public.cmpri_room_ranker_sync_queue(hotel_id, processed_at, next_attempt_at);

alter table public.cmpri_room_ranker_sync_queue enable row level security;
-- The queue is server-only. No authenticated browser policy is intentionally granted.

create or replace function public.cmpri_enqueue_room_ranker_sync()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if TG_OP = 'INSERT'
     or old.room is distinct from new.room
     or old.issue is distinct from new.issue
     or old.status is distinct from new.status
     or old.display_id is distinct from new.display_id then
    insert into public.cmpri_room_ranker_sync_queue(
      hotel_id, work_order_id, attempts, next_attempt_at, processed_at, last_error, created_at, updated_at
    ) values (
      new.hotel_id, new.id, 0, now(), null, null, now(), now()
    )
    on conflict (hotel_id, work_order_id) do update set
      attempts = 0,
      next_attempt_at = now(),
      processed_at = null,
      last_error = null,
      updated_at = now();
  end if;
  return new;
end;
$$;

drop trigger if exists cmpri_room_ranker_sync_enqueue on public.work_orders;
create trigger cmpri_room_ranker_sync_enqueue
after insert or update of room, issue, status, display_id on public.work_orders
for each row execute function public.cmpri_enqueue_room_ranker_sync();

commit;
