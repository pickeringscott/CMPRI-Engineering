-- A stale application revision is not a retryable serialization failure.
-- PostgREST's transaction runner retries SQLSTATE 40001 with the same inputs.
-- PT409 returns HTTP Conflict immediately, keeping all pool safety checks intact.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
do $migration$
declare
  target regprocedure := 'public.cmpri_pool_action(uuid,uuid,uuid,uuid,text,text,bigint)'::regprocedure;
  definition text;
  old_error text := $old$errcode='40001',message='Pool status changed. Reload before saving.'$old$;
  new_error text := $new$errcode='PT409',message='Pool status changed. Reload before saving.'$new$;
begin
  select pg_get_functiondef(target) into definition;
  if position(old_error in definition) = 0
     or (length(definition) - length(replace(definition, old_error, ''))) / length(old_error) <> 1 then
    raise exception 'Pool revision conflict behavior changed; review before applying';
  end if;
  -- CREATE OR REPLACE retains the function identity, owner and existing grants.
  execute replace(definition, old_error, new_error);
end
$migration$;
commit;
