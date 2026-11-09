begin;
set local lock_timeout = '5s';

-- Keep the dashboard's default order in the database so paging happens before
-- room and parts enrichment. Compare enum values directly: enum-to-text casts
-- are not immutable and cannot be used in a generated column.
alter table public.work_orders add column cmpri_dashboard_status_rank smallint generated always as (
  case status
    when 'Pending Verification' then 0
    when 'Open' then 1
    when 'In Progress' then 2
    when 'Completed' then 3
    when 'Done' then 3
    when 'Closed' then 4
    when 'Will Not Do' then 5
    else 99
  end
) stored;

-- JavaScript Date.parse, used by the original default sort, compares only
-- milliseconds. Preserve its ID tie-breaker for timestamps within one ms.
alter table public.work_orders add column cmpri_dashboard_created_ms timestamptz
  generated always as (date_trunc('milliseconds', created_at, 'UTC')) stored;

create index cmpri_work_orders_dashboard_default_idx
  on public.work_orders (hotel_id, cmpri_dashboard_status_rank, cmpri_dashboard_created_ms desc nulls last, id);

-- The caller authenticates and applies its work-order read policy first.
-- Do not expose this hotel-wide aggregate to browser clients.
create function public.cmpri_work_order_dashboard_counts(p_hotel uuid, p_today date)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'all', count(*),
    'pending', count(*) filter (where status = 'Pending Verification'),
    'open', count(*) filter (where status in ('Open', 'In Progress', 'Done')),
    'progress', count(*) filter (where status = 'In Progress'),
    'priority', count(*) filter (where status in ('Open', 'In Progress', 'Done') and priority in ('Urgent', 'High')),
    'overdue', count(*) filter (where status in ('Open', 'In Progress', 'Done') and due_by < p_today::timestamptz),
    'completed', count(*) filter (where status = 'Completed'),
    'closed', count(*) filter (where status in ('Closed', 'Will Not Do'))
  ) from public.work_orders where hotel_id = p_hotel;
$$;
revoke all on function public.cmpri_work_order_dashboard_counts(uuid, date) from public, anon, authenticated;
grant execute on function public.cmpri_work_order_dashboard_counts(uuid, date) to service_role;
commit;
