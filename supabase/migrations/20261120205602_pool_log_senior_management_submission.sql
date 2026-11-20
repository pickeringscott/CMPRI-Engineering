-- Match the application’s Senior Management role aliases for new pool readings.
-- Retain the trigger’s existing correction rules and leave reopening unchanged.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $migration$
declare
  definition text := pg_get_functiondef('public.cmpri_stamp_pool_log()'::regprocedure);
  old_guard text := $old$    'assistantgeneralmanager', 'assistantgm'
  ) THEN
    RAISE EXCEPTION 'An active CMPRI engineering account is required';$old$;
  new_guard text := $new$    'assistantgeneralmanager', 'assistantgm', 'seniormanagement', 'uppermanagement',
    'vpfacilities', 'regionaldirectoroperations', 'districtmanager'
  ) THEN
    RAISE EXCEPTION 'An active CMPRI engineering account is required';$new$;
begin
  if position(old_guard in definition) = 0
     or (length(definition) - length(replace(definition, old_guard, ''))) / length(old_guard) <> 1 then
    raise exception 'Pool log submission role guard changed; review before applying';
  end if;
  execute replace(definition, old_guard, new_guard);
end
$migration$;

commit;
