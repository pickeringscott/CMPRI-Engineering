begin;

do $migration$
begin
  if exists (
    select 1
    from public.work_orders
    where source_draft_id is not null
    group by hotel_id, source_draft_id
    having count(*) > 1
  ) then
    raise exception 'Duplicate work orders reference the same source draft; resolve those records before enabling draft approval.';
  end if;
end
$migration$;

create unique index if not exists cmpri_work_orders_source_draft_unique
  on public.work_orders (hotel_id, source_draft_id)
  where source_draft_id is not null;

commit;
