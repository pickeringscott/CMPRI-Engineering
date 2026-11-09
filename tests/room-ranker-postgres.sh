#!/usr/bin/env bash
# Optional integration test: real PostgreSQL, including concurrent sessions.
# Requires Docker and postgres:17-alpine; never connects to a hosted database.
set -euo pipefail
cd "$(dirname "$0")/.."
name="cmpri-rank-test-$$"
tmpdir="$(mktemp -d)"
trap 'docker rm -f "$name" >/dev/null 2>&1 || true; rm -rf "$tmpdir"' EXIT
docker run -d --name "$name" -e POSTGRES_PASSWORD=disposable-test-only postgres:17-alpine >/dev/null
for _ in {1..60}; do
  if docker exec "$name" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
psql_test() { docker exec -i "$name" psql -X -q -U postgres -v ON_ERROR_STOP=1 "$@"; }
psql_test <<'SQL'
create role anon; create role authenticated; create role service_role;
create schema cmpri_private;
create table locations(id uuid primary key, hotel_id uuid not null, name text not null, location_type text not null, room_number text, active boolean not null default true);
create table work_orders(id uuid primary key default gen_random_uuid(), hotel_id uuid not null, location_id uuid, room text, issue text default '', priority text not null default 'Low', status text not null default 'Open', due_by timestamptz);
create table profiles(id uuid primary key, active boolean not null default true);
create table hotel_members(user_id uuid not null, hotel_id uuid not null, active boolean not null default true);
create table cmpri_dashboard_notifications(id uuid primary key default gen_random_uuid(), hotel_id uuid not null, recipient_user_id uuid not null, notification_key text not null, work_order_id uuid, target_path text, message text not null, recorded_at timestamptz not null default now(), push_requested boolean not null default false, constraint cmpri_dashboard_notifications_recipient_key unique(hotel_id,recipient_user_id,notification_key), constraint cmpri_dashboard_notifications_target check ((work_order_id is not null and target_path is null) or (work_order_id is null and target_path=any(array['/engineering/room-operations','/engineering/pool-log','/pool']))));
insert into locations(id,hotel_id,name,location_type,room_number) values ('00000000-0000-0000-0000-000000000101','00000000-0000-0000-0000-000000000001','Room 101','Guest Room','101'),('00000000-0000-0000-0000-000000000102','00000000-0000-0000-0000-000000000001','Room 102','Guest Room','102');
insert into profiles(id) values ('00000000-0000-0000-0000-000000000201'),('00000000-0000-0000-0000-000000000202');
insert into hotel_members values ('00000000-0000-0000-0000-000000000201','00000000-0000-0000-0000-000000000001',true),('00000000-0000-0000-0000-000000000202','00000000-0000-0000-0000-000000000001',true);
SQL
# Install the two production row-locking functions whose source the migration verifies.
psql_test <<'SQL'
create table public.cmpri_work_order_troubleshooting_visits(id uuid);
SQL
python3 - <<'PYTHON' | psql_test
from pathlib import Path
for path, name in [('supabase/migrations/20261020201414_work_order_mentions.sql','public.cmpri_save_mentioned_work_order'), ('supabase/migrations/20261109072028_work_order_troubleshooting_checklist.sql','public.cmpri_finalize_work_order_troubleshooting')]:
    data=Path(path).read_text(); start=data.index('create function '+name); end=data.index('$$;', start)+3
    print(data[start:end])
PYTHON
psql_test < supabase/migrations/20261109175913_room_ranker_automatic_escalation.sql
psql_test <<'SQL'
insert into work_orders(id,hotel_id,location_id,room,priority,status,due_by) select ('00000000-0000-0000-0000-'||lpad((300+n)::text,12,'0'))::uuid,'00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000101','Room 101','Low','Open','2030-01-01'::timestamptz from generate_series(1,3) n;
do $$ begin
 if (select rank from cmpri_private.room_rank_state where location_id='00000000-0000-0000-0000-000000000101') <> 'B' or (select count(*) from work_orders where priority='Medium')<>3 or (select count(*) from cmpri_dashboard_notifications)<>2 then raise exception 'three Low threshold failed'; end if;
end $$;
insert into work_orders(id,hotel_id,location_id,room,priority,status,due_by) values ('00000000-0000-0000-0000-000000000304','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000101','Room 101','Low','Open','2030-01-01');
do $$ begin
 if (select rank from cmpri_private.room_rank_state where location_id='00000000-0000-0000-0000-000000000101') <> 'C' or (select count(*) from work_orders where priority='Urgent' and ranker_base_priority='Low' and ranker_auto_urgent)<>4 or (select count(*) from cmpri_dashboard_notifications)<>4 then raise exception 'four Low threshold failed'; end if;
end $$;
update work_orders set status='Completed' where id='00000000-0000-0000-0000-000000000304';
do $$ begin
 if (select rank from cmpri_private.room_rank_state where location_id='00000000-0000-0000-0000-000000000101') <> 'B' or (select count(*) from work_orders where due_by='2030-01-01'::timestamptz)<>4 or (select count(*) from cmpri_dashboard_notifications)<>6 then raise exception 'de-escalation/restoration failed'; end if;
end $$;
insert into work_orders(id,hotel_id,location_id,room,priority,status) select ('00000000-0000-0000-0000-'||lpad((310+n)::text,12,'0'))::uuid,'00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000102','Room 102','Low','Open' from generate_series(1,2) n;
SQL
cat > "$tmpdir/a.sql" <<'SQL'
begin;
insert into work_orders(id,hotel_id,location_id,room,priority,status) values ('00000000-0000-0000-0000-000000000313','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000102','Room 102','Low','Open');
select pg_sleep(2);
commit;
SQL
cat > "$tmpdir/b.sql" <<'SQL'
begin;
insert into work_orders(id,hotel_id,location_id,room,priority,status) values ('00000000-0000-0000-0000-000000000314','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000102','Room 102','Low','Open');
commit;
SQL
psql_test < "$tmpdir/a.sql" > "$tmpdir/a.out" 2>&1 & a=$!
sleep 0.3
psql_test < "$tmpdir/b.sql" > "$tmpdir/b.out" 2>&1 & b=$!
wait "$a" || { cat "$tmpdir/a.out"; exit 1; }
wait "$b" || { cat "$tmpdir/b.out"; exit 1; }
psql_test <<'SQL'
do $$ begin
 if (select rank from cmpri_private.room_rank_state where location_id='00000000-0000-0000-0000-000000000102') <> 'C' or (select count(*) from work_orders where location_id='00000000-0000-0000-0000-000000000102' and priority='Urgent')<>4 or (select count(*) from cmpri_dashboard_notifications where message like 'Room 102 rank changed:%')<>4 then raise exception 'concurrent inserts failed'; end if;
end $$;
SQL
cat > "$tmpdir/edit-a.sql" <<'SQL'
begin;
update work_orders set status='Completed' where id='00000000-0000-0000-0000-000000000313';
select pg_sleep(2);
commit;
SQL
cat > "$tmpdir/edit-b.sql" <<'SQL'
begin;
update work_orders set status='Completed' where id='00000000-0000-0000-0000-000000000314';
commit;
SQL
psql_test < "$tmpdir/edit-a.sql" > "$tmpdir/edit-a.out" 2>&1 & a=$!
sleep 0.3
psql_test < "$tmpdir/edit-b.sql" > "$tmpdir/edit-b.out" 2>&1 & b=$!
wait "$a" || { cat "$tmpdir/edit-a.out"; exit 1; }
wait "$b" || { cat "$tmpdir/edit-b.out"; exit 1; }
psql_test <<'SQL'
do $$ begin
 if (select rank from cmpri_private.room_rank_state where location_id='00000000-0000-0000-0000-000000000102') <> 'A'
   or (select count(*) from work_orders where location_id='00000000-0000-0000-0000-000000000102' and status='Completed')<>2
   or (select count(*) from work_orders where location_id='00000000-0000-0000-0000-000000000102' and priority='Low')<>4
   or (select count(*) from cmpri_dashboard_notifications where message like 'Room 102 rank changed:%')<>8 then raise exception 'concurrent edits failed'; end if;
end $$;
SQL
psql_test < tests/room-ranker-urgent-check.sql
psql_test <<'SQL'
insert into work_orders(id,hotel_id,location_id,room,priority,status) select ('00000000-0000-0000-0000-'||lpad((320+n)::text,12,'0'))::uuid,'00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000101','Room 101','Medium','Open' from generate_series(1,3) n;
do $$ begin
 if (select rank from cmpri_private.room_rank_state where location_id='00000000-0000-0000-0000-000000000101') <> 'C' or (select count(*) from work_orders where location_id='00000000-0000-0000-0000-000000000101' and ranker_base_priority='Medium' and priority='Urgent')<>3 then raise exception 'mixed Low and three Medium failed'; end if;
end $$;
update locations set active=false where id='00000000-0000-0000-0000-000000000101';
do $$ begin
 if exists(select from cmpri_private.room_rank_state where location_id='00000000-0000-0000-0000-000000000101') or exists(select from work_orders where location_id='00000000-0000-0000-0000-000000000101' and priority is distinct from ranker_base_priority) then raise exception 'deactivated location restoration failed'; end if;
end $$;
update locations set active=true where id='00000000-0000-0000-0000-000000000101';
do $$ begin
 if (select rank from cmpri_private.room_rank_state where location_id='00000000-0000-0000-0000-000000000101') <> 'C' or (select count(*) from work_orders where location_id='00000000-0000-0000-0000-000000000101' and ranker_base_priority='Medium' and priority='Urgent')<>3 then raise exception 'reactivated location recalculation failed'; end if;
end $$;
SQL
printf 'Room ranker PostgreSQL integration test passed.\n'
