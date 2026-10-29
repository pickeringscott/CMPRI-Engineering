begin;
alter table public.cmpri_room_pm_history add column if not exists item_answers jsonb not null default '{}'::jsonb check(jsonb_typeof(item_answers)='object');
create function public.cmpri_import_room_pm_answers(p_hotel uuid,p_rows jsonb,p_actor uuid) returns integer
language plpgsql security invoker set search_path='' as $$
declare row jsonb; current public.cmpri_room_pm_history; key text; answer jsonb; total integer:=0;
begin
 if jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)>245 then raise exception 'Bounded reviewed batch required';end if;
 for row in select value from jsonb_array_elements(p_rows) loop
  select * into current from public.cmpri_room_pm_history where hotel_id=p_hotel and room=row->>'room' and period_start=(row->>'periodStart')::date for update;
  if not found or current.completed_on is distinct from (row->>'completedOn')::date or current.source_id<>'cmpri-room-pm-2026-scott-reconciled-20261028' then raise exception 'Historical identity/date conflict';end if;
  for key,answer in select * from jsonb_each(row->'answers') loop
   if answer->>'value' not in ('complete','follow-up','na') or (answer->>'sourcePage')::integer not between 43 and 150 or length(answer->>'evidence')<1 then raise exception 'Source-supported item answer required';end if;
   if current.item_answers ? key and current.item_answers->key is distinct from answer then raise exception 'Historical answer conflict';end if;
  end loop;
  if current.item_answers is distinct from current.item_answers||(row->'answers') then
   update public.cmpri_room_pm_history set item_answers=item_answers||(row->'answers') where hotel_id=p_hotel and room=current.room and period_start=current.period_start;
   total:=total+1;
  end if;
 end loop;
 if total>0 then perform public.cmpri_invalidate(p_hotel,'pm','*');end if;
 return total;
end $$;
revoke all on function public.cmpri_import_room_pm_answers(uuid,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.cmpri_import_room_pm_answers(uuid,jsonb,uuid) to service_role;
commit;
