-- CMPRI production schema baseline (public schema), dumped from the live Supabase
-- project on 2026-09-30 with `supabase db dump --linked`. It replaces the earlier
-- migrations, which are kept for reference in supabase/migrations_archive/.
-- Add new schema changes as new migrations after this file.



SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE TYPE "public"."hotel_role" AS ENUM (
    'admin',
    'manager',
    'technician',
    'viewer'
);


ALTER TYPE "public"."hotel_role" OWNER TO "postgres";


CREATE TYPE "public"."work_order_status" AS ENUM (
    'Open',
    'In Progress',
    'Completed',
    'Done',
    'Pending Verification',
    'Closed',
    'Will Not Do'
);


ALTER TYPE "public"."work_order_status" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."can_manage_hotel"("target_hotel_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1 from public.hotel_members
    where hotel_id = target_hotel_id
      and user_id = auth.uid()
      and active = true
      and role in ('admin', 'manager')
  );
$$;


ALTER FUNCTION "public"."can_manage_hotel"("target_hotel_id" "uuid") OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."cmpri_enseo_assignments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hotel_id" "uuid" NOT NULL,
    "asset_id" "uuid" NOT NULL,
    "device_type" "text" NOT NULL,
    "location_id" "uuid" NOT NULL,
    "room_number" "text",
    "sub_location" "text" NOT NULL,
    "endpoint_code" "text",
    "paired_asset_id" "uuid",
    "active" boolean DEFAULT true NOT NULL,
    "revision" bigint DEFAULT 1 NOT NULL,
    "created_by" "uuid",
    "updated_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "sublocation" "text",
    "device_id" "text",
    CONSTRAINT "cmpri_enseo_assignments_check" CHECK ((("paired_asset_id" IS NULL) OR ("paired_asset_id" <> "asset_id"))),
    CONSTRAINT "cmpri_enseo_assignments_check1" CHECK ((("device_type" = 'STB'::"text") OR ("endpoint_code" IS NULL))),
    CONSTRAINT "cmpri_enseo_assignments_device_type_check" CHECK (("device_type" = ANY (ARRAY['TV'::"text", 'STB'::"text"]))),
    CONSTRAINT "cmpri_enseo_assignments_sub_location_check" CHECK ((("char_length"("btrim"("sub_location")) >= 1) AND ("char_length"("btrim"("sub_location")) <= 120)))
);


ALTER TABLE "public"."cmpri_enseo_assignments" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cmpri_apply_enseo_moves"("p_hotel_id" "uuid", "p_actor_user_id" "uuid", "p_moves" "jsonb", "p_reason" "text" DEFAULT NULL::"text") RETURNS SETOF "public"."cmpri_enseo_assignments"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
                                                                                                                                                        declare
                                                                                                                                                          v_actor_role text; v_batch_id uuid:=gen_random_uuid(); v_move jsonb; v_asset_id uuid; v_device_type text; v_location_id uuid; v_room_number text; v_sub_location text; v_endpoint_code text; v_paired_asset_id uuid; v_existing public.cmpri_enseo_assignments%rowtype; v_assignment public.cmpri_enseo_assignments%rowtype; v_count integer;
                                                                                                                                                          begin
                                                                                                                                                            if p_hotel_id is null or p_actor_user_id is null then raise exception 'Hotel and actor are required'; end if;
                                                                                                                                                              if p_moves is null or jsonb_typeof(p_moves)<>'array' then raise exception 'Moves must be a JSON array'; end if;
                                                                                                                                                                v_count:=jsonb_array_length(p_moves); if v_count<1 or v_count>20 then raise exception 'A move batch must contain 1 to 20 devices'; end if;
                                                                                                                                                                  select regexp_replace(lower(coalesce(p.role,'')),'[^a-z0-9]','','g') into v_actor_role from public.profiles p join public.hotel_members hm on hm.user_id=p.id where p.id=p_actor_user_id and p.active=true and hm.hotel_id=p_hotel_id and hm.active=true limit 1;
                                                                                                                                                                    if v_actor_role is null or v_actor_role not in ('chiefengineer','engineeringmanager','maintenancetechnician','technician','engineer','engineering','regionalmaintenance','regionalengineer','systemadmin','systemadministrator','administrator','admin') then raise exception 'CMPRI equipment-management permission is required'; end if;
                                                                                                                                                                      if exists (select 1 from (select value->>'asset_id' as asset_id,count(*) as n from jsonb_array_elements(p_moves) group by value->>'asset_id' having count(*)>1) duplicates) then raise exception 'The same device cannot appear twice in one move batch'; end if;
                                                                                                                                                                        perform 1 from public.cmpri_enseo_assignments a where a.hotel_id=p_hotel_id and a.asset_id in (select (value->>'asset_id')::uuid from jsonb_array_elements(p_moves)) order by a.asset_id for update;
                                                                                                                                                                          for v_move in select value from jsonb_array_elements(p_moves) loop
                                                                                                                                                                              begin v_asset_id:=nullif(v_move->>'asset_id','')::uuid; v_location_id:=nullif(v_move->>'location_id','')::uuid; v_paired_asset_id:=nullif(v_move->>'paired_asset_id','')::uuid; exception when invalid_text_representation then raise exception 'Move contains an invalid id'; end;
                                                                                                                                                                                  v_device_type:=upper(btrim(coalesce(v_move->>'device_type',''))); v_room_number:=nullif(btrim(coalesce(v_move->>'room_number','')),''); v_sub_location:=btrim(coalesce(v_move->>'sub_location','')); v_endpoint_code:=nullif(upper(btrim(coalesce(v_move->>'endpoint_code',''))),'');
                                                                                                                                                                                      if v_asset_id is null or v_location_id is null then raise exception 'Each move requires an asset and destination location'; end if;
                                                                                                                                                                                          if v_device_type not in ('TV','STB') then raise exception 'Device type must be TV or STB'; end if;
                                                                                                                                                                                              if char_length(v_sub_location)<1 or char_length(v_sub_location)>120 then raise exception 'Each move requires a room sub-location'; end if;
                                                                                                                                                                                                  if v_device_type='TV' then v_endpoint_code:=null; end if;
                                                                                                                                                                                                      if not exists(select 1 from public.assets a where a.id=v_asset_id and a.hotel_id=p_hotel_id and coalesce(a.active,true)=true) then raise exception 'Every moved device must be an active CMPRI asset'; end if;
                                                                                                                                                                                                          if not exists(select 1 from public.locations l where l.id=v_location_id and l.hotel_id=p_hotel_id and coalesce(l.active,true)=true) then raise exception 'Every destination must be an active CMPRI location'; end if;
                                                                                                                                                                                                              if v_paired_asset_id is not null then if v_paired_asset_id=v_asset_id then raise exception 'A device cannot be paired to itself'; end if; if not exists(select 1 from public.assets a where a.id=v_paired_asset_id and a.hotel_id=p_hotel_id and coalesce(a.active,true)=true) then raise exception 'Paired device must be an active CMPRI asset'; end if; end if;
                                                                                                                                                                                                                  select * into v_existing from public.cmpri_enseo_assignments where hotel_id=p_hotel_id and asset_id=v_asset_id;
                                                                                                                                                                                                                      if found then
                                                                                                                                                                                                                            update public.cmpri_enseo_assignments set device_type=v_device_type,location_id=v_location_id,room_number=v_room_number,sub_location=v_sub_location,endpoint_code=v_endpoint_code,paired_asset_id=v_paired_asset_id,active=true,revision=revision+1,updated_by=p_actor_user_id,updated_at=now() where id=v_existing.id returning * into v_assignment;
                                                                                                                                                                                                                                else
                                                                                                                                                                                                                                      insert into public.cmpri_enseo_assignments(hotel_id,asset_id,device_type,location_id,room_number,sub_location,endpoint_code,paired_asset_id,active,revision,created_by,updated_by) values(p_hotel_id,v_asset_id,v_device_type,v_location_id,v_room_number,v_sub_location,v_endpoint_code,v_paired_asset_id,true,1,p_actor_user_id,p_actor_user_id) returning * into v_assignment;
                                                                                                                                                                                                                                          end if;
                                                                                                                                                                                                                                              insert into public.cmpri_enseo_assignment_history(batch_id,hotel_id,assignment_id,asset_id,actor_user_id,reason,from_location_id,from_room_number,from_sub_location,from_endpoint_code,from_paired_asset_id,to_location_id,to_room_number,to_sub_location,to_endpoint_code,to_paired_asset_id) values(v_batch_id,p_hotel_id,v_assignment.id,v_asset_id,p_actor_user_id,nullif(btrim(coalesce(p_reason,'')),''),v_existing.location_id,v_existing.room_number,v_existing.sub_location,v_existing.endpoint_code,v_existing.paired_asset_id,v_assignment.location_id,v_assignment.room_number,v_assignment.sub_location,v_assignment.endpoint_code,v_assignment.paired_asset_id);
                                                                                                                                                                                                                                                end loop;
                                                                                                                                                                                                                                                  return query select a.* from public.cmpri_enseo_assignments a where a.hotel_id=p_hotel_id and a.asset_id in (select (value->>'asset_id')::uuid from jsonb_array_elements(p_moves)) order by a.room_number nulls last,a.sub_location,a.device_type,a.asset_id;
                                                                                                                                                                                                                                                  end;
                                                                                                                                                                                                                                                  $$;


ALTER FUNCTION "public"."cmpri_apply_enseo_moves"("p_hotel_id" "uuid", "p_actor_user_id" "uuid", "p_moves" "jsonb", "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cmpri_assign_work_order_display_id"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $_$
declare
  local_day text;
  prefix text;
  next_number bigint;
begin
  if nullif(btrim(coalesce(new.display_id, '')), '') is not null then
    return new;
  end if;

  local_day := to_char((now() at time zone 'America/Chicago'), 'YYMMDD');
  prefix := 'workorder_' || local_day;

  perform pg_advisory_xact_lock(
    hashtext('cmpri-work-order-display-id:' || new.hotel_id::text || ':' || local_day)
  );

  select coalesce(max(substring(w.display_id from '[0-9]{3}$')::bigint), 0) + 1
    into next_number
  from public.work_orders w
  where w.hotel_id = new.hotel_id
    and w.display_id ~ ('^' || prefix || '[0-9]{3}$');

  if next_number > 999 then
    raise exception 'Daily CMPRI work-order number limit reached';
  end if;

  new.display_id := prefix || lpad(next_number::text, 3, '0');
  return new;
end;
$_$;


ALTER FUNCTION "public"."cmpri_assign_work_order_display_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cmpri_audit_pool_log"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin insert into public.cmpri_pool_log_history(pool_log_id,hotel_id,actor_id,snapshot) values(new.id,new.hotel_id,new.updated_by,to_jsonb(new)); return new; end;
$$;


ALTER FUNCTION "public"."cmpri_audit_pool_log"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cmpri_bump_work_order_revision"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
begin
  if TG_OP = 'INSERT' then
    new.revision := 1;
  else
    -- Ignore caller-supplied revisions; every writer advances the same counter.
    new.revision := old.revision + 1;
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."cmpri_bump_work_order_revision"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cmpri_check_work_order_submitter"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $_$
declare
  caller_id uuid := auth.uid();
  caller public.profiles%rowtype;
  staff_name text;
begin
  -- Scheduled service imports retain their separate provenance workflow.
  if caller_id is null then
    if auth.role() = 'service_role' then return new; end if;
    raise exception 'An authenticated active account is required';
  end if;
  select * into caller from public.profiles where id = caller_id;
  if not found or caller.active is distinct from true then
    raise exception 'An active account is required';
  end if;
  new.created_by := caller_id;
  new.creator_account_user_id := caller_id;
  if regexp_replace(lower(coalesce(caller.role, '')), '[[:space:]_-]', '', 'g') = 'frontdesk' then
    staff_name := btrim(coalesce(new.submitted_by_name, ''));
    if length(staff_name) < 1 or length(staff_name) > 80 or staff_name !~ '^[[:alpha:]][[:alpha:] ''’-]*$' then
      raise exception 'Enter your first name before submitting';
    end if;
    new.submitted_by_name := staff_name;
    new.creator_name := staff_name;
    new.creator_source := 'front_desk_pending_verification';
    new.status := 'Pending Verification';
  else
    new.submitted_by_name := null;
    new.creator_name := coalesce(nullif(btrim(caller.full_name), ''), 'Unknown User');
    new.creator_source := 'signed_in_user';
  end if;
  return new;
end;
$_$;


ALTER FUNCTION "public"."cmpri_check_work_order_submitter"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cmpri_pm_proposal_stamp"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  NEW.updated_at := now();
  IF TG_OP = 'UPDATE' THEN
    NEW.created_at := OLD.created_at;
    NEW.revision := OLD.revision + 1;
  ELSE
    NEW.created_at := coalesce(NEW.created_at, now());
    NEW.revision := 1;
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."cmpri_pm_proposal_stamp"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cmpri_remember_work_order_technician"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
begin
  if nullif(btrim(coalesce(new.technician_name, '')), '') is not null then
    new.last_assigned_technician_name := btrim(new.technician_name);
  elsif TG_OP = 'UPDATE' then
    if nullif(btrim(coalesce(old.technician_name, '')), '') is not null then
      new.last_assigned_technician_name := btrim(old.technician_name);
    else
      new.last_assigned_technician_name := old.last_assigned_technician_name;
    end if;
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."cmpri_remember_work_order_technician"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cmpri_replace_room_operations"("p_hotel_id" "uuid", "p_report_date" "date", "p_actor_id" "uuid", "p_actor_name" "text", "p_source_type" "text", "p_rows" "jsonb") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_import_id uuid := gen_random_uuid();
begin
  if p_hotel_id is null then
    raise exception 'hotel id is required';
  end if;

  if p_report_date is null then
    raise exception 'report date is required';
  end if;

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'room rows must be a JSON array';
  end if;

  if not exists (
    select 1
    from public.hotels h
    where h.id = p_hotel_id
  ) then
    raise exception 'hotel does not exist';
  end if;

  -- room_operations has one current row per hotel/room, so a new import
  -- replaces the current hotel snapshot atomically.
  delete from public.room_operations
  where hotel_id = p_hotel_id;

  insert into public.room_operations (
    hotel_id,
    room,
    reserved,
    room_status,
    departure_date,
    checkout_time,
    default_checkout_time,
    deadline,
    arrival_date,
    checkin_time,
    default_checkin_time,
    guest_name,
    guest_arrival_date,
    stay_nights,
    report_date,
    moved_from_room,
    moved_rooms,
    room_type,
    guest_code,
    updated_at
  )
  select
    p_hotel_id,
    nullif(btrim(j->>'room'), ''),
    coalesce((j->>'reserved')::boolean, false),
    coalesce(j->>'room_status', ''),
    nullif(j->>'checkout_date', '')::date,
    nullif(j->>'checkout_time', '')::time,
    nullif(j->>'checkout_time', '') is null,
    null,
    nullif(j->>'arrival_date', '')::date,
    nullif(j->>'arrival_time', '')::time,
    nullif(j->>'arrival_time', '') is null,
    coalesce(j->>'guest_name', ''),
    nullif(j->>'guest_arrival_date', '')::date,
    greatest(0, coalesce((j->>'stay_nights')::integer, 0)),
    p_report_date,
    coalesce(j->>'move_from', ''),
    (
      coalesce(nullif(j->>'move_from', ''), nullif(j->>'move_to', ''))
      is not null
    ),
    coalesce(j->>'room_type', ''),
    coalesce(j->>'guest_code', ''),
    now()
  from jsonb_array_elements(p_rows) as item(j);

  return v_import_id;
end;
$$;


ALTER FUNCTION "public"."cmpri_replace_room_operations"("p_hotel_id" "uuid", "p_report_date" "date", "p_actor_id" "uuid", "p_actor_name" "text", "p_source_type" "text", "p_rows" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cmpri_resolve_technician_view_notifications"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
                              BEGIN
                                IF OLD.status IS DISTINCT FROM NEW.status THEN
                                    UPDATE public.cmpri_work_order_technician_views
                                        SET resolved_at = now()
                                            WHERE hotel_id = NEW.hotel_id
                                                  AND work_order_id = NEW.id
                                                        AND resolved_at IS NULL;
                                                          END IF;
                                                            RETURN NEW;
                                                            END;
                                                            $$;


ALTER FUNCTION "public"."cmpri_resolve_technician_view_notifications"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cmpri_stamp_pool_log"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  actor uuid := coalesce(auth.uid(), new.updated_by);
  actor_role text;
  is_system_admin boolean;
BEGIN
  SELECT regexp_replace(lower(p.role),'[[:space:]_-]','','g') INTO actor_role
  FROM public.profiles p
  JOIN public.hotel_members m ON m.user_id=p.id
  WHERE p.id=actor AND p.active=true AND m.active=true AND m.hotel_id=new.hotel_id;

  IF actor_role IS NULL OR actor_role NOT IN
    ('admin','administrator','systemadmin','systemadministrator','chiefengineer',
     'engineer','engineering','technician','maintenancetechnician','regionalmaintenance',
     'frontdeskmanager',
     'generalmanager','gm','assistantmanager','assistantgeneralmanager','assistantgm') THEN
    RAISE EXCEPTION 'An active CMPRI engineering account is required';
  END IF;
  is_system_admin := actor_role IN ('admin','administrator','systemadmin','systemadministrator');

  -- Saved readings may be added to (for example the PM sample), but only a
  -- System Administrator may change or remove a value that is already saved.
  IF TG_OP = 'UPDATE' AND NOT is_system_admin THEN
    IF (old.ph_am IS NOT NULL AND new.ph_am IS DISTINCT FROM old.ph_am)
      OR (old.sanitizer_am IS NOT NULL AND new.sanitizer_am IS DISTINCT FROM old.sanitizer_am)
      OR (old.sanitizer_band_am IS NOT NULL AND new.sanitizer_band_am IS DISTINCT FROM old.sanitizer_band_am)
      OR (old.sample_location_am IS NOT NULL AND new.sample_location_am IS DISTINCT FROM old.sample_location_am)
      OR (old.ph_pm IS NOT NULL AND new.ph_pm IS DISTINCT FROM old.ph_pm)
      OR (old.sanitizer_pm IS NOT NULL AND new.sanitizer_pm IS DISTINCT FROM old.sanitizer_pm)
      OR (old.sanitizer_band_pm IS NOT NULL AND new.sanitizer_band_pm IS DISTINCT FROM old.sanitizer_band_pm)
      OR (old.sample_location_pm IS NOT NULL AND new.sample_location_pm IS DISTINCT FROM old.sample_location_pm)
      OR (old.flow_rate_gpm IS NOT NULL AND new.flow_rate_gpm IS DISTINCT FROM old.flow_rate_gpm)
      OR (old.temperature_f IS NOT NULL AND new.temperature_f IS DISTINCT FROM old.temperature_f)
      OR (old.main_drain_visible IS NOT NULL AND new.main_drain_visible IS DISTINCT FROM old.main_drain_visible)
      OR (old.filter_backwashed IS NOT NULL AND new.filter_backwashed IS DISTINCT FROM old.filter_backwashed)
      OR (old.closure_condition IS TRUE AND new.closure_condition IS DISTINCT FROM true)
      OR (old.requires_attention IS TRUE AND new.requires_attention IS DISTINCT FROM true)
      OR (nullif(old.closure_reason, '') IS NOT NULL AND left(coalesce(new.closure_reason, ''), length(old.closure_reason)) <> old.closure_reason)
      OR (nullif(old.remarks, '') IS NOT NULL AND left(coalesce(new.remarks, ''), length(old.remarks)) <> old.remarks) THEN
      RAISE EXCEPTION 'Only System Administrators can change saved pool readings';
    END IF;
  END IF;

  IF (new.ph_am IS NULL) <> (new.sanitizer_am IS NULL AND new.sanitizer_band_am IS NULL)
    OR (new.ph_pm IS NULL) <> (new.sanitizer_pm IS NULL AND new.sanitizer_band_pm IS NULL) THEN
    RAISE EXCEPTION 'Each AM/PM sample requires both pH and bromine';
  END IF;
  IF (new.sanitizer_am IS NOT NULL AND new.sanitizer_band_am IS NOT NULL)
    OR (new.sanitizer_pm IS NOT NULL AND new.sanitizer_band_pm IS NOT NULL) THEN
    RAISE EXCEPTION 'Use either a numeric bromine reading or a selected range, not both';
  END IF;
  IF (new.ph_am IS NOT NULL AND new.sample_location_am IS NULL)
    OR (new.ph_pm IS NOT NULL AND new.sample_location_pm IS NULL) THEN
    RAISE EXCEPTION 'Each sample requires a shallow or deep sample location';
  END IF;
  IF (new.sample_location_am = 'middle' AND (TG_OP = 'INSERT' OR old.sample_location_am IS DISTINCT FROM 'middle'))
    OR (new.sample_location_pm = 'middle' AND (TG_OP = 'INSERT' OR old.sample_location_pm IS DISTINCT FROM 'middle')) THEN
    RAISE EXCEPTION 'Sample location must be shallow or deep';
  END IF;
  IF new.main_drain_visible IS NULL OR new.filter_backwashed IS NULL
    OR new.temperature_f IS NULL OR new.flow_rate_gpm IS NULL THEN
    RAISE EXCEPTION 'Daily checks are required: water temperature, flow rate, main drain visibility and filter backwash status';
  END IF;
  IF new.ph_am IS NULL THEN new.sample_location_am := NULL; END IF;
  IF new.ph_pm IS NULL THEN new.sample_location_pm := NULL; END IF;

  -- One physical sample per test: the same reading is recorded for shallow and deep.
  new.ph_shallow_am := new.ph_am;
  new.ph_deep_am := new.ph_am;
  new.sanitizer_shallow_am := new.sanitizer_am;
  new.sanitizer_deep_am := new.sanitizer_am;
  new.ph_shallow_pm := new.ph_pm;
  new.ph_deep_pm := new.ph_pm;
  new.sanitizer_shallow_pm := new.sanitizer_pm;
  new.sanitizer_deep_pm := new.sanitizer_pm;
  new.ph_middle_am := CASE WHEN new.sample_location_am = 'middle' THEN new.ph_am ELSE NULL END;
  new.sanitizer_middle_am := CASE WHEN new.sample_location_am = 'middle' THEN new.sanitizer_am ELSE NULL END;
  new.ph_middle_pm := CASE WHEN new.sample_location_pm = 'middle' THEN new.ph_pm ELSE NULL END;
  new.sanitizer_middle_pm := CASE WHEN new.sample_location_pm = 'middle' THEN new.sanitizer_pm ELSE NULL END;

  IF new.ph_am < 7.2 OR new.ph_am > 7.8
    OR new.ph_pm < 7.2 OR new.ph_pm > 7.8
    OR new.sanitizer_band_am IN ('0', '1-2', '7.5-15', '10-20')
    OR new.sanitizer_band_pm IN ('0', '1-2', '7.5-15', '10-20')
    OR new.sanitizer_am <= 2 OR new.sanitizer_am >= 7.5
    OR new.sanitizer_pm <= 2 OR new.sanitizer_pm >= 7.5
    OR new.main_drain_visible IS FALSE
    OR new.temperature_f > 104 THEN
    new.closure_condition := true;
  END IF;

  new.closure_reason := nullif(btrim(new.closure_reason), '');
  IF new.closure_condition IS TRUE AND new.closure_reason IS NULL THEN
    RAISE EXCEPTION 'The pool must be closed: a reason is required whenever the pool is closed';
  END IF;

  new.updated_by := actor;
  new.updated_at := now();
  IF TG_OP = 'INSERT' THEN
    new.revision := 1;
    new.created_by := coalesce(auth.uid(), new.created_by);
  ELSE
    new.revision := old.revision + 1;
    new.created_by := old.created_by;
  END IF;
  RETURN new;
END;
$$;


ALTER FUNCTION "public"."cmpri_stamp_pool_log"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_hotel_member"("target_hotel_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1 from public.hotel_members
    where hotel_id = target_hotel_id
      and user_id = auth.uid()
      and active = true
  );
$$;


ALTER FUNCTION "public"."is_hotel_member"("target_hotel_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."protect_work_order_creator"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if new.creator_name is distinct from old.creator_name
     or new.creator_initials is distinct from old.creator_initials
     or new.creator_source is distinct from old.creator_source
     or new.creator_account_user_id is distinct from old.creator_account_user_id then
    if not public.can_manage_hotel(old.hotel_id) then
      raise exception 'Only a hotel administrator or manager can change the ticket creator.';
    end if;
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."protect_work_order_creator"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."purge_cmpri_user"("target_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
BEGIN
  IF target_id IS NULL THEN RETURN; END IF;
    DELETE FROM public.work_order_creator_audit WHERE corrected_by = target_id;
      DELETE FROM public.cmpri_work_order_drafts WHERE created_by = target_id;
        DELETE FROM public.work_orders WHERE created_by = target_id OR submitted_by_user_id = target_id;
          UPDATE public.work_orders SET creator_account_user_id = NULL WHERE creator_account_user_id = target_id;
            DELETE FROM public.pool_daily_logs WHERE created_by = target_id;
              UPDATE public.pool_daily_logs SET updated_by = NULL WHERE updated_by = target_id;
                DELETE FROM public.cmpri_enseo_assignments WHERE created_by = target_id;
                  UPDATE public.cmpri_enseo_assignments SET updated_by = NULL WHERE updated_by = target_id;
                    DELETE FROM public.hotel_members WHERE user_id = target_id;
                      DELETE FROM public.profiles WHERE id = target_id;
                      END;
                      $$;


ALTER FUNCTION "public"."purge_cmpri_user"("target_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


ALTER FUNCTION "public"."set_updated_at"() OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."asset_inventory_compatibility" (
    "asset_id" "uuid" NOT NULL,
    "inventory_item_id" "uuid" NOT NULL,
    "notes" "text" DEFAULT ''::"text" NOT NULL
);


ALTER TABLE "public"."asset_inventory_compatibility" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."assets" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hotel_id" "uuid" NOT NULL,
    "location_id" "uuid",
    "legacy_asset_id" "text",
    "asset_type" "text" NOT NULL,
    "name" "text" NOT NULL,
    "manufacturer" "text" DEFAULT ''::"text" NOT NULL,
    "model" "text" DEFAULT ''::"text" NOT NULL,
    "serial_number" "text" DEFAULT ''::"text" NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "notes" "text" DEFAULT ''::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "asset_tag" "text",
    "status" "text" DEFAULT 'Active'::"text" NOT NULL,
    "installed_on" "date",
    "purchase_cost" numeric(12,2),
    "replacement_cost" numeric(12,2),
    "warranty_expires_on" "date",
    "model_number" "text",
    "generation" "text",
    "install_year" integer,
    "documentation_key" "text",
    "binder_import_id" "text",
    "binder_category" "text",
    "binder_location" "text",
    "location_class" "text",
    "room_type" "text",
    "quantity" numeric,
    "binder_tag" "text",
    "mapping_method" "text",
    "source_page" "text",
    "source_file" "text",
    "import_status" "text",
    "review_note" "text",
    "binder_source_locked" boolean DEFAULT false NOT NULL,
    CONSTRAINT "assets_status_check" CHECK (("status" = ANY (ARRAY['Active'::"text", 'Out Of Service'::"text", 'Replaced'::"text", 'Retired'::"text"])))
);


ALTER TABLE "public"."assets" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."cmpri_asset_inventory_compatibility" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hotel_id" "uuid" NOT NULL,
    "asset_id" "uuid",
    "inventory_item_id" "uuid",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "uuid"
);


ALTER TABLE "public"."cmpri_asset_inventory_compatibility" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."cmpri_email_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hotel_id" "uuid" NOT NULL,
    "gmail_message_id" "text" NOT NULL,
    "gmail_thread_id" "text",
    "direction" "text" DEFAULT 'inbound'::"text" NOT NULL,
    "category" "text" NOT NULL,
    "confidence" numeric(4,3),
    "subject" "text",
    "from_address" "text",
    "to_address" "text",
    "message_at" timestamp with time zone,
    "parsed" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "body_text" "text",
    "processed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."cmpri_email_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."cmpri_enseo_assignment_history" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "batch_id" "uuid" NOT NULL,
    "hotel_id" "uuid" NOT NULL,
    "assignment_id" "uuid" NOT NULL,
    "asset_id" "uuid" NOT NULL,
    "actor_user_id" "uuid",
    "reason" "text",
    "from_location_id" "uuid",
    "from_room_number" "text",
    "from_sub_location" "text",
    "from_endpoint_code" "text",
    "from_paired_asset_id" "uuid",
    "to_location_id" "uuid" NOT NULL,
    "to_room_number" "text",
    "to_sub_location" "text" NOT NULL,
    "to_endpoint_code" "text",
    "to_paired_asset_id" "uuid",
    "moved_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "actor_id" "uuid",
    "action" "text" DEFAULT 'move'::"text" NOT NULL,
    "old_value" "jsonb",
    "new_value" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."cmpri_enseo_assignment_history" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."cmpri_enseo_tickets" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hotel_id" "uuid" NOT NULL,
    "external_key" "text" NOT NULL,
    "ticket_number" "text",
    "room_number" "text",
    "enseo_endpoint" "text",
    "status" "text",
    "work_order_id" "uuid",
    "subject" "text",
    "last_email_event_id" "uuid",
    "last_update_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."cmpri_enseo_tickets" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."cmpri_gss_reports" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hotel_id" "uuid" NOT NULL,
    "report_week" "date" NOT NULL,
    "subject" "text",
    "scores" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "source_email_event_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."cmpri_gss_reports" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."cmpri_inventory_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hotel_id" "uuid" NOT NULL,
    "sku" "text",
    "name" "text" DEFAULT ''::"text" NOT NULL,
    "category" "text",
    "unit_cost" numeric(12,2),
    "stock_on_hand" integer DEFAULT 0,
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "quantity" integer DEFAULT 0 NOT NULL,
    "min_quantity" integer DEFAULT 0 NOT NULL,
    "location" "text" DEFAULT ''::"text" NOT NULL,
    "vendor_id" "uuid",
    "preferred_vendor_id" "uuid",
    "item_name" "text" DEFAULT ''::"text" NOT NULL,
    "description" "text" DEFAULT ''::"text" NOT NULL,
    "manufacturer" "text" DEFAULT ''::"text" NOT NULL,
    "vendor_sku" "text" DEFAULT ''::"text" NOT NULL,
    "product_url" "text" DEFAULT ''::"text" NOT NULL,
    "package_quantity" numeric(12,3) DEFAULT 1 NOT NULL,
    "unit_of_measure" "text" DEFAULT 'Each'::"text" NOT NULL,
    "quantity_on_hand" numeric(12,3) DEFAULT 0 NOT NULL,
    "quantity_reserved" numeric(12,3) DEFAULT 0 NOT NULL,
    "reorder_level" numeric(12,3),
    "suggested_order_quantity" numeric(12,3),
    "storage_location" "text" DEFAULT ''::"text" NOT NULL,
    "current_unit_cost" numeric(12,2),
    "created_by" "uuid"
);


ALTER TABLE "public"."cmpri_inventory_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."cmpri_inventory_movements" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hotel_id" "uuid" NOT NULL,
    "inventory_item_id" "uuid" NOT NULL,
    "movement_type" "text" NOT NULL,
    "quantity_change" numeric(12,3) NOT NULL,
    "work_order_item_id" "uuid",
    "unit_cost" numeric(12,2),
    "performed_by_user_id" "uuid",
    "performed_by_name" "text" DEFAULT ''::"text" NOT NULL,
    "performed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "notes" "text" DEFAULT ''::"text" NOT NULL,
    "quantity" integer DEFAULT 0 NOT NULL,
    "direction" "text" DEFAULT 'in'::"text" NOT NULL,
    "reason" "text",
    "work_order_id" "uuid",
    "actor_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "cmpri_inventory_movements_movement_type_check" CHECK (("movement_type" = ANY (ARRAY['Receipt'::"text", 'Use'::"text", 'Reservation'::"text", 'Release'::"text", 'Return'::"text", 'Adjustment'::"text"]))),
    CONSTRAINT "cmpri_inventory_movements_quantity_change_check" CHECK (("quantity_change" <> (0)::numeric)),
    CONSTRAINT "cmpri_inventory_movements_unit_cost_check" CHECK ((("unit_cost" IS NULL) OR ("unit_cost" >= (0)::numeric)))
);


ALTER TABLE "public"."cmpri_inventory_movements" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."cmpri_mcp_oauth_clients" (
    "client_id" "text" NOT NULL,
    "client_name" "text" NOT NULL,
    "redirect_uris" "jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "cmpri_mcp_oauth_clients_redirect_uris_array" CHECK (("jsonb_typeof"("redirect_uris") = 'array'::"text"))
);


ALTER TABLE "public"."cmpri_mcp_oauth_clients" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."cmpri_mcp_oauth_codes" (
    "code_hash" "text" NOT NULL,
    "client_id" "text" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "redirect_uri" "text" NOT NULL,
    "resource" "text" NOT NULL,
    "code_challenge" "text" NOT NULL,
    "scope" "text" NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "used_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."cmpri_mcp_oauth_codes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."cmpri_mcp_oauth_tokens" (
    "token_hash" "text" NOT NULL,
    "token_family_id" "uuid" NOT NULL,
    "client_id" "text" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "resource" "text" NOT NULL,
    "token_type" "text" NOT NULL,
    "scope" "text" NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "revoked_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "cmpri_mcp_oauth_tokens_token_type_check" CHECK (("token_type" = ANY (ARRAY['access_token'::"text", 'refresh_token'::"text"])))
);


ALTER TABLE "public"."cmpri_mcp_oauth_tokens" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."cmpri_order_ideas" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hotel_id" "uuid" NOT NULL,
    "item_name" "text" DEFAULT ''::"text" NOT NULL,
    "qty" integer DEFAULT 1,
    "priority" "text",
    "rationale" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "name" "text" DEFAULT ''::"text" NOT NULL,
    "inventory_item_id" "uuid",
    "asset_id" "uuid",
    "item_text" "text" DEFAULT ''::"text" NOT NULL,
    "quantity" numeric(12,3),
    "status" "text" DEFAULT 'Idea'::"text" NOT NULL,
    "source" "text" DEFAULT 'manual'::"text" NOT NULL,
    "notes" "text" DEFAULT ''::"text" NOT NULL,
    "created_by_user_id" "uuid",
    "created_by_name" "text" DEFAULT ''::"text" NOT NULL
);


ALTER TABLE "public"."cmpri_order_ideas" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."cmpri_personal_mcp_links" (
    "token_hash" "text" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "resource" "text" NOT NULL,
    "scope" "text" NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "revoked_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "cmpri_personal_mcp_links_scope_check" CHECK (("scope" = ANY (ARRAY['cmpri:read'::"text", 'cmpri:read cmpri:write'::"text"])))
);


ALTER TABLE "public"."cmpri_personal_mcp_links" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."cmpri_pm_proposals" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hotel_id" "uuid" NOT NULL,
    "template_id" "text" NOT NULL,
    "period_start" "date" NOT NULL,
    "scope_key" "text" NOT NULL,
    "payload" "jsonb" NOT NULL,
    "proposed_cells" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "submitted_by" "uuid",
    "submitted_by_name" "text",
    "reviewed_by" "uuid",
    "reviewed_at" timestamp with time zone,
    "review_note" "text",
    "revision" bigint DEFAULT 1 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "cmpri_pm_proposals_cells_size" CHECK (("pg_column_size"("proposed_cells") <= 131072)),
    CONSTRAINT "cmpri_pm_proposals_payload_size" CHECK (("pg_column_size"("payload") <= 262144)),
    CONSTRAINT "cmpri_pm_proposals_review_note_length" CHECK (("char_length"(COALESCE("review_note", ''::"text")) <= 2000)),
    CONSTRAINT "cmpri_pm_proposals_revision_check" CHECK (("revision" > 0)),
    CONSTRAINT "cmpri_pm_proposals_scope_key_length" CHECK ((("char_length"("scope_key") >= 1) AND ("char_length"("scope_key") <= 120))),
    CONSTRAINT "cmpri_pm_proposals_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'processing'::"text", 'approved'::"text", 'rejected'::"text"])))
);


ALTER TABLE "public"."cmpri_pm_proposals" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."cmpri_pool_log_history" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "pool_log_id" "uuid" NOT NULL,
    "hotel_id" "uuid" NOT NULL,
    "actor_id" "uuid",
    "recorded_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "snapshot" "jsonb" NOT NULL
);


ALTER TABLE "public"."cmpri_pool_log_history" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."cmpri_purchase_shipments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "purchase_id" "uuid" NOT NULL,
    "tracking_number" "text",
    "carrier" "text",
    "ship_from" "text",
    "status" "text" DEFAULT 'Shipped'::"text" NOT NULL,
    "shipped_at" timestamp with time zone,
    "delivered_at" timestamp with time zone,
    "received_at" timestamp with time zone,
    "eta" "text",
    "last_email_event_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."cmpri_purchase_shipments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."cmpri_purchases" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hotel_id" "uuid" NOT NULL,
    "external_key" "text" NOT NULL,
    "order_number" "text",
    "vendor" "text",
    "status" "text" DEFAULT 'Ordered'::"text" NOT NULL,
    "ordered_at" timestamp with time zone,
    "eta" "text",
    "work_order_id" "uuid",
    "last_email_event_id" "uuid",
    "notes" "text",
    "line_items" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."cmpri_purchases" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."room_operations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hotel_id" "uuid" NOT NULL,
    "room" "text" NOT NULL,
    "reserved" boolean DEFAULT false NOT NULL,
    "room_status" "text" DEFAULT ''::"text" NOT NULL,
    "departure_date" "date",
    "checkout_time" time without time zone,
    "default_checkout_time" boolean DEFAULT true NOT NULL,
    "deadline" timestamp with time zone,
    "arrival_date" "date",
    "checkin_time" time without time zone,
    "default_checkin_time" boolean DEFAULT true NOT NULL,
    "guest_name" "text" DEFAULT ''::"text" NOT NULL,
    "guest_arrival_date" "date",
    "stay_nights" integer DEFAULT 0 NOT NULL,
    "report_date" "date",
    "moved_from_room" "text" DEFAULT ''::"text" NOT NULL,
    "moved_rooms" boolean DEFAULT false NOT NULL,
    "room_type" "text" DEFAULT ''::"text" NOT NULL,
    "guest_code" "text" DEFAULT ''::"text" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "room_operations_stay_nights_check" CHECK (("stay_nights" >= 0))
);


ALTER TABLE "public"."room_operations" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."cmpri_room_operations" WITH ("security_invoker"='true') AS
 SELECT "id",
    "hotel_id",
    "report_date",
    "report_date" AS "operation_date",
    "room",
    "room" AS "room_number",
    "reserved",
    "room_status",
    "room_status" AS "status",
    "departure_date",
    "departure_date" AS "checkout_date",
    "checkout_time",
    "default_checkout_time",
    "deadline",
    "arrival_date",
    "checkin_time",
    "checkin_time" AS "arrival_time",
    "default_checkin_time",
    "guest_name",
    "guest_arrival_date",
    "stay_nights",
    "moved_from_room",
    "moved_from_room" AS "move_from",
        CASE
            WHEN "moved_rooms" THEN "room"
            ELSE ''::"text"
        END AS "move_to",
    "moved_rooms",
    "moved_rooms" AS "is_move",
        CASE
            WHEN "moved_rooms" THEN "jsonb_build_object"('from', "moved_from_room", 'to', "room")
            ELSE NULL::"jsonb"
        END AS "move_details",
    "room_type",
    "guest_code",
    "updated_at",
    "updated_at" AS "imported_at"
   FROM "public"."room_operations" "ro";


ALTER VIEW "public"."cmpri_room_operations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."cmpri_supplier_followups" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hotel_id" "uuid" NOT NULL,
    "external_key" "text" NOT NULL,
    "purchase_id" "uuid",
    "work_order_id" "uuid",
    "topic" "text",
    "status" "text" DEFAULT 'Vendor Contacted — Awaiting Response'::"text" NOT NULL,
    "last_outbound_at" timestamp with time zone,
    "last_inbound_at" timestamp with time zone,
    "last_email_event_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."cmpri_supplier_followups" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."cmpri_vendor_contacts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hotel_id" "uuid" NOT NULL,
    "vendor_id" "uuid",
    "name" "text" NOT NULL,
    "title" "text",
    "email" "text",
    "phone" "text",
    "notes" "text",
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "role_title" "text" DEFAULT ''::"text" NOT NULL,
    "mobile_phone" "text" DEFAULT ''::"text" NOT NULL,
    "emergency_contact" boolean DEFAULT false NOT NULL,
    "created_by" "uuid"
);


ALTER TABLE "public"."cmpri_vendor_contacts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."cmpri_vendor_proposals" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hotel_id" "uuid" NOT NULL,
    "vendor_id" "uuid",
    "title" "text",
    "summary" "text",
    "proposal_data" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "vendor_contact_id" "uuid",
    "location_id" "uuid",
    "proposal_number" "text" DEFAULT ''::"text" NOT NULL,
    "proposal_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "recommendation" "text" DEFAULT ''::"text" NOT NULL,
    "quoted_cost" numeric(12,2) DEFAULT 0 NOT NULL,
    "scope_summary" "text" DEFAULT ''::"text" NOT NULL,
    "storage_path" "text" DEFAULT ''::"text" NOT NULL,
    "vendor_company_snapshot" "text" DEFAULT ''::"text" NOT NULL,
    "vendor_contact_snapshot" "text" DEFAULT ''::"text" NOT NULL,
    "vendor_phone_snapshot" "text" DEFAULT ''::"text" NOT NULL,
    "vendor_email_snapshot" "text" DEFAULT ''::"text" NOT NULL,
    "notes" "text" DEFAULT ''::"text" NOT NULL,
    "created_by" "uuid",
    "status" "text" DEFAULT 'Pending'::"text" NOT NULL
);


ALTER TABLE "public"."cmpri_vendor_proposals" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."cmpri_vendors" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hotel_id" "uuid" NOT NULL,
    "name" "text" DEFAULT ''::"text" NOT NULL,
    "contact_name" "text",
    "phone" "text",
    "email" "text",
    "notes" "text",
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "company_name" "text" DEFAULT ''::"text" NOT NULL,
    "services" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "main_phone" "text" DEFAULT ''::"text" NOT NULL,
    "emergency_phone" "text" DEFAULT ''::"text" NOT NULL,
    "preferred" boolean DEFAULT false NOT NULL,
    "approved" boolean DEFAULT false NOT NULL,
    "created_by" "uuid"
);


ALTER TABLE "public"."cmpri_vendors" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."cmpri_warranty_cases" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hotel_id" "uuid" NOT NULL,
    "external_key" "text" NOT NULL,
    "warranty_case_number" "text",
    "rma_number" "text",
    "vendor" "text",
    "status" "text" DEFAULT 'Open'::"text" NOT NULL,
    "work_order_id" "uuid",
    "last_email_event_id" "uuid",
    "tracking_numbers" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "ship_from" "text",
    "eta" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."cmpri_warranty_cases" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."cmpri_work_order_drafts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hotel_id" "uuid" NOT NULL,
    "created_by" "uuid" NOT NULL,
    "staff_first_name" "text",
    "location_id" "uuid" NOT NULL,
    "room" "text" DEFAULT ''::"text" NOT NULL,
    "issue" "text" NOT NULL,
    "notes" "text" DEFAULT ''::"text" NOT NULL,
    "asset_id" "uuid",
    "asset_name" "text" DEFAULT ''::"text" NOT NULL,
    "category" "text" DEFAULT 'General'::"text" NOT NULL,
    "priority" "text" DEFAULT 'Medium'::"text" NOT NULL,
    "revision" bigint DEFAULT 1 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "cmpri_work_order_drafts_issue_not_blank" CHECK (("btrim"("issue") <> ''::"text")),
    CONSTRAINT "cmpri_work_order_drafts_revision_positive" CHECK (("revision" >= 1))
);


ALTER TABLE "public"."cmpri_work_order_drafts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."cmpri_work_order_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hotel_id" "uuid" NOT NULL,
    "work_order_id" "uuid",
    "inventory_item_id" "uuid",
    "description" "text",
    "qty" integer DEFAULT 1,
    "unit_cost" numeric(12,2),
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "name" "text" DEFAULT ''::"text" NOT NULL,
    "quantity" numeric(12,3) DEFAULT 1 NOT NULL,
    "status" "text" DEFAULT 'Suggested'::"text" NOT NULL,
    "unit_cost_snapshot" numeric(12,2),
    "recorded_by_user_id" "uuid",
    "recorded_by_name" "text" DEFAULT ''::"text" NOT NULL,
    "recorded_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "notes" "text" DEFAULT ''::"text" NOT NULL
);


ALTER TABLE "public"."cmpri_work_order_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."cmpri_work_order_technician_views" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hotel_id" "uuid" NOT NULL,
    "work_order_id" "uuid" NOT NULL,
    "work_order_display_id" "text" NOT NULL,
    "technician_user_id" "uuid" NOT NULL,
    "technician_name" "text" NOT NULL,
    "status_at_view" "text" NOT NULL,
    "viewed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "resolved_at" timestamp with time zone
);


ALTER TABLE "public"."cmpri_work_order_technician_views" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."corporate_pm_reports" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hotel_id" "uuid" NOT NULL,
    "report_start" "date" NOT NULL,
    "report_end" "date" NOT NULL,
    "generated_by" "uuid",
    "generated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "row_count" integer DEFAULT 0 NOT NULL,
    "column_mapping" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "report_rows" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "notes" "text" DEFAULT ''::"text" NOT NULL,
    CONSTRAINT "corporate_pm_reports_check" CHECK (("report_end" >= "report_start"))
);


ALTER TABLE "public"."corporate_pm_reports" OWNER TO "postgres";


COMMENT ON TABLE "public"."corporate_pm_reports" IS 'Read-only export snapshots for manual copy/paste into the Hawkeye Hotels corporate PM tracker.';



CREATE TABLE IF NOT EXISTS "public"."documents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hotel_id" "uuid",
    "asset_id" "uuid",
    "title" "text" NOT NULL,
    "manufacturer" "text" DEFAULT ''::"text" NOT NULL,
    "model" "text" DEFAULT ''::"text" NOT NULL,
    "document_type" "text" DEFAULT ''::"text" NOT NULL,
    "storage_path" "text" NOT NULL,
    "source_url" "text" DEFAULT ''::"text" NOT NULL,
    "searchable_text" "text" DEFAULT ''::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."documents" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."hotel_members" (
    "hotel_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "role" "public"."hotel_role" DEFAULT 'viewer'::"public"."hotel_role" NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."hotel_members" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."hotels" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "code" "text" NOT NULL,
    "name" "text" NOT NULL,
    "timezone" "text" DEFAULT 'America/Chicago'::"text" NOT NULL,
    "default_checkout_time" time without time zone DEFAULT '11:00:00'::time without time zone NOT NULL,
    "default_checkin_time" time without time zone DEFAULT '15:00:00'::time without time zone NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."hotels" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."inventory_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hotel_id" "uuid" NOT NULL,
    "preferred_vendor_id" "uuid",
    "item_name" "text" NOT NULL,
    "description" "text" DEFAULT ''::"text" NOT NULL,
    "manufacturer" "text" DEFAULT ''::"text" NOT NULL,
    "vendor_sku" "text" DEFAULT ''::"text" NOT NULL,
    "product_url" "text" DEFAULT ''::"text" NOT NULL,
    "package_quantity" numeric(12,3) DEFAULT 1 NOT NULL,
    "unit_of_measure" "text" DEFAULT 'Each'::"text" NOT NULL,
    "quantity_on_hand" numeric(12,3) DEFAULT 0 NOT NULL,
    "quantity_reserved" numeric(12,3) DEFAULT 0 NOT NULL,
    "reorder_level" numeric(12,3),
    "suggested_order_quantity" numeric(12,3),
    "storage_location" "text" DEFAULT ''::"text" NOT NULL,
    "current_unit_cost" numeric(12,2),
    "active" boolean DEFAULT true NOT NULL,
    "notes" "text" DEFAULT ''::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "inventory_items_package_quantity_check" CHECK (("package_quantity" > (0)::numeric))
);


ALTER TABLE "public"."inventory_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."inventory_movements" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hotel_id" "uuid" NOT NULL,
    "inventory_item_id" "uuid" NOT NULL,
    "work_order_item_id" "uuid",
    "movement_type" "text" NOT NULL,
    "quantity_change" numeric(12,3) NOT NULL,
    "unit_cost" numeric(12,2),
    "performed_by" "uuid",
    "performed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "notes" "text" DEFAULT ''::"text" NOT NULL,
    CONSTRAINT "inventory_movements_movement_type_check" CHECK (("movement_type" = ANY (ARRAY['Receipt'::"text", 'Use'::"text", 'Reservation'::"text", 'Release'::"text", 'Return'::"text", 'Adjustment'::"text"]))),
    CONSTRAINT "inventory_movements_quantity_change_check" CHECK (("quantity_change" <> (0)::numeric))
);


ALTER TABLE "public"."inventory_movements" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."locations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hotel_id" "uuid" NOT NULL,
    "area" "text" NOT NULL,
    "name" "text" NOT NULL,
    "room_number" "text",
    "active" boolean DEFAULT true NOT NULL,
    "notes" "text" DEFAULT ''::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "tracks_equipment" boolean DEFAULT true NOT NULL,
    "tracks_chemicals" boolean DEFAULT false NOT NULL,
    "supports_operational_logs" boolean DEFAULT false NOT NULL,
    "location_type" "text" DEFAULT 'General'::"text" NOT NULL
);


ALTER TABLE "public"."locations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."maintenance_documents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hotel_id" "uuid" NOT NULL,
    "document_key" "text" NOT NULL,
    "title" "text" NOT NULL,
    "document_type" "text" DEFAULT 'Manual'::"text" NOT NULL,
    "manufacturer" "text",
    "equipment" "text",
    "model_pattern" "text",
    "drive_file_id" "text",
    "drive_url" "text",
    "storage_path" "text",
    "troubleshooting_cache_key" "text",
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "ingestion_status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "ingestion_error" "text",
    "ingested_at" timestamp with time zone,
    "knowledge_version" integer DEFAULT 1 NOT NULL,
    "source_file_name" "text"
);


ALTER TABLE "public"."maintenance_documents" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."manual_ingestion_runs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hotel_id" "uuid" NOT NULL,
    "started_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "completed_at" timestamp with time zone,
    "source_path" "text",
    "total_files" integer DEFAULT 0 NOT NULL,
    "ingested_files" integer DEFAULT 0 NOT NULL,
    "skipped_files" integer DEFAULT 0 NOT NULL,
    "failed_files" integer DEFAULT 0 NOT NULL,
    "notes" "text"
);


ALTER TABLE "public"."manual_ingestion_runs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."operational_log_entries" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hotel_id" "uuid" NOT NULL,
    "template_id" "uuid" NOT NULL,
    "location_id" "uuid",
    "log_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "service_period" "text" DEFAULT ''::"text" NOT NULL,
    "entered_by" "uuid",
    "entered_by_name" "text" NOT NULL,
    "entered_by_initials" "text" DEFAULT ''::"text" NOT NULL,
    "values" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "corrective_action" "text" DEFAULT ''::"text" NOT NULL,
    "linked_work_order_id" "uuid",
    "requires_attention" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."operational_log_entries" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."operational_log_templates" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hotel_id" "uuid" NOT NULL,
    "location_id" "uuid",
    "department" "text" NOT NULL,
    "title" "text" NOT NULL,
    "log_frequency" "text" DEFAULT 'Daily'::"text" NOT NULL,
    "fields" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."operational_log_templates" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pm_completions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hotel_id" "uuid" NOT NULL,
    "pm_plan_id" "uuid" NOT NULL,
    "completed_on" "date" NOT NULL,
    "completed_by" "uuid",
    "completed_by_name" "text" NOT NULL,
    "checklist_results" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "readings" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "notes" "text" DEFAULT ''::"text" NOT NULL,
    "linked_work_order_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."pm_completions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pm_opportunities" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hotel_id" "uuid" NOT NULL,
    "work_order_id" "uuid" NOT NULL,
    "pm_plan_id" "uuid" NOT NULL,
    "identified_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "pm_due_on_at_identification" "date",
    "acknowledged" boolean DEFAULT false NOT NULL,
    "acknowledged_by" "uuid",
    "outcome_note" "text" DEFAULT ''::"text" NOT NULL,
    "does_not_complete_pm" boolean DEFAULT true NOT NULL,
    CONSTRAINT "pm_opportunities_does_not_complete_pm_check" CHECK (("does_not_complete_pm" = true))
);


ALTER TABLE "public"."pm_opportunities" OWNER TO "postgres";


COMMENT ON TABLE "public"."pm_opportunities" IS 'A PM that could have been performed during a work order. This table never completes or reschedules the PM.';



CREATE TABLE IF NOT EXISTS "public"."pm_plans" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hotel_id" "uuid" NOT NULL,
    "asset_id" "uuid",
    "location_id" "uuid",
    "title" "text" NOT NULL,
    "description" "text" DEFAULT ''::"text" NOT NULL,
    "checklist" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "frequency_value" integer NOT NULL,
    "frequency_unit" "text" NOT NULL,
    "last_completed_on" "date",
    "next_due_on" "date",
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "pm_plans_check" CHECK ((("asset_id" IS NOT NULL) OR ("location_id" IS NOT NULL))),
    CONSTRAINT "pm_plans_frequency_unit_check" CHECK (("frequency_unit" = ANY (ARRAY['Days'::"text", 'Weeks'::"text", 'Months'::"text", 'Years'::"text", 'Runtime Hours'::"text", 'Usage Count'::"text"]))),
    CONSTRAINT "pm_plans_frequency_value_check" CHECK (("frequency_value" > 0))
);


ALTER TABLE "public"."pm_plans" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pool_chemical_orders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hotel_id" "uuid" NOT NULL,
    "chemical_id" "uuid" NOT NULL,
    "ordered_on" "date" DEFAULT CURRENT_DATE NOT NULL,
    "ordered_by" "uuid",
    "quantity" numeric(12,3) NOT NULL,
    "unit_price" numeric(12,2) DEFAULT 0 NOT NULL,
    "shipping" numeric(12,2) DEFAULT 0 NOT NULL,
    "tax" numeric(12,2) DEFAULT 0 NOT NULL,
    "total_cost" numeric(12,2) DEFAULT 0 NOT NULL,
    "received_on" "date",
    "vendor_order_reference" "text" DEFAULT ''::"text" NOT NULL,
    "receipt_storage_path" "text" DEFAULT ''::"text" NOT NULL,
    "notes" "text" DEFAULT ''::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "pool_chemical_orders_quantity_check" CHECK (("quantity" > (0)::numeric))
);


ALTER TABLE "public"."pool_chemical_orders" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pool_chemical_price_checks" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hotel_id" "uuid" NOT NULL,
    "chemical_id" "uuid" NOT NULL,
    "displayed_price" numeric(12,2),
    "price_type" "text" DEFAULT 'one_time'::"text" NOT NULL,
    "currency" "text" DEFAULT 'USD'::"text" NOT NULL,
    "available" boolean,
    "checked_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "notes" "text" DEFAULT ''::"text" NOT NULL
);


ALTER TABLE "public"."pool_chemical_price_checks" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pool_chemical_usage" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hotel_id" "uuid" NOT NULL,
    "pool_facility_id" "uuid" NOT NULL,
    "chemical_id" "uuid" NOT NULL,
    "used_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "amount" numeric(12,3) NOT NULL,
    "unit" "text" NOT NULL,
    "applied_by" "uuid",
    "reason" "text" DEFAULT ''::"text" NOT NULL,
    "pool_log_id" "uuid",
    "notes" "text" DEFAULT ''::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "pool_chemical_usage_amount_check" CHECK (("amount" > (0)::numeric))
);


ALTER TABLE "public"."pool_chemical_usage" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pool_chemicals" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hotel_id" "uuid" NOT NULL,
    "pool_facility_id" "uuid" NOT NULL,
    "product_name" "text" NOT NULL,
    "manufacturer" "text" DEFAULT ''::"text" NOT NULL,
    "purpose" "text" DEFAULT ''::"text" NOT NULL,
    "form" "text" DEFAULT ''::"text" NOT NULL,
    "concentration" "text" DEFAULT ''::"text" NOT NULL,
    "package_size" numeric(12,3),
    "package_unit" "text" DEFAULT ''::"text" NOT NULL,
    "vendor" "text" DEFAULT ''::"text" NOT NULL,
    "product_url" "text" DEFAULT ''::"text" NOT NULL,
    "vendor_product_id" "text" DEFAULT ''::"text" NOT NULL,
    "current_quantity" numeric(12,3) DEFAULT 0 NOT NULL,
    "reorder_level" numeric(12,3),
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."pool_chemicals" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pool_compliance_requirements" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hotel_id" "uuid" NOT NULL,
    "pool_facility_id" "uuid" NOT NULL,
    "authority" "text" NOT NULL,
    "citation" "text" DEFAULT ''::"text" NOT NULL,
    "requirement_title" "text" NOT NULL,
    "requirement_detail" "text" DEFAULT ''::"text" NOT NULL,
    "frequency" "text" DEFAULT ''::"text" NOT NULL,
    "status" "text" DEFAULT 'unverified'::"text" NOT NULL,
    "due_on" "date",
    "verified_on" "date",
    "notes" "text" DEFAULT ''::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "pool_compliance_requirements_status_check" CHECK (("status" = ANY (ARRAY['unverified'::"text", 'compliant'::"text", 'due_soon'::"text", 'overdue'::"text", 'not_compliant'::"text", 'not_applicable'::"text"])))
);


ALTER TABLE "public"."pool_compliance_requirements" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pool_daily_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hotel_id" "uuid" NOT NULL,
    "pool_facility_id" "uuid" NOT NULL,
    "log_date" "date" NOT NULL,
    "ph_shallow_am" numeric(4,2),
    "ph_shallow_pm" numeric(4,2),
    "ph_deep_am" numeric(4,2),
    "ph_deep_pm" numeric(4,2),
    "main_drain_visible" boolean,
    "sanitizer_shallow_am" numeric(5,2),
    "sanitizer_shallow_pm" numeric(5,2),
    "sanitizer_deep_am" numeric(5,2),
    "sanitizer_deep_pm" numeric(5,2),
    "flow_rate_gpm" numeric(10,2),
    "filter_backwashed" boolean,
    "temperature_f" numeric(5,2),
    "combined_chlorine_ppm" numeric(5,2),
    "cyanuric_acid_ppm" numeric(7,2),
    "completed_by_initials" "text" DEFAULT ''::"text" NOT NULL,
    "remarks" "text" DEFAULT ''::"text" NOT NULL,
    "requires_attention" boolean DEFAULT false NOT NULL,
    "closure_condition" boolean DEFAULT false NOT NULL,
    "linked_work_order_id" "uuid",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "ph_am" numeric,
    "ph_pm" numeric,
    "sanitizer_am" numeric,
    "sanitizer_pm" numeric,
    "revision" bigint DEFAULT 1 NOT NULL,
    "updated_by" "uuid",
    "sanitizer_band_am" "text",
    "sanitizer_band_pm" "text",
    "sample_location_am" "text",
    "sample_location_pm" "text",
    "ph_middle_am" numeric,
    "sanitizer_middle_am" numeric,
    "ph_middle_pm" numeric,
    "sanitizer_middle_pm" numeric,
    "closure_reason" "text",
    CONSTRAINT "pool_daily_logs_sample_location_am_check" CHECK ((("sample_location_am" IS NULL) OR ("sample_location_am" = ANY (ARRAY['shallow'::"text", 'middle'::"text", 'deep'::"text"])))),
    CONSTRAINT "pool_daily_logs_sample_location_pm_check" CHECK ((("sample_location_pm" IS NULL) OR ("sample_location_pm" = ANY (ARRAY['shallow'::"text", 'middle'::"text", 'deep'::"text"])))),
    CONSTRAINT "pool_daily_logs_sanitizer_band_am_check" CHECK ((("sanitizer_band_am" IS NULL) OR ("sanitizer_band_am" = ANY (ARRAY['0'::"text", '1-2'::"text", '2-4'::"text", '3-6'::"text", '5-10'::"text", '7.5-15'::"text", '10-20'::"text"])))),
    CONSTRAINT "pool_daily_logs_sanitizer_band_pm_check" CHECK ((("sanitizer_band_pm" IS NULL) OR ("sanitizer_band_pm" = ANY (ARRAY['0'::"text", '1-2'::"text", '2-4'::"text", '3-6'::"text", '5-10'::"text", '7.5-15'::"text", '10-20'::"text"]))))
);


ALTER TABLE "public"."pool_daily_logs" OWNER TO "postgres";


COMMENT ON TABLE "public"."pool_daily_logs" IS 'Daily Illinois swimming facility operational records. Retain for at least three years and make available for inspection.';



CREATE TABLE IF NOT EXISTS "public"."pool_documents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hotel_id" "uuid" NOT NULL,
    "pool_facility_id" "uuid" NOT NULL,
    "requirement_id" "uuid",
    "equipment_id" "uuid",
    "chemical_id" "uuid",
    "document_type" "text" NOT NULL,
    "title" "text" NOT NULL,
    "storage_path" "text" NOT NULL,
    "issue_date" "date",
    "expiration_date" "date",
    "submitted_to_authority_on" "date",
    "notes" "text" DEFAULT ''::"text" NOT NULL,
    "uploaded_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."pool_documents" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pool_equipment" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hotel_id" "uuid" NOT NULL,
    "pool_facility_id" "uuid" NOT NULL,
    "equipment_type" "text" NOT NULL,
    "manufacturer" "text" DEFAULT ''::"text" NOT NULL,
    "model" "text" DEFAULT ''::"text" NOT NULL,
    "serial_number" "text" DEFAULT ''::"text" NOT NULL,
    "certification" "text" DEFAULT ''::"text" NOT NULL,
    "installed_on" "date",
    "manufacturer_service_life_end" "date",
    "replacement_due_on" "date",
    "last_inspected_on" "date",
    "status" "text" DEFAULT 'unknown'::"text" NOT NULL,
    "notes" "text" DEFAULT ''::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "pool_equipment_status_check" CHECK (("status" = ANY (ARRAY['unknown'::"text", 'compliant'::"text", 'due_soon'::"text", 'overdue'::"text", 'out_of_service'::"text"])))
);


ALTER TABLE "public"."pool_equipment" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pool_facilities" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hotel_id" "uuid" NOT NULL,
    "facility_name" "text" NOT NULL,
    "city" "text" NOT NULL,
    "pool_name" "text" NOT NULL,
    "environment" "text" DEFAULT 'indoor'::"text" NOT NULL,
    "volume_gallons" integer,
    "length_ft" numeric(8,2),
    "width_ft" numeric(8,2),
    "minimum_depth_ft" numeric(6,2),
    "maximum_depth_ft" numeric(6,2),
    "sanitizer" "text" DEFAULT 'unknown'::"text" NOT NULL,
    "required_flow_rate_gpm" numeric(10,2),
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "pool_facilities_environment_check" CHECK (("environment" = ANY (ARRAY['indoor'::"text", 'outdoor'::"text"]))),
    CONSTRAINT "pool_facilities_sanitizer_check" CHECK (("sanitizer" = ANY (ARRAY['unknown'::"text", 'chlorine'::"text", 'bromine'::"text"]))),
    CONSTRAINT "pool_facilities_volume_gallons_check" CHECK ((("volume_gallons" IS NULL) OR ("volume_gallons" > 0)))
);


ALTER TABLE "public"."pool_facilities" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "email" "text",
    "full_name" "text",
    "role" "text" DEFAULT 'front_desk'::"text" NOT NULL,
    "property_scope" "text" DEFAULT 'assigned_property'::"text" NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "preferred_language" "text" DEFAULT 'en'::"text" NOT NULL,
    "preferences" "jsonb" DEFAULT '{"language": "en", "appearance": "dark", "notifications": {"mentions": true, "status_changes": true, "new_work_orders": true}}'::"jsonb" NOT NULL,
    "personal_ai_connected" boolean DEFAULT false NOT NULL,
    "personal_ai_provider" "text",
    "personal_ai_model" "text",
    "personal_ai_api_key_encrypted" "text",
    "personal_ai_status" "text" DEFAULT 'disconnected'::"text" NOT NULL,
    "personal_ai_last_tested_at" timestamp with time zone,
    "personal_ai_error" "text",
    CONSTRAINT "profiles_personal_ai_status_check" CHECK (("personal_ai_status" = ANY (ARRAY['active'::"text", 'disconnected'::"text", 'error'::"text"]))),
    CONSTRAINT "profiles_preferred_language_check" CHECK (("preferred_language" = ANY (ARRAY['en'::"text", 'es'::"text"]))),
    CONSTRAINT "profiles_property_scope_check" CHECK (("property_scope" = ANY (ARRAY['all_properties'::"text", 'assigned_region'::"text", 'assigned_district'::"text", 'assigned_properties'::"text", 'assigned_property'::"text"]))),
    CONSTRAINT "profiles_role_check" CHECK (("role" = ANY (ARRAY['system_admin'::"text", 'vp_facilities'::"text", 'regional_director_operations'::"text", 'district_manager'::"text", 'asset_manager'::"text", 'general_manager'::"text", 'engineer'::"text", 'manager'::"text", 'technician'::"text", 'front_desk'::"text", 'housekeeping'::"text", 'senior_management'::"text"])))
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."role_permissions" (
    "role" "text" NOT NULL,
    "permission" "text" NOT NULL,
    "allowed" boolean DEFAULT true NOT NULL
);


ALTER TABLE "public"."role_permissions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."technicians" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hotel_id" "uuid" NOT NULL,
    "user_id" "uuid",
    "name" "text" NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "first_name" "text" DEFAULT ''::"text" NOT NULL,
    "last_name" "text" DEFAULT ''::"text" NOT NULL,
    "job_title" "text" DEFAULT ''::"text" NOT NULL,
    "initials" "text" DEFAULT ''::"text" NOT NULL,
    "department" "text" DEFAULT 'Engineering'::"text" NOT NULL,
    "can_receive_work_orders" boolean DEFAULT true NOT NULL,
    "can_create_work_orders" boolean DEFAULT true NOT NULL
);


ALTER TABLE "public"."technicians" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."troubleshooting_cache" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hotel_id" "uuid" NOT NULL,
    "work_order_id" "uuid",
    "cache_type" "text" NOT NULL,
    "cache_key" "text" NOT NULL,
    "payload" "jsonb" NOT NULL,
    "expires_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."troubleshooting_cache" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_feedback" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hotel_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "user_name" "text" NOT NULL,
    "user_role" "text" NOT NULL,
    "feedback_type" "text" NOT NULL,
    "description" "text" NOT NULL,
    "page_route" "text" NOT NULL,
    "app_version" "text" NOT NULL,
    "status" "text" DEFAULT 'New'::"text" NOT NULL,
    "reviewed_at" timestamp with time zone,
    "resolved_at" timestamp with time zone,
    CONSTRAINT "user_feedback_app_version_check" CHECK ((("char_length"("app_version") >= 1) AND ("char_length"("app_version") <= 100))),
    CONSTRAINT "user_feedback_description_check" CHECK ((("char_length"("btrim"("description")) >= 1) AND ("char_length"("btrim"("description")) <= 10000))),
    CONSTRAINT "user_feedback_feedback_type_check" CHECK (("feedback_type" = ANY (ARRAY['Problem'::"text", 'Bug'::"text", 'Suggestion'::"text"]))),
    CONSTRAINT "user_feedback_page_route_check" CHECK ((("char_length"("page_route") >= 1) AND ("char_length"("page_route") <= 500))),
    CONSTRAINT "user_feedback_status_check" CHECK (("status" = ANY (ARRAY['New'::"text", 'Reviewed'::"text", 'Planned'::"text", 'Resolved'::"text"])))
);


ALTER TABLE "public"."user_feedback" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_profiles" (
    "hotel_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "associate_id" "uuid",
    "display_name" "text" NOT NULL,
    "initials" "text" DEFAULT ''::"text" NOT NULL,
    "account_label" "text" DEFAULT ''::"text" NOT NULL,
    "shared_account" boolean DEFAULT false NOT NULL,
    "require_creator_entry" boolean DEFAULT false NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."user_profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."vendor_contacts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hotel_id" "uuid" NOT NULL,
    "vendor_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "role_title" "text" DEFAULT ''::"text" NOT NULL,
    "phone" "text" DEFAULT ''::"text" NOT NULL,
    "mobile_phone" "text" DEFAULT ''::"text" NOT NULL,
    "email" "text" DEFAULT ''::"text" NOT NULL,
    "emergency_contact" boolean DEFAULT false NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "notes" "text" DEFAULT ''::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."vendor_contacts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."vendor_proposals" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hotel_id" "uuid" NOT NULL,
    "vendor_id" "uuid" NOT NULL,
    "vendor_contact_id" "uuid",
    "asset_id" "uuid",
    "location_id" "uuid",
    "work_order_id" "uuid",
    "proposal_number" "text" DEFAULT ''::"text" NOT NULL,
    "proposal_date" "date" NOT NULL,
    "recommendation" "text" DEFAULT ''::"text" NOT NULL,
    "status" "text" DEFAULT 'Pending'::"text" NOT NULL,
    "quoted_cost" numeric(12,2) DEFAULT 0 NOT NULL,
    "scope_summary" "text" DEFAULT ''::"text" NOT NULL,
    "storage_path" "text" DEFAULT ''::"text" NOT NULL,
    "vendor_company_snapshot" "text" NOT NULL,
    "vendor_contact_snapshot" "text" DEFAULT ''::"text" NOT NULL,
    "vendor_phone_snapshot" "text" DEFAULT ''::"text" NOT NULL,
    "vendor_email_snapshot" "text" DEFAULT ''::"text" NOT NULL,
    "notes" "text" DEFAULT ''::"text" NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "vendor_proposals_recommendation_check" CHECK (("recommendation" = ANY (ARRAY[''::"text", 'Repair'::"text", 'Replace'::"text", 'Repair Or Replace'::"text", 'Other'::"text"]))),
    CONSTRAINT "vendor_proposals_status_check" CHECK (("status" = ANY (ARRAY['Pending'::"text", 'Approved'::"text", 'Declined'::"text", 'Expired'::"text", 'Completed'::"text"])))
);


ALTER TABLE "public"."vendor_proposals" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."vendors" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hotel_id" "uuid" NOT NULL,
    "company_name" "text" NOT NULL,
    "services" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "main_phone" "text" DEFAULT ''::"text" NOT NULL,
    "email" "text" DEFAULT ''::"text" NOT NULL,
    "website" "text" DEFAULT ''::"text" NOT NULL,
    "emergency_phone" "text" DEFAULT ''::"text" NOT NULL,
    "preferred" boolean DEFAULT false NOT NULL,
    "approved" boolean DEFAULT false NOT NULL,
    "notes" "text" DEFAULT ''::"text" NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."vendors" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."work_order_creator_audit" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hotel_id" "uuid" NOT NULL,
    "work_order_id" "uuid" NOT NULL,
    "previous_creator_name" "text" NOT NULL,
    "previous_creator_initials" "text" DEFAULT ''::"text" NOT NULL,
    "corrected_creator_name" "text" NOT NULL,
    "corrected_creator_initials" "text" DEFAULT ''::"text" NOT NULL,
    "correction_reason" "text" NOT NULL,
    "corrected_by" "uuid" NOT NULL,
    "corrected_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."work_order_creator_audit" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."work_order_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hotel_id" "uuid" NOT NULL,
    "work_order_id" "uuid" NOT NULL,
    "inventory_item_id" "uuid" NOT NULL,
    "status" "text" DEFAULT 'Suggested'::"text" NOT NULL,
    "quantity" numeric(12,3) NOT NULL,
    "unit_cost_snapshot" numeric(12,2),
    "recorded_by" "uuid",
    "recorded_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "notes" "text" DEFAULT ''::"text" NOT NULL,
    CONSTRAINT "work_order_items_quantity_check" CHECK (("quantity" > (0)::numeric)),
    CONSTRAINT "work_order_items_status_check" CHECK (("status" = ANY (ARRAY['Suggested'::"text", 'Reserved'::"text", 'Installed/Used'::"text", 'Returned To Inventory'::"text", 'Ordered'::"text", 'Received'::"text"])))
);


ALTER TABLE "public"."work_order_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."work_order_sources" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hotel_id" "uuid" NOT NULL,
    "work_order_id" "uuid" NOT NULL,
    "source_system" "text" NOT NULL,
    "source_sheet" "text" DEFAULT ''::"text" NOT NULL,
    "source_record_key" "text" NOT NULL,
    "source_room" "text" DEFAULT ''::"text" NOT NULL,
    "source_note" "text" DEFAULT ''::"text" NOT NULL,
    "issue_fingerprint" "text" NOT NULL,
    "imported_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."work_order_sources" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."work_orders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hotel_id" "uuid" NOT NULL,
    "display_id" "text" NOT NULL,
    "request_id" "text",
    "location_id" "uuid",
    "asset_id" "uuid",
    "room" "text" NOT NULL,
    "asset_name" "text" DEFAULT ''::"text" NOT NULL,
    "category" "text" DEFAULT 'General'::"text" NOT NULL,
    "issue" "text" NOT NULL,
    "priority" "text" DEFAULT 'Medium'::"text" NOT NULL,
    "technician_id" "uuid",
    "technician_name" "text" DEFAULT ''::"text" NOT NULL,
    "action_root_cause" "text" DEFAULT ''::"text" NOT NULL,
    "parts" "text" DEFAULT ''::"text" NOT NULL,
    "cost" numeric(12,2) DEFAULT 0 NOT NULL,
    "hours" numeric(10,2) DEFAULT 0 NOT NULL,
    "status" "public"."work_order_status" DEFAULT 'Open'::"public"."work_order_status" NOT NULL,
    "notes" "text" DEFAULT ''::"text" NOT NULL,
    "logged_on" "date" DEFAULT CURRENT_DATE NOT NULL,
    "due_by" timestamp with time zone,
    "completed_on" "date",
    "action_updated_at" timestamp with time zone,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "creator_name" "text" DEFAULT ''::"text" NOT NULL,
    "creator_initials" "text" DEFAULT ''::"text" NOT NULL,
    "creator_source" "text" DEFAULT 'signed_in_user'::"text" NOT NULL,
    "creator_account_user_id" "uuid",
    "submitted_by_name" "text",
    "submitted_by_user_id" "uuid",
    "revision" bigint DEFAULT 1 NOT NULL,
    "reporter_notes" "text",
    "source_draft_id" "uuid",
    "source_draft_created_by" "uuid",
    "source_draft_creator_name" "text",
    "last_assigned_technician_name" "text",
    CONSTRAINT "work_orders_creator_source_check" CHECK (("creator_source" = ANY (ARRAY['signed_in_user'::"text", 'shared_account_entry'::"text", 'front_desk_pending_verification'::"text", 'department_pending_verification'::"text", 'import'::"text", 'admin_correction'::"text"])))
);


ALTER TABLE "public"."work_orders" OWNER TO "postgres";


ALTER TABLE ONLY "public"."asset_inventory_compatibility"
    ADD CONSTRAINT "asset_inventory_compatibility_pkey" PRIMARY KEY ("asset_id", "inventory_item_id");



ALTER TABLE ONLY "public"."assets"
    ADD CONSTRAINT "assets_hotel_id_legacy_asset_id_key" UNIQUE ("hotel_id", "legacy_asset_id");



ALTER TABLE ONLY "public"."assets"
    ADD CONSTRAINT "assets_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."cmpri_asset_inventory_compatibility"
    ADD CONSTRAINT "cmpri_asset_inventory_compati_hotel_id_asset_id_inventory_i_key" UNIQUE ("hotel_id", "asset_id", "inventory_item_id");



ALTER TABLE ONLY "public"."cmpri_asset_inventory_compatibility"
    ADD CONSTRAINT "cmpri_asset_inventory_compatibility_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."cmpri_email_events"
    ADD CONSTRAINT "cmpri_email_events_gmail_message_id_key" UNIQUE ("gmail_message_id");



ALTER TABLE ONLY "public"."cmpri_email_events"
    ADD CONSTRAINT "cmpri_email_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."cmpri_enseo_assignment_history"
    ADD CONSTRAINT "cmpri_enseo_assignment_history_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."cmpri_enseo_assignments"
    ADD CONSTRAINT "cmpri_enseo_assignments_hotel_id_asset_id_key" UNIQUE ("hotel_id", "asset_id");



ALTER TABLE ONLY "public"."cmpri_enseo_assignments"
    ADD CONSTRAINT "cmpri_enseo_assignments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."cmpri_enseo_tickets"
    ADD CONSTRAINT "cmpri_enseo_tickets_hotel_id_external_key_key" UNIQUE ("hotel_id", "external_key");



ALTER TABLE ONLY "public"."cmpri_enseo_tickets"
    ADD CONSTRAINT "cmpri_enseo_tickets_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."cmpri_gss_reports"
    ADD CONSTRAINT "cmpri_gss_reports_hotel_id_report_week_key" UNIQUE ("hotel_id", "report_week");



ALTER TABLE ONLY "public"."cmpri_gss_reports"
    ADD CONSTRAINT "cmpri_gss_reports_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."cmpri_inventory_items"
    ADD CONSTRAINT "cmpri_inventory_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."cmpri_inventory_movements"
    ADD CONSTRAINT "cmpri_inventory_movements_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."cmpri_mcp_oauth_clients"
    ADD CONSTRAINT "cmpri_mcp_oauth_clients_pkey" PRIMARY KEY ("client_id");



ALTER TABLE ONLY "public"."cmpri_mcp_oauth_codes"
    ADD CONSTRAINT "cmpri_mcp_oauth_codes_pkey" PRIMARY KEY ("code_hash");



ALTER TABLE ONLY "public"."cmpri_mcp_oauth_tokens"
    ADD CONSTRAINT "cmpri_mcp_oauth_tokens_pkey" PRIMARY KEY ("token_hash");



ALTER TABLE ONLY "public"."cmpri_order_ideas"
    ADD CONSTRAINT "cmpri_order_ideas_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."cmpri_personal_mcp_links"
    ADD CONSTRAINT "cmpri_personal_mcp_links_pkey" PRIMARY KEY ("token_hash");



ALTER TABLE ONLY "public"."cmpri_pm_proposals"
    ADD CONSTRAINT "cmpri_pm_proposals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."cmpri_pool_log_history"
    ADD CONSTRAINT "cmpri_pool_log_history_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."cmpri_purchase_shipments"
    ADD CONSTRAINT "cmpri_purchase_shipments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."cmpri_purchases"
    ADD CONSTRAINT "cmpri_purchases_hotel_id_external_key_key" UNIQUE ("hotel_id", "external_key");



ALTER TABLE ONLY "public"."cmpri_purchases"
    ADD CONSTRAINT "cmpri_purchases_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."cmpri_supplier_followups"
    ADD CONSTRAINT "cmpri_supplier_followups_hotel_id_external_key_key" UNIQUE ("hotel_id", "external_key");



ALTER TABLE ONLY "public"."cmpri_supplier_followups"
    ADD CONSTRAINT "cmpri_supplier_followups_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."cmpri_vendor_contacts"
    ADD CONSTRAINT "cmpri_vendor_contacts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."cmpri_vendor_proposals"
    ADD CONSTRAINT "cmpri_vendor_proposals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."cmpri_vendors"
    ADD CONSTRAINT "cmpri_vendors_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."cmpri_warranty_cases"
    ADD CONSTRAINT "cmpri_warranty_cases_hotel_id_external_key_key" UNIQUE ("hotel_id", "external_key");



ALTER TABLE ONLY "public"."cmpri_warranty_cases"
    ADD CONSTRAINT "cmpri_warranty_cases_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."cmpri_work_order_drafts"
    ADD CONSTRAINT "cmpri_work_order_drafts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."cmpri_work_order_items"
    ADD CONSTRAINT "cmpri_work_order_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."cmpri_work_order_technician_views"
    ADD CONSTRAINT "cmpri_work_order_technician_v_hotel_id_work_order_id_techni_key" UNIQUE ("hotel_id", "work_order_id", "technician_user_id");



ALTER TABLE ONLY "public"."cmpri_work_order_technician_views"
    ADD CONSTRAINT "cmpri_work_order_technician_views_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."corporate_pm_reports"
    ADD CONSTRAINT "corporate_pm_reports_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."documents"
    ADD CONSTRAINT "documents_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."hotel_members"
    ADD CONSTRAINT "hotel_members_pkey" PRIMARY KEY ("hotel_id", "user_id");



ALTER TABLE ONLY "public"."hotels"
    ADD CONSTRAINT "hotels_code_key" UNIQUE ("code");



ALTER TABLE ONLY "public"."hotels"
    ADD CONSTRAINT "hotels_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."inventory_items"
    ADD CONSTRAINT "inventory_items_hotel_id_preferred_vendor_id_vendor_sku_key" UNIQUE ("hotel_id", "preferred_vendor_id", "vendor_sku");



ALTER TABLE ONLY "public"."inventory_items"
    ADD CONSTRAINT "inventory_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."inventory_movements"
    ADD CONSTRAINT "inventory_movements_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."locations"
    ADD CONSTRAINT "locations_hotel_id_area_name_key" UNIQUE ("hotel_id", "area", "name");



ALTER TABLE ONLY "public"."locations"
    ADD CONSTRAINT "locations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."maintenance_documents"
    ADD CONSTRAINT "maintenance_documents_hotel_id_document_key_key" UNIQUE ("hotel_id", "document_key");



ALTER TABLE ONLY "public"."maintenance_documents"
    ADD CONSTRAINT "maintenance_documents_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."manual_ingestion_runs"
    ADD CONSTRAINT "manual_ingestion_runs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."operational_log_entries"
    ADD CONSTRAINT "operational_log_entries_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."operational_log_templates"
    ADD CONSTRAINT "operational_log_templates_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pm_completions"
    ADD CONSTRAINT "pm_completions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pm_completions"
    ADD CONSTRAINT "pm_completions_pm_plan_id_completed_on_key" UNIQUE ("pm_plan_id", "completed_on");



ALTER TABLE ONLY "public"."pm_opportunities"
    ADD CONSTRAINT "pm_opportunities_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pm_opportunities"
    ADD CONSTRAINT "pm_opportunities_work_order_id_pm_plan_id_key" UNIQUE ("work_order_id", "pm_plan_id");



ALTER TABLE ONLY "public"."pm_plans"
    ADD CONSTRAINT "pm_plans_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pool_chemical_orders"
    ADD CONSTRAINT "pool_chemical_orders_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pool_chemical_price_checks"
    ADD CONSTRAINT "pool_chemical_price_checks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pool_chemical_usage"
    ADD CONSTRAINT "pool_chemical_usage_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pool_chemicals"
    ADD CONSTRAINT "pool_chemicals_hotel_id_vendor_vendor_product_id_key" UNIQUE ("hotel_id", "vendor", "vendor_product_id");



ALTER TABLE ONLY "public"."pool_chemicals"
    ADD CONSTRAINT "pool_chemicals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pool_compliance_requirements"
    ADD CONSTRAINT "pool_compliance_requirements_pkey" PRIMARY KEY ("id");



ALTER TABLE "public"."pool_daily_logs"
    ADD CONSTRAINT "pool_daily_logs_closure_reason_required_check" CHECK ((("closure_condition" IS DISTINCT FROM true) OR (NULLIF("btrim"("closure_reason"), ''::"text") IS NOT NULL))) NOT VALID;



ALTER TABLE ONLY "public"."pool_daily_logs"
    ADD CONSTRAINT "pool_daily_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pool_daily_logs"
    ADD CONSTRAINT "pool_daily_logs_pool_facility_id_log_date_key" UNIQUE ("pool_facility_id", "log_date");



ALTER TABLE ONLY "public"."pool_documents"
    ADD CONSTRAINT "pool_documents_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pool_equipment"
    ADD CONSTRAINT "pool_equipment_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pool_facilities"
    ADD CONSTRAINT "pool_facilities_hotel_id_pool_name_key" UNIQUE ("hotel_id", "pool_name");



ALTER TABLE ONLY "public"."pool_facilities"
    ADD CONSTRAINT "pool_facilities_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."role_permissions"
    ADD CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role", "permission");



ALTER TABLE ONLY "public"."room_operations"
    ADD CONSTRAINT "room_operations_hotel_id_room_key" UNIQUE ("hotel_id", "room");



ALTER TABLE ONLY "public"."room_operations"
    ADD CONSTRAINT "room_operations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."technicians"
    ADD CONSTRAINT "technicians_hotel_id_name_key" UNIQUE ("hotel_id", "name");



ALTER TABLE ONLY "public"."technicians"
    ADD CONSTRAINT "technicians_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."troubleshooting_cache"
    ADD CONSTRAINT "troubleshooting_cache_hotel_id_cache_type_cache_key_key" UNIQUE ("hotel_id", "cache_type", "cache_key");



ALTER TABLE ONLY "public"."troubleshooting_cache"
    ADD CONSTRAINT "troubleshooting_cache_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_feedback"
    ADD CONSTRAINT "user_feedback_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_profiles"
    ADD CONSTRAINT "user_profiles_pkey" PRIMARY KEY ("hotel_id", "user_id");



ALTER TABLE ONLY "public"."vendor_contacts"
    ADD CONSTRAINT "vendor_contacts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."vendor_proposals"
    ADD CONSTRAINT "vendor_proposals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."vendors"
    ADD CONSTRAINT "vendors_hotel_id_company_name_key" UNIQUE ("hotel_id", "company_name");



ALTER TABLE ONLY "public"."vendors"
    ADD CONSTRAINT "vendors_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."work_order_creator_audit"
    ADD CONSTRAINT "work_order_creator_audit_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."work_order_items"
    ADD CONSTRAINT "work_order_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."work_order_sources"
    ADD CONSTRAINT "work_order_sources_hotel_id_source_system_source_sheet_sour_key" UNIQUE ("hotel_id", "source_system", "source_sheet", "source_record_key");



ALTER TABLE ONLY "public"."work_order_sources"
    ADD CONSTRAINT "work_order_sources_pkey" PRIMARY KEY ("id");



ALTER TABLE "public"."work_orders"
    ADD CONSTRAINT "work_orders_creator_name_required" CHECK (("btrim"("creator_name") <> ''::"text")) NOT VALID;



ALTER TABLE ONLY "public"."work_orders"
    ADD CONSTRAINT "work_orders_hotel_id_display_id_key" UNIQUE ("hotel_id", "display_id");



ALTER TABLE ONLY "public"."work_orders"
    ADD CONSTRAINT "work_orders_hotel_id_request_id_key" UNIQUE ("hotel_id", "request_id");



ALTER TABLE ONLY "public"."work_orders"
    ADD CONSTRAINT "work_orders_pkey" PRIMARY KEY ("id");



CREATE UNIQUE INDEX "assets_hotel_asset_tag_idx" ON "public"."assets" USING "btree" ("hotel_id", "asset_tag") WHERE (("asset_tag" IS NOT NULL) AND ("asset_tag" <> ''::"text"));



CREATE UNIQUE INDEX "assets_hotel_binder_import_id_uidx" ON "public"."assets" USING "btree" ("hotel_id", "binder_import_id") WHERE ("binder_import_id" IS NOT NULL);



CREATE UNIQUE INDEX "cmpri_asset_inventory_compatibility_asset_item_uidx" ON "public"."cmpri_asset_inventory_compatibility" USING "btree" ("asset_id", "inventory_item_id");



CREATE INDEX "cmpri_email_events_message_at_idx" ON "public"."cmpri_email_events" USING "btree" ("message_at" DESC);



CREATE INDEX "cmpri_enseo_assignment_history_asset_idx" ON "public"."cmpri_enseo_assignment_history" USING "btree" ("hotel_id", "asset_id", "moved_at" DESC);



CREATE UNIQUE INDEX "cmpri_enseo_assignments_asset_unique" ON "public"."cmpri_enseo_assignments" USING "btree" ("hotel_id", "asset_id") WHERE ("asset_id" IS NOT NULL);



CREATE INDEX "cmpri_enseo_assignments_location_idx" ON "public"."cmpri_enseo_assignments" USING "btree" ("hotel_id", "location_id", "sub_location") WHERE ("active" = true);



CREATE UNIQUE INDEX "cmpri_enseo_stb_endpoint_uidx" ON "public"."cmpri_enseo_assignments" USING "btree" ("hotel_id", "endpoint_code") WHERE (("active" = true) AND ("device_type" = 'STB'::"text") AND ("endpoint_code" IS NOT NULL));



CREATE INDEX "cmpri_enseo_work_order_idx" ON "public"."cmpri_enseo_tickets" USING "btree" ("work_order_id");



CREATE INDEX "cmpri_mcp_oauth_codes_expiry_idx" ON "public"."cmpri_mcp_oauth_codes" USING "btree" ("expires_at");



CREATE INDEX "cmpri_mcp_oauth_tokens_family_idx" ON "public"."cmpri_mcp_oauth_tokens" USING "btree" ("token_family_id") WHERE ("revoked_at" IS NULL);



CREATE INDEX "cmpri_mcp_oauth_tokens_user_active_idx" ON "public"."cmpri_mcp_oauth_tokens" USING "btree" ("user_id", "token_type", "expires_at") WHERE ("revoked_at" IS NULL);



CREATE INDEX "cmpri_personal_mcp_links_expiry_idx" ON "public"."cmpri_personal_mcp_links" USING "btree" ("expires_at") WHERE ("revoked_at" IS NULL);



CREATE UNIQUE INDEX "cmpri_pm_one_pending_proposal_per_scope" ON "public"."cmpri_pm_proposals" USING "btree" ("hotel_id", "template_id", "period_start", "scope_key") WHERE ("status" = ANY (ARRAY['pending'::"text", 'processing'::"text"]));



CREATE INDEX "cmpri_pm_proposals_hotel_period_idx" ON "public"."cmpri_pm_proposals" USING "btree" ("hotel_id", "period_start", "status");



CREATE INDEX "cmpri_pm_proposals_review_queue_idx" ON "public"."cmpri_pm_proposals" USING "btree" ("hotel_id", "status", "created_at" DESC);



CREATE UNIQUE INDEX "cmpri_pool_daily_log_unique" ON "public"."pool_daily_logs" USING "btree" ("hotel_id", "pool_facility_id", "log_date");



CREATE UNIQUE INDEX "cmpri_purchase_shipments_tracking_unique" ON "public"."cmpri_purchase_shipments" USING "btree" ("purchase_id", "tracking_number");



CREATE UNIQUE INDEX "cmpri_purchase_shipments_upsert_unique" ON "public"."cmpri_purchase_shipments" USING "btree" ("purchase_id", "tracking_number");



CREATE INDEX "cmpri_purchases_work_order_idx" ON "public"."cmpri_purchases" USING "btree" ("work_order_id");



CREATE INDEX "cmpri_warranty_work_order_idx" ON "public"."cmpri_warranty_cases" USING "btree" ("work_order_id");



CREATE INDEX "cmpri_work_order_drafts_owner_idx" ON "public"."cmpri_work_order_drafts" USING "btree" ("hotel_id", "created_by", "updated_at" DESC);



CREATE INDEX "cmpri_work_order_technician_views_pending_idx" ON "public"."cmpri_work_order_technician_views" USING "btree" ("hotel_id", "viewed_at") WHERE ("resolved_at" IS NULL);



CREATE INDEX "cmpri_work_order_technician_views_resolved_idx" ON "public"."cmpri_work_order_technician_views" USING "btree" ("hotel_id", "resolved_at") WHERE ("resolved_at" IS NOT NULL);



CREATE INDEX "cmpri_work_orders_source_draft_idx" ON "public"."work_orders" USING "btree" ("source_draft_id");



CREATE INDEX "documents_search_idx" ON "public"."documents" USING "gin" ("to_tsvector"('"english"'::"regconfig", "searchable_text"));



CREATE INDEX "idx_assets_hotel_name" ON "public"."assets" USING "btree" ("hotel_id", "active", "name");



CREATE INDEX "idx_assets_location" ON "public"."assets" USING "btree" ("location_id");



CREATE INDEX "idx_cmpri_email_hotel_message" ON "public"."cmpri_email_events" USING "btree" ("hotel_id", "message_at" DESC);



CREATE INDEX "idx_cmpri_purchases_hotel_updated" ON "public"."cmpri_purchases" USING "btree" ("hotel_id", "updated_at" DESC);



CREATE INDEX "idx_cmpri_shipments_purchase" ON "public"."cmpri_purchase_shipments" USING "btree" ("purchase_id");



CREATE INDEX "idx_hotel_members_hotel_user" ON "public"."hotel_members" USING "btree" ("hotel_id", "user_id");



CREATE INDEX "idx_locations_hotel_active" ON "public"."locations" USING "btree" ("hotel_id", "active", "area", "room_number");



CREATE INDEX "idx_pm_completions_hotel_on" ON "public"."pm_completions" USING "btree" ("hotel_id", "completed_on" DESC);



CREATE INDEX "idx_pm_plans_hotel_due" ON "public"."pm_plans" USING "btree" ("hotel_id", "active", "next_due_on");



CREATE INDEX "idx_profiles_email" ON "public"."profiles" USING "btree" ("email");



CREATE INDEX "idx_profiles_role" ON "public"."profiles" USING "btree" ("role");



CREATE INDEX "idx_work_orders_hotel_created" ON "public"."work_orders" USING "btree" ("hotel_id", "created_at" DESC);



CREATE INDEX "inventory_items_reorder_idx" ON "public"."inventory_items" USING "btree" ("hotel_id", "quantity_on_hand", "reorder_level") WHERE ("active" = true);



CREATE INDEX "maintenance_documents_equipment_idx" ON "public"."maintenance_documents" USING "btree" ("hotel_id", "equipment");



CREATE INDEX "maintenance_documents_hotel_idx" ON "public"."maintenance_documents" USING "btree" ("hotel_id");



CREATE INDEX "maintenance_documents_ingestion_status_idx" ON "public"."maintenance_documents" USING "btree" ("hotel_id", "ingestion_status");



CREATE INDEX "maintenance_documents_manufacturer_idx" ON "public"."maintenance_documents" USING "btree" ("hotel_id", "manufacturer");



CREATE INDEX "operational_logs_date_idx" ON "public"."operational_log_entries" USING "btree" ("hotel_id", "log_date" DESC);



CREATE INDEX "pm_opportunities_work_order_idx" ON "public"."pm_opportunities" USING "btree" ("hotel_id", "work_order_id");



CREATE INDEX "pm_plans_due_idx" ON "public"."pm_plans" USING "btree" ("hotel_id", "next_due_on") WHERE ("active" = true);



CREATE INDEX "pool_daily_logs_hotel_date_idx" ON "public"."pool_daily_logs" USING "btree" ("hotel_id", "log_date" DESC);



CREATE INDEX "room_operations_hotel_report_idx" ON "public"."room_operations" USING "btree" ("hotel_id", "report_date");



CREATE UNIQUE INDEX "technicians_hotel_initials_idx" ON "public"."technicians" USING "btree" ("hotel_id", "upper"("initials")) WHERE ("initials" <> ''::"text");



CREATE INDEX "user_feedback_hotel_created_at_idx" ON "public"."user_feedback" USING "btree" ("hotel_id", "created_at" DESC);



CREATE INDEX "user_feedback_hotel_status_created_at_idx" ON "public"."user_feedback" USING "btree" ("hotel_id", "status", "created_at" DESC);



CREATE INDEX "vendor_proposals_asset_idx" ON "public"."vendor_proposals" USING "btree" ("hotel_id", "asset_id", "proposal_date" DESC);



CREATE INDEX "work_order_items_work_order_idx" ON "public"."work_order_items" USING "btree" ("hotel_id", "work_order_id");



CREATE INDEX "work_order_sources_fingerprint_idx" ON "public"."work_order_sources" USING "btree" ("hotel_id", "source_room", "issue_fingerprint");



CREATE INDEX "work_orders_hotel_room_idx" ON "public"."work_orders" USING "btree" ("hotel_id", "room");



CREATE INDEX "work_orders_hotel_status_idx" ON "public"."work_orders" USING "btree" ("hotel_id", "status");



CREATE OR REPLACE TRIGGER "cmpri_pm_proposal_stamp" BEFORE INSERT OR UPDATE ON "public"."cmpri_pm_proposals" FOR EACH ROW EXECUTE FUNCTION "public"."cmpri_pm_proposal_stamp"();



CREATE OR REPLACE TRIGGER "cmpri_pool_log_audit" AFTER INSERT OR UPDATE ON "public"."pool_daily_logs" FOR EACH ROW EXECUTE FUNCTION "public"."cmpri_audit_pool_log"();



CREATE OR REPLACE TRIGGER "cmpri_pool_log_stamp" BEFORE INSERT OR UPDATE ON "public"."pool_daily_logs" FOR EACH ROW EXECUTE FUNCTION "public"."cmpri_stamp_pool_log"();



CREATE OR REPLACE TRIGGER "cmpri_resolve_technician_view_notifications" AFTER UPDATE OF "status" ON "public"."work_orders" FOR EACH ROW EXECUTE FUNCTION "public"."cmpri_resolve_technician_view_notifications"();



CREATE OR REPLACE TRIGGER "cmpri_work_order_assignment_memory" BEFORE INSERT OR UPDATE OF "technician_name" ON "public"."work_orders" FOR EACH ROW EXECUTE FUNCTION "public"."cmpri_remember_work_order_technician"();



CREATE OR REPLACE TRIGGER "cmpri_work_order_display_id" BEFORE INSERT ON "public"."work_orders" FOR EACH ROW EXECUTE FUNCTION "public"."cmpri_assign_work_order_display_id"();



CREATE OR REPLACE TRIGGER "cmpri_work_order_revision" BEFORE INSERT OR UPDATE ON "public"."work_orders" FOR EACH ROW EXECUTE FUNCTION "public"."cmpri_bump_work_order_revision"();



CREATE OR REPLACE TRIGGER "cmpri_work_order_submitter" BEFORE INSERT ON "public"."work_orders" FOR EACH ROW EXECUTE FUNCTION "public"."cmpri_check_work_order_submitter"();



CREATE OR REPLACE TRIGGER "protect_work_order_creator_trigger" BEFORE UPDATE ON "public"."work_orders" FOR EACH ROW EXECUTE FUNCTION "public"."protect_work_order_creator"();



CREATE OR REPLACE TRIGGER "trg_assets_updated_at" BEFORE UPDATE ON "public"."assets" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_cmpri_asset_inventory_compatibility_updated_at" BEFORE UPDATE ON "public"."cmpri_asset_inventory_compatibility" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_cmpri_email_events_updated_at" BEFORE UPDATE ON "public"."cmpri_email_events" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_cmpri_enseo_tickets_updated_at" BEFORE UPDATE ON "public"."cmpri_enseo_tickets" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_cmpri_gss_reports_updated_at" BEFORE UPDATE ON "public"."cmpri_gss_reports" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_cmpri_inventory_items_updated_at" BEFORE UPDATE ON "public"."cmpri_inventory_items" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_cmpri_order_ideas_updated_at" BEFORE UPDATE ON "public"."cmpri_order_ideas" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_cmpri_purchase_shipments_updated_at" BEFORE UPDATE ON "public"."cmpri_purchase_shipments" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_cmpri_purchases_updated_at" BEFORE UPDATE ON "public"."cmpri_purchases" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_cmpri_supplier_followups_updated_at" BEFORE UPDATE ON "public"."cmpri_supplier_followups" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_cmpri_vendor_contacts_updated_at" BEFORE UPDATE ON "public"."cmpri_vendor_contacts" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_cmpri_vendor_proposals_updated_at" BEFORE UPDATE ON "public"."cmpri_vendor_proposals" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_cmpri_vendors_updated_at" BEFORE UPDATE ON "public"."cmpri_vendors" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_cmpri_warranty_cases_updated_at" BEFORE UPDATE ON "public"."cmpri_warranty_cases" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_cmpri_work_order_drafts_updated_at" BEFORE UPDATE ON "public"."cmpri_work_order_drafts" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_cmpri_work_order_items_updated_at" BEFORE UPDATE ON "public"."cmpri_work_order_items" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_hotel_members_updated_at" BEFORE UPDATE ON "public"."hotel_members" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_locations_updated_at" BEFORE UPDATE ON "public"."locations" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_pm_completions_updated_at" BEFORE UPDATE ON "public"."pm_completions" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_pm_plans_updated_at" BEFORE UPDATE ON "public"."pm_plans" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_pool_daily_logs_updated_at" BEFORE UPDATE ON "public"."pool_daily_logs" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_pool_facilities_updated_at" BEFORE UPDATE ON "public"."pool_facilities" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_profiles_updated_at" BEFORE UPDATE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_troubleshooting_cache_updated_at" BEFORE UPDATE ON "public"."troubleshooting_cache" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_work_orders_updated_at" BEFORE UPDATE ON "public"."work_orders" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



ALTER TABLE ONLY "public"."asset_inventory_compatibility"
    ADD CONSTRAINT "asset_inventory_compatibility_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."asset_inventory_compatibility"
    ADD CONSTRAINT "asset_inventory_compatibility_inventory_item_id_fkey" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."inventory_items"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."assets"
    ADD CONSTRAINT "assets_hotel_id_fkey" FOREIGN KEY ("hotel_id") REFERENCES "public"."hotels"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."assets"
    ADD CONSTRAINT "assets_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."cmpri_asset_inventory_compatibility"
    ADD CONSTRAINT "cmpri_asset_inventory_compatibility_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."cmpri_asset_inventory_compatibility"
    ADD CONSTRAINT "cmpri_asset_inventory_compatibility_inventory_item_id_fkey" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."cmpri_inventory_items"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."cmpri_enseo_assignment_history"
    ADD CONSTRAINT "cmpri_enseo_assignment_history_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."cmpri_enseo_assignment_history"
    ADD CONSTRAINT "cmpri_enseo_assignment_history_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."cmpri_enseo_assignment_history"
    ADD CONSTRAINT "cmpri_enseo_assignment_history_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "public"."cmpri_enseo_assignments"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."cmpri_enseo_assignment_history"
    ADD CONSTRAINT "cmpri_enseo_assignment_history_from_location_id_fkey" FOREIGN KEY ("from_location_id") REFERENCES "public"."locations"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."cmpri_enseo_assignment_history"
    ADD CONSTRAINT "cmpri_enseo_assignment_history_from_paired_asset_id_fkey" FOREIGN KEY ("from_paired_asset_id") REFERENCES "public"."assets"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."cmpri_enseo_assignment_history"
    ADD CONSTRAINT "cmpri_enseo_assignment_history_hotel_id_fkey" FOREIGN KEY ("hotel_id") REFERENCES "public"."hotels"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."cmpri_enseo_assignment_history"
    ADD CONSTRAINT "cmpri_enseo_assignment_history_to_location_id_fkey" FOREIGN KEY ("to_location_id") REFERENCES "public"."locations"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."cmpri_enseo_assignment_history"
    ADD CONSTRAINT "cmpri_enseo_assignment_history_to_paired_asset_id_fkey" FOREIGN KEY ("to_paired_asset_id") REFERENCES "public"."assets"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."cmpri_enseo_assignments"
    ADD CONSTRAINT "cmpri_enseo_assignments_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."cmpri_enseo_assignments"
    ADD CONSTRAINT "cmpri_enseo_assignments_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."cmpri_enseo_assignments"
    ADD CONSTRAINT "cmpri_enseo_assignments_hotel_id_fkey" FOREIGN KEY ("hotel_id") REFERENCES "public"."hotels"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."cmpri_enseo_assignments"
    ADD CONSTRAINT "cmpri_enseo_assignments_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."cmpri_enseo_assignments"
    ADD CONSTRAINT "cmpri_enseo_assignments_paired_asset_id_fkey" FOREIGN KEY ("paired_asset_id") REFERENCES "public"."assets"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."cmpri_enseo_assignments"
    ADD CONSTRAINT "cmpri_enseo_assignments_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."cmpri_enseo_tickets"
    ADD CONSTRAINT "cmpri_enseo_tickets_last_email_event_id_fkey" FOREIGN KEY ("last_email_event_id") REFERENCES "public"."cmpri_email_events"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."cmpri_enseo_tickets"
    ADD CONSTRAINT "cmpri_enseo_tickets_work_order_id_fkey" FOREIGN KEY ("work_order_id") REFERENCES "public"."work_orders"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."cmpri_gss_reports"
    ADD CONSTRAINT "cmpri_gss_reports_source_email_event_id_fkey" FOREIGN KEY ("source_email_event_id") REFERENCES "public"."cmpri_email_events"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."cmpri_inventory_movements"
    ADD CONSTRAINT "cmpri_inventory_movements_hotel_id_fkey" FOREIGN KEY ("hotel_id") REFERENCES "public"."hotels"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."cmpri_inventory_movements"
    ADD CONSTRAINT "cmpri_inventory_movements_inventory_item_id_fkey" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."cmpri_inventory_items"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."cmpri_inventory_movements"
    ADD CONSTRAINT "cmpri_inventory_movements_performed_by_user_id_fkey" FOREIGN KEY ("performed_by_user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."cmpri_inventory_movements"
    ADD CONSTRAINT "cmpri_inventory_movements_work_order_item_id_fkey" FOREIGN KEY ("work_order_item_id") REFERENCES "public"."cmpri_work_order_items"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."cmpri_mcp_oauth_codes"
    ADD CONSTRAINT "cmpri_mcp_oauth_codes_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."cmpri_mcp_oauth_clients"("client_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."cmpri_mcp_oauth_codes"
    ADD CONSTRAINT "cmpri_mcp_oauth_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."cmpri_mcp_oauth_tokens"
    ADD CONSTRAINT "cmpri_mcp_oauth_tokens_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."cmpri_mcp_oauth_clients"("client_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."cmpri_mcp_oauth_tokens"
    ADD CONSTRAINT "cmpri_mcp_oauth_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."cmpri_personal_mcp_links"
    ADD CONSTRAINT "cmpri_personal_mcp_links_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."cmpri_pm_proposals"
    ADD CONSTRAINT "cmpri_pm_proposals_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."cmpri_pm_proposals"
    ADD CONSTRAINT "cmpri_pm_proposals_submitted_by_fkey" FOREIGN KEY ("submitted_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."cmpri_pool_log_history"
    ADD CONSTRAINT "cmpri_pool_log_history_pool_log_id_fkey" FOREIGN KEY ("pool_log_id") REFERENCES "public"."pool_daily_logs"("id");



ALTER TABLE ONLY "public"."cmpri_purchase_shipments"
    ADD CONSTRAINT "cmpri_purchase_shipments_last_email_event_id_fkey" FOREIGN KEY ("last_email_event_id") REFERENCES "public"."cmpri_email_events"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."cmpri_purchase_shipments"
    ADD CONSTRAINT "cmpri_purchase_shipments_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "public"."cmpri_purchases"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."cmpri_purchases"
    ADD CONSTRAINT "cmpri_purchases_last_email_event_id_fkey" FOREIGN KEY ("last_email_event_id") REFERENCES "public"."cmpri_email_events"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."cmpri_purchases"
    ADD CONSTRAINT "cmpri_purchases_work_order_id_fkey" FOREIGN KEY ("work_order_id") REFERENCES "public"."work_orders"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."cmpri_supplier_followups"
    ADD CONSTRAINT "cmpri_supplier_followups_last_email_event_id_fkey" FOREIGN KEY ("last_email_event_id") REFERENCES "public"."cmpri_email_events"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."cmpri_supplier_followups"
    ADD CONSTRAINT "cmpri_supplier_followups_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "public"."cmpri_purchases"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."cmpri_supplier_followups"
    ADD CONSTRAINT "cmpri_supplier_followups_work_order_id_fkey" FOREIGN KEY ("work_order_id") REFERENCES "public"."work_orders"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."cmpri_vendor_contacts"
    ADD CONSTRAINT "cmpri_vendor_contacts_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "public"."cmpri_vendors"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."cmpri_vendor_proposals"
    ADD CONSTRAINT "cmpri_vendor_proposals_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "public"."cmpri_vendors"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."cmpri_warranty_cases"
    ADD CONSTRAINT "cmpri_warranty_cases_last_email_event_id_fkey" FOREIGN KEY ("last_email_event_id") REFERENCES "public"."cmpri_email_events"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."cmpri_warranty_cases"
    ADD CONSTRAINT "cmpri_warranty_cases_work_order_id_fkey" FOREIGN KEY ("work_order_id") REFERENCES "public"."work_orders"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."cmpri_work_order_drafts"
    ADD CONSTRAINT "cmpri_work_order_drafts_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."cmpri_work_order_drafts"
    ADD CONSTRAINT "cmpri_work_order_drafts_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."cmpri_work_order_drafts"
    ADD CONSTRAINT "cmpri_work_order_drafts_hotel_id_fkey" FOREIGN KEY ("hotel_id") REFERENCES "public"."hotels"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."cmpri_work_order_drafts"
    ADD CONSTRAINT "cmpri_work_order_drafts_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."cmpri_work_order_items"
    ADD CONSTRAINT "cmpri_work_order_items_inventory_item_id_fkey" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."cmpri_inventory_items"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."cmpri_work_order_items"
    ADD CONSTRAINT "cmpri_work_order_items_work_order_id_fkey" FOREIGN KEY ("work_order_id") REFERENCES "public"."work_orders"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."cmpri_work_order_technician_views"
    ADD CONSTRAINT "cmpri_work_order_technician_views_technician_user_id_fkey" FOREIGN KEY ("technician_user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."cmpri_work_order_technician_views"
    ADD CONSTRAINT "cmpri_work_order_technician_views_work_order_id_fkey" FOREIGN KEY ("work_order_id") REFERENCES "public"."work_orders"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."corporate_pm_reports"
    ADD CONSTRAINT "corporate_pm_reports_generated_by_fkey" FOREIGN KEY ("generated_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."corporate_pm_reports"
    ADD CONSTRAINT "corporate_pm_reports_hotel_id_fkey" FOREIGN KEY ("hotel_id") REFERENCES "public"."hotels"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."documents"
    ADD CONSTRAINT "documents_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."documents"
    ADD CONSTRAINT "documents_hotel_id_fkey" FOREIGN KEY ("hotel_id") REFERENCES "public"."hotels"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."hotel_members"
    ADD CONSTRAINT "hotel_members_hotel_id_fkey" FOREIGN KEY ("hotel_id") REFERENCES "public"."hotels"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."hotel_members"
    ADD CONSTRAINT "hotel_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."inventory_items"
    ADD CONSTRAINT "inventory_items_hotel_id_fkey" FOREIGN KEY ("hotel_id") REFERENCES "public"."hotels"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."inventory_items"
    ADD CONSTRAINT "inventory_items_preferred_vendor_id_fkey" FOREIGN KEY ("preferred_vendor_id") REFERENCES "public"."vendors"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."inventory_movements"
    ADD CONSTRAINT "inventory_movements_hotel_id_fkey" FOREIGN KEY ("hotel_id") REFERENCES "public"."hotels"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."inventory_movements"
    ADD CONSTRAINT "inventory_movements_inventory_item_id_fkey" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."inventory_items"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."inventory_movements"
    ADD CONSTRAINT "inventory_movements_performed_by_fkey" FOREIGN KEY ("performed_by") REFERENCES "public"."technicians"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."inventory_movements"
    ADD CONSTRAINT "inventory_movements_work_order_item_id_fkey" FOREIGN KEY ("work_order_item_id") REFERENCES "public"."work_order_items"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."locations"
    ADD CONSTRAINT "locations_hotel_id_fkey" FOREIGN KEY ("hotel_id") REFERENCES "public"."hotels"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."maintenance_documents"
    ADD CONSTRAINT "maintenance_documents_hotel_id_fkey" FOREIGN KEY ("hotel_id") REFERENCES "public"."hotels"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."manual_ingestion_runs"
    ADD CONSTRAINT "manual_ingestion_runs_hotel_id_fkey" FOREIGN KEY ("hotel_id") REFERENCES "public"."hotels"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."operational_log_entries"
    ADD CONSTRAINT "operational_log_entries_entered_by_fkey" FOREIGN KEY ("entered_by") REFERENCES "public"."technicians"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."operational_log_entries"
    ADD CONSTRAINT "operational_log_entries_hotel_id_fkey" FOREIGN KEY ("hotel_id") REFERENCES "public"."hotels"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."operational_log_entries"
    ADD CONSTRAINT "operational_log_entries_linked_work_order_id_fkey" FOREIGN KEY ("linked_work_order_id") REFERENCES "public"."work_orders"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."operational_log_entries"
    ADD CONSTRAINT "operational_log_entries_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."operational_log_entries"
    ADD CONSTRAINT "operational_log_entries_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "public"."operational_log_templates"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."operational_log_templates"
    ADD CONSTRAINT "operational_log_templates_hotel_id_fkey" FOREIGN KEY ("hotel_id") REFERENCES "public"."hotels"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."operational_log_templates"
    ADD CONSTRAINT "operational_log_templates_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pm_completions"
    ADD CONSTRAINT "pm_completions_completed_by_fkey" FOREIGN KEY ("completed_by") REFERENCES "public"."technicians"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."pm_completions"
    ADD CONSTRAINT "pm_completions_hotel_id_fkey" FOREIGN KEY ("hotel_id") REFERENCES "public"."hotels"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pm_completions"
    ADD CONSTRAINT "pm_completions_linked_work_order_id_fkey" FOREIGN KEY ("linked_work_order_id") REFERENCES "public"."work_orders"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."pm_completions"
    ADD CONSTRAINT "pm_completions_pm_plan_id_fkey" FOREIGN KEY ("pm_plan_id") REFERENCES "public"."pm_plans"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pm_opportunities"
    ADD CONSTRAINT "pm_opportunities_acknowledged_by_fkey" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."technicians"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."pm_opportunities"
    ADD CONSTRAINT "pm_opportunities_hotel_id_fkey" FOREIGN KEY ("hotel_id") REFERENCES "public"."hotels"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pm_opportunities"
    ADD CONSTRAINT "pm_opportunities_pm_plan_id_fkey" FOREIGN KEY ("pm_plan_id") REFERENCES "public"."pm_plans"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pm_opportunities"
    ADD CONSTRAINT "pm_opportunities_work_order_id_fkey" FOREIGN KEY ("work_order_id") REFERENCES "public"."work_orders"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pm_plans"
    ADD CONSTRAINT "pm_plans_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pm_plans"
    ADD CONSTRAINT "pm_plans_hotel_id_fkey" FOREIGN KEY ("hotel_id") REFERENCES "public"."hotels"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pm_plans"
    ADD CONSTRAINT "pm_plans_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pool_chemical_orders"
    ADD CONSTRAINT "pool_chemical_orders_chemical_id_fkey" FOREIGN KEY ("chemical_id") REFERENCES "public"."pool_chemicals"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."pool_chemical_orders"
    ADD CONSTRAINT "pool_chemical_orders_hotel_id_fkey" FOREIGN KEY ("hotel_id") REFERENCES "public"."hotels"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pool_chemical_orders"
    ADD CONSTRAINT "pool_chemical_orders_ordered_by_fkey" FOREIGN KEY ("ordered_by") REFERENCES "public"."technicians"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."pool_chemical_price_checks"
    ADD CONSTRAINT "pool_chemical_price_checks_chemical_id_fkey" FOREIGN KEY ("chemical_id") REFERENCES "public"."pool_chemicals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pool_chemical_price_checks"
    ADD CONSTRAINT "pool_chemical_price_checks_hotel_id_fkey" FOREIGN KEY ("hotel_id") REFERENCES "public"."hotels"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pool_chemical_usage"
    ADD CONSTRAINT "pool_chemical_usage_applied_by_fkey" FOREIGN KEY ("applied_by") REFERENCES "public"."technicians"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."pool_chemical_usage"
    ADD CONSTRAINT "pool_chemical_usage_chemical_id_fkey" FOREIGN KEY ("chemical_id") REFERENCES "public"."pool_chemicals"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."pool_chemical_usage"
    ADD CONSTRAINT "pool_chemical_usage_hotel_id_fkey" FOREIGN KEY ("hotel_id") REFERENCES "public"."hotels"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pool_chemical_usage"
    ADD CONSTRAINT "pool_chemical_usage_pool_facility_id_fkey" FOREIGN KEY ("pool_facility_id") REFERENCES "public"."pool_facilities"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pool_chemical_usage"
    ADD CONSTRAINT "pool_chemical_usage_pool_log_id_fkey" FOREIGN KEY ("pool_log_id") REFERENCES "public"."pool_daily_logs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."pool_chemicals"
    ADD CONSTRAINT "pool_chemicals_hotel_id_fkey" FOREIGN KEY ("hotel_id") REFERENCES "public"."hotels"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pool_chemicals"
    ADD CONSTRAINT "pool_chemicals_pool_facility_id_fkey" FOREIGN KEY ("pool_facility_id") REFERENCES "public"."pool_facilities"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pool_compliance_requirements"
    ADD CONSTRAINT "pool_compliance_requirements_hotel_id_fkey" FOREIGN KEY ("hotel_id") REFERENCES "public"."hotels"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pool_compliance_requirements"
    ADD CONSTRAINT "pool_compliance_requirements_pool_facility_id_fkey" FOREIGN KEY ("pool_facility_id") REFERENCES "public"."pool_facilities"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pool_daily_logs"
    ADD CONSTRAINT "pool_daily_logs_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."pool_daily_logs"
    ADD CONSTRAINT "pool_daily_logs_hotel_id_fkey" FOREIGN KEY ("hotel_id") REFERENCES "public"."hotels"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pool_daily_logs"
    ADD CONSTRAINT "pool_daily_logs_linked_work_order_id_fkey" FOREIGN KEY ("linked_work_order_id") REFERENCES "public"."work_orders"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."pool_daily_logs"
    ADD CONSTRAINT "pool_daily_logs_pool_facility_id_fkey" FOREIGN KEY ("pool_facility_id") REFERENCES "public"."pool_facilities"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pool_documents"
    ADD CONSTRAINT "pool_documents_chemical_id_fkey" FOREIGN KEY ("chemical_id") REFERENCES "public"."pool_chemicals"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."pool_documents"
    ADD CONSTRAINT "pool_documents_equipment_id_fkey" FOREIGN KEY ("equipment_id") REFERENCES "public"."pool_equipment"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."pool_documents"
    ADD CONSTRAINT "pool_documents_hotel_id_fkey" FOREIGN KEY ("hotel_id") REFERENCES "public"."hotels"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pool_documents"
    ADD CONSTRAINT "pool_documents_pool_facility_id_fkey" FOREIGN KEY ("pool_facility_id") REFERENCES "public"."pool_facilities"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pool_documents"
    ADD CONSTRAINT "pool_documents_requirement_id_fkey" FOREIGN KEY ("requirement_id") REFERENCES "public"."pool_compliance_requirements"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."pool_documents"
    ADD CONSTRAINT "pool_documents_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."pool_equipment"
    ADD CONSTRAINT "pool_equipment_hotel_id_fkey" FOREIGN KEY ("hotel_id") REFERENCES "public"."hotels"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pool_equipment"
    ADD CONSTRAINT "pool_equipment_pool_facility_id_fkey" FOREIGN KEY ("pool_facility_id") REFERENCES "public"."pool_facilities"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pool_facilities"
    ADD CONSTRAINT "pool_facilities_hotel_id_fkey" FOREIGN KEY ("hotel_id") REFERENCES "public"."hotels"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."room_operations"
    ADD CONSTRAINT "room_operations_hotel_id_fkey" FOREIGN KEY ("hotel_id") REFERENCES "public"."hotels"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."technicians"
    ADD CONSTRAINT "technicians_hotel_id_fkey" FOREIGN KEY ("hotel_id") REFERENCES "public"."hotels"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."technicians"
    ADD CONSTRAINT "technicians_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."troubleshooting_cache"
    ADD CONSTRAINT "troubleshooting_cache_hotel_id_fkey" FOREIGN KEY ("hotel_id") REFERENCES "public"."hotels"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."troubleshooting_cache"
    ADD CONSTRAINT "troubleshooting_cache_work_order_id_fkey" FOREIGN KEY ("work_order_id") REFERENCES "public"."work_orders"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_feedback"
    ADD CONSTRAINT "user_feedback_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_profiles"
    ADD CONSTRAINT "user_profiles_associate_id_fkey" FOREIGN KEY ("associate_id") REFERENCES "public"."technicians"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."user_profiles"
    ADD CONSTRAINT "user_profiles_hotel_id_fkey" FOREIGN KEY ("hotel_id") REFERENCES "public"."hotels"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_profiles"
    ADD CONSTRAINT "user_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."vendor_contacts"
    ADD CONSTRAINT "vendor_contacts_hotel_id_fkey" FOREIGN KEY ("hotel_id") REFERENCES "public"."hotels"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."vendor_contacts"
    ADD CONSTRAINT "vendor_contacts_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."vendor_proposals"
    ADD CONSTRAINT "vendor_proposals_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."vendor_proposals"
    ADD CONSTRAINT "vendor_proposals_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."vendor_proposals"
    ADD CONSTRAINT "vendor_proposals_hotel_id_fkey" FOREIGN KEY ("hotel_id") REFERENCES "public"."hotels"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."vendor_proposals"
    ADD CONSTRAINT "vendor_proposals_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."vendor_proposals"
    ADD CONSTRAINT "vendor_proposals_vendor_contact_id_fkey" FOREIGN KEY ("vendor_contact_id") REFERENCES "public"."vendor_contacts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."vendor_proposals"
    ADD CONSTRAINT "vendor_proposals_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."vendor_proposals"
    ADD CONSTRAINT "vendor_proposals_work_order_id_fkey" FOREIGN KEY ("work_order_id") REFERENCES "public"."work_orders"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."vendors"
    ADD CONSTRAINT "vendors_hotel_id_fkey" FOREIGN KEY ("hotel_id") REFERENCES "public"."hotels"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."work_order_creator_audit"
    ADD CONSTRAINT "work_order_creator_audit_corrected_by_fkey" FOREIGN KEY ("corrected_by") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."work_order_creator_audit"
    ADD CONSTRAINT "work_order_creator_audit_hotel_id_fkey" FOREIGN KEY ("hotel_id") REFERENCES "public"."hotels"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."work_order_creator_audit"
    ADD CONSTRAINT "work_order_creator_audit_work_order_id_fkey" FOREIGN KEY ("work_order_id") REFERENCES "public"."work_orders"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."work_order_items"
    ADD CONSTRAINT "work_order_items_hotel_id_fkey" FOREIGN KEY ("hotel_id") REFERENCES "public"."hotels"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."work_order_items"
    ADD CONSTRAINT "work_order_items_inventory_item_id_fkey" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."inventory_items"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."work_order_items"
    ADD CONSTRAINT "work_order_items_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "public"."technicians"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."work_order_items"
    ADD CONSTRAINT "work_order_items_work_order_id_fkey" FOREIGN KEY ("work_order_id") REFERENCES "public"."work_orders"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."work_order_sources"
    ADD CONSTRAINT "work_order_sources_hotel_id_fkey" FOREIGN KEY ("hotel_id") REFERENCES "public"."hotels"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."work_order_sources"
    ADD CONSTRAINT "work_order_sources_work_order_id_fkey" FOREIGN KEY ("work_order_id") REFERENCES "public"."work_orders"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."work_orders"
    ADD CONSTRAINT "work_orders_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."work_orders"
    ADD CONSTRAINT "work_orders_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."work_orders"
    ADD CONSTRAINT "work_orders_creator_account_user_id_fkey" FOREIGN KEY ("creator_account_user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."work_orders"
    ADD CONSTRAINT "work_orders_hotel_id_fkey" FOREIGN KEY ("hotel_id") REFERENCES "public"."hotels"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."work_orders"
    ADD CONSTRAINT "work_orders_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."work_orders"
    ADD CONSTRAINT "work_orders_source_draft_created_by_fkey" FOREIGN KEY ("source_draft_created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."work_orders"
    ADD CONSTRAINT "work_orders_submitted_by_user_id_fkey" FOREIGN KEY ("submitted_by_user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."work_orders"
    ADD CONSTRAINT "work_orders_technician_id_fkey" FOREIGN KEY ("technician_id") REFERENCES "public"."technicians"("id") ON DELETE SET NULL;



CREATE POLICY "Authenticated users can create work orders" ON "public"."work_orders" FOR INSERT TO "authenticated" WITH CHECK (("auth"."uid"() = "created_by"));



CREATE POLICY "Authenticated users can read profiles" ON "public"."profiles" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Authenticated users can read role permissions" ON "public"."role_permissions" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Authenticated users can read work orders" ON "public"."work_orders" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."asset_inventory_compatibility" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "asset_inventory_member_access" ON "public"."asset_inventory_compatibility" USING ((EXISTS ( SELECT 1
   FROM "public"."assets" "a"
  WHERE (("a"."id" = "asset_inventory_compatibility"."asset_id") AND "public"."is_hotel_member"("a"."hotel_id"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."assets" "a"
  WHERE (("a"."id" = "asset_inventory_compatibility"."asset_id") AND "public"."is_hotel_member"("a"."hotel_id")))));



ALTER TABLE "public"."assets" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "assets_member_access" ON "public"."assets" USING ("public"."is_hotel_member"("hotel_id")) WITH CHECK ("public"."is_hotel_member"("hotel_id"));



ALTER TABLE "public"."cmpri_asset_inventory_compatibility" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."cmpri_email_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."cmpri_enseo_assignment_history" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."cmpri_enseo_assignments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."cmpri_enseo_tickets" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."cmpri_gss_reports" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."cmpri_inventory_items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."cmpri_inventory_movements" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."cmpri_mcp_oauth_clients" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."cmpri_mcp_oauth_codes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."cmpri_mcp_oauth_tokens" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."cmpri_order_ideas" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."cmpri_personal_mcp_links" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."cmpri_pm_proposals" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "cmpri_pm_proposals_member_insert" ON "public"."cmpri_pm_proposals" FOR INSERT TO "authenticated" WITH CHECK ((("hotel_id" = 'c81ad01a-7a9f-4880-ac1c-5e849f30bad6'::"uuid") AND ("status" = 'pending'::"text") AND ("submitted_by" = "auth"."uid"()) AND (EXISTS ( SELECT 1
   FROM ("public"."profiles" "p"
     JOIN "public"."hotel_members" "hm" ON (("hm"."user_id" = "p"."id")))
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."active" = true) AND ("hm"."hotel_id" = "cmpri_pm_proposals"."hotel_id") AND ("hm"."active" = true) AND ("regexp_replace"("lower"("p"."role"), '[^a-z]'::"text", ''::"text", 'g'::"text") = ANY (ARRAY['engineer'::"text", 'chiefengineer'::"text", 'engineeringmanager'::"text", 'regionalmaintenance'::"text", 'technician'::"text", 'maintenancetechnician'::"text", 'systemadmin'::"text", 'systemadministrator'::"text", 'administrator'::"text", 'admin'::"text"])))))));



CREATE POLICY "cmpri_pm_proposals_member_read" ON "public"."cmpri_pm_proposals" FOR SELECT TO "authenticated" USING ((("hotel_id" = 'c81ad01a-7a9f-4880-ac1c-5e849f30bad6'::"uuid") AND (EXISTS ( SELECT 1
   FROM ("public"."profiles" "p"
     JOIN "public"."hotel_members" "hm" ON (("hm"."user_id" = "p"."id")))
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."active" = true) AND ("hm"."hotel_id" = "cmpri_pm_proposals"."hotel_id") AND ("hm"."active" = true))))));



CREATE POLICY "cmpri_pm_proposals_reviewer_update" ON "public"."cmpri_pm_proposals" FOR UPDATE TO "authenticated" USING ((("hotel_id" = 'c81ad01a-7a9f-4880-ac1c-5e849f30bad6'::"uuid") AND ("status" = ANY (ARRAY['pending'::"text", 'processing'::"text"])) AND (EXISTS ( SELECT 1
   FROM ("public"."profiles" "p"
     JOIN "public"."hotel_members" "hm" ON (("hm"."user_id" = "p"."id")))
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."active" = true) AND ("hm"."hotel_id" = "cmpri_pm_proposals"."hotel_id") AND ("hm"."active" = true) AND ("regexp_replace"("lower"("p"."role"), '[^a-z]'::"text", ''::"text", 'g'::"text") = ANY (ARRAY['systemadmin'::"text", 'systemadministrator'::"text", 'administrator'::"text", 'admin'::"text"]))))))) WITH CHECK ((("hotel_id" = 'c81ad01a-7a9f-4880-ac1c-5e849f30bad6'::"uuid") AND ("status" = ANY (ARRAY['pending'::"text", 'processing'::"text", 'approved'::"text", 'rejected'::"text"])) AND ((("status" = ANY (ARRAY['pending'::"text", 'processing'::"text"])) AND (("reviewed_by" IS NULL) OR ("reviewed_by" = "auth"."uid"()))) OR (("status" = ANY (ARRAY['approved'::"text", 'rejected'::"text"])) AND ("reviewed_by" = "auth"."uid"())))));



CREATE POLICY "cmpri_pm_proposals_submitter_update" ON "public"."cmpri_pm_proposals" FOR UPDATE TO "authenticated" USING ((("hotel_id" = 'c81ad01a-7a9f-4880-ac1c-5e849f30bad6'::"uuid") AND ("submitted_by" = "auth"."uid"()) AND ("status" = 'pending'::"text"))) WITH CHECK ((("hotel_id" = 'c81ad01a-7a9f-4880-ac1c-5e849f30bad6'::"uuid") AND ("submitted_by" = "auth"."uid"()) AND ("status" = 'pending'::"text")));



ALTER TABLE "public"."cmpri_pool_log_history" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."cmpri_purchase_shipments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."cmpri_purchases" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."cmpri_supplier_followups" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."cmpri_vendor_contacts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."cmpri_vendor_proposals" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."cmpri_vendors" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."cmpri_warranty_cases" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."cmpri_work_order_drafts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "cmpri_work_order_drafts_owner_select" ON "public"."cmpri_work_order_drafts" FOR SELECT USING ((("created_by" = "auth"."uid"()) AND (EXISTS ( SELECT 1
   FROM "public"."hotel_members" "m"
  WHERE (("m"."user_id" = "auth"."uid"()) AND ("m"."hotel_id" = "m"."hotel_id") AND ("m"."active" = true))))));



CREATE POLICY "cmpri_work_order_drafts_owner_write" ON "public"."cmpri_work_order_drafts" USING ((("created_by" = "auth"."uid"()) AND (EXISTS ( SELECT 1
   FROM "public"."hotel_members" "m"
  WHERE (("m"."user_id" = "auth"."uid"()) AND ("m"."hotel_id" = "m"."hotel_id") AND ("m"."active" = true)))))) WITH CHECK ((("created_by" = "auth"."uid"()) AND (EXISTS ( SELECT 1
   FROM "public"."hotel_members" "m"
  WHERE (("m"."user_id" = "auth"."uid"()) AND ("m"."hotel_id" = "m"."hotel_id") AND ("m"."active" = true))))));



ALTER TABLE "public"."cmpri_work_order_items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."cmpri_work_order_technician_views" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."corporate_pm_reports" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "corporate_pm_reports_member_access" ON "public"."corporate_pm_reports" USING ("public"."is_hotel_member"("hotel_id")) WITH CHECK ("public"."is_hotel_member"("hotel_id"));



CREATE POLICY "creator_audit_admin_insert" ON "public"."work_order_creator_audit" FOR INSERT WITH CHECK ("public"."can_manage_hotel"("hotel_id"));



CREATE POLICY "creator_audit_member_access" ON "public"."work_order_creator_audit" FOR SELECT USING ("public"."is_hotel_member"("hotel_id"));



ALTER TABLE "public"."documents" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "documents_manage" ON "public"."documents" USING ((("hotel_id" IS NOT NULL) AND "public"."can_manage_hotel"("hotel_id"))) WITH CHECK ((("hotel_id" IS NOT NULL) AND "public"."can_manage_hotel"("hotel_id")));



CREATE POLICY "documents_select" ON "public"."documents" FOR SELECT USING ((("auth"."uid"() IS NOT NULL) AND (("hotel_id" IS NULL) OR "public"."is_hotel_member"("hotel_id"))));



ALTER TABLE "public"."hotel_members" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."hotels" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "hotels_select" ON "public"."hotels" FOR SELECT USING ("public"."is_hotel_member"("id"));



ALTER TABLE "public"."inventory_items" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "inventory_items_member_access" ON "public"."inventory_items" USING ("public"."is_hotel_member"("hotel_id")) WITH CHECK ("public"."is_hotel_member"("hotel_id"));



ALTER TABLE "public"."inventory_movements" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "inventory_movements_member_access" ON "public"."inventory_movements" USING ("public"."is_hotel_member"("hotel_id")) WITH CHECK ("public"."is_hotel_member"("hotel_id"));



ALTER TABLE "public"."locations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "locations_member_access" ON "public"."locations" USING ("public"."is_hotel_member"("hotel_id")) WITH CHECK ("public"."is_hotel_member"("hotel_id"));



ALTER TABLE "public"."maintenance_documents" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "maintenance_documents_member_access" ON "public"."maintenance_documents" USING ("public"."is_hotel_member"("hotel_id")) WITH CHECK ("public"."is_hotel_member"("hotel_id"));



ALTER TABLE "public"."manual_ingestion_runs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "manual_ingestion_runs_member_access" ON "public"."manual_ingestion_runs" USING ("public"."is_hotel_member"("hotel_id")) WITH CHECK ("public"."is_hotel_member"("hotel_id"));



CREATE POLICY "members_manage" ON "public"."hotel_members" USING ("public"."can_manage_hotel"("hotel_id")) WITH CHECK ("public"."can_manage_hotel"("hotel_id"));



CREATE POLICY "members_select" ON "public"."hotel_members" FOR SELECT USING ("public"."is_hotel_member"("hotel_id"));



CREATE POLICY "operational_entries_member_access" ON "public"."operational_log_entries" USING ("public"."is_hotel_member"("hotel_id")) WITH CHECK ("public"."is_hotel_member"("hotel_id"));



ALTER TABLE "public"."operational_log_entries" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."operational_log_templates" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "operational_templates_member_access" ON "public"."operational_log_templates" USING ("public"."is_hotel_member"("hotel_id")) WITH CHECK ("public"."is_hotel_member"("hotel_id"));



ALTER TABLE "public"."pm_completions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pm_completions_member_access" ON "public"."pm_completions" USING ("public"."is_hotel_member"("hotel_id")) WITH CHECK ("public"."is_hotel_member"("hotel_id"));



ALTER TABLE "public"."pm_opportunities" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pm_opportunities_member_access" ON "public"."pm_opportunities" USING ("public"."is_hotel_member"("hotel_id")) WITH CHECK ("public"."is_hotel_member"("hotel_id"));



ALTER TABLE "public"."pm_plans" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pm_plans_member_access" ON "public"."pm_plans" USING ("public"."is_hotel_member"("hotel_id")) WITH CHECK ("public"."is_hotel_member"("hotel_id"));



ALTER TABLE "public"."pool_chemical_orders" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pool_chemical_orders_member_access" ON "public"."pool_chemical_orders" USING ("public"."is_hotel_member"("hotel_id")) WITH CHECK ("public"."is_hotel_member"("hotel_id"));



ALTER TABLE "public"."pool_chemical_price_checks" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pool_chemical_price_checks_member_access" ON "public"."pool_chemical_price_checks" USING ("public"."is_hotel_member"("hotel_id")) WITH CHECK ("public"."is_hotel_member"("hotel_id"));



ALTER TABLE "public"."pool_chemical_usage" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pool_chemical_usage_member_access" ON "public"."pool_chemical_usage" USING ("public"."is_hotel_member"("hotel_id")) WITH CHECK ("public"."is_hotel_member"("hotel_id"));



ALTER TABLE "public"."pool_chemicals" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pool_chemicals_member_access" ON "public"."pool_chemicals" USING ("public"."is_hotel_member"("hotel_id")) WITH CHECK ("public"."is_hotel_member"("hotel_id"));



ALTER TABLE "public"."pool_compliance_requirements" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pool_compliance_requirements_member_access" ON "public"."pool_compliance_requirements" USING ("public"."is_hotel_member"("hotel_id")) WITH CHECK ("public"."is_hotel_member"("hotel_id"));



ALTER TABLE "public"."pool_daily_logs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pool_daily_logs_member_access" ON "public"."pool_daily_logs" USING ("public"."is_hotel_member"("hotel_id")) WITH CHECK ("public"."is_hotel_member"("hotel_id"));



ALTER TABLE "public"."pool_documents" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pool_documents_member_access" ON "public"."pool_documents" USING ("public"."is_hotel_member"("hotel_id")) WITH CHECK ("public"."is_hotel_member"("hotel_id"));



ALTER TABLE "public"."pool_equipment" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pool_equipment_member_access" ON "public"."pool_equipment" USING ("public"."is_hotel_member"("hotel_id")) WITH CHECK ("public"."is_hotel_member"("hotel_id"));



ALTER TABLE "public"."pool_facilities" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pool_facilities_member_access" ON "public"."pool_facilities" USING ("public"."is_hotel_member"("hotel_id")) WITH CHECK ("public"."is_hotel_member"("hotel_id"));



ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."role_permissions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."room_operations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "room_operations_member_access" ON "public"."room_operations" USING ("public"."is_hotel_member"("hotel_id")) WITH CHECK ("public"."is_hotel_member"("hotel_id"));



ALTER TABLE "public"."technicians" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "technicians_member_access" ON "public"."technicians" USING ("public"."is_hotel_member"("hotel_id")) WITH CHECK ("public"."is_hotel_member"("hotel_id"));



ALTER TABLE "public"."troubleshooting_cache" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "troubleshooting_member_access" ON "public"."troubleshooting_cache" USING ("public"."is_hotel_member"("hotel_id")) WITH CHECK ("public"."is_hotel_member"("hotel_id"));



ALTER TABLE "public"."user_feedback" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "user_feedback_delete_reviewers" ON "public"."user_feedback" FOR DELETE TO "authenticated" USING ((("hotel_id" = 'c81ad01a-7a9f-4880-ac1c-5e849f30bad6'::"uuid") AND (EXISTS ( SELECT 1
   FROM ("public"."profiles" "p"
     JOIN "public"."hotel_members" "hm" ON (("hm"."user_id" = "p"."id")))
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."active" = true) AND ("hm"."hotel_id" = "user_feedback"."hotel_id") AND ("hm"."active" = true) AND ("regexp_replace"("lower"("p"."role"), '[^a-z]'::"text", ''::"text", 'g'::"text") = ANY (ARRAY['engineer'::"text", 'chiefengineer'::"text", 'systemadmin'::"text", 'systemadministrator'::"text", 'administrator'::"text", 'admin'::"text"])))))));



CREATE POLICY "user_feedback_read_own" ON "public"."user_feedback" FOR SELECT TO "authenticated" USING ((("user_id" = "auth"."uid"()) AND ("hotel_id" = 'c81ad01a-7a9f-4880-ac1c-5e849f30bad6'::"uuid") AND (EXISTS ( SELECT 1
   FROM ("public"."profiles" "p"
     JOIN "public"."hotel_members" "hm" ON (("hm"."user_id" = "p"."id")))
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."active" = true) AND ("hm"."hotel_id" = "user_feedback"."hotel_id") AND ("hm"."active" = true))))));



CREATE POLICY "user_feedback_read_reviewers" ON "public"."user_feedback" FOR SELECT TO "authenticated" USING ((("hotel_id" = 'c81ad01a-7a9f-4880-ac1c-5e849f30bad6'::"uuid") AND (EXISTS ( SELECT 1
   FROM ("public"."profiles" "p"
     JOIN "public"."hotel_members" "hm" ON (("hm"."user_id" = "p"."id")))
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."active" = true) AND ("hm"."hotel_id" = "user_feedback"."hotel_id") AND ("hm"."active" = true) AND ("regexp_replace"("lower"("p"."role"), '[^a-z]'::"text", ''::"text", 'g'::"text") = ANY (ARRAY['engineer'::"text", 'chiefengineer'::"text", 'systemadmin'::"text", 'systemadministrator'::"text", 'administrator'::"text", 'admin'::"text"])))))));



CREATE POLICY "user_feedback_update_reviewers" ON "public"."user_feedback" FOR UPDATE TO "authenticated" USING ((("hotel_id" = 'c81ad01a-7a9f-4880-ac1c-5e849f30bad6'::"uuid") AND (EXISTS ( SELECT 1
   FROM ("public"."profiles" "p"
     JOIN "public"."hotel_members" "hm" ON (("hm"."user_id" = "p"."id")))
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."active" = true) AND ("hm"."hotel_id" = "user_feedback"."hotel_id") AND ("hm"."active" = true) AND ("regexp_replace"("lower"("p"."role"), '[^a-z]'::"text", ''::"text", 'g'::"text") = ANY (ARRAY['engineer'::"text", 'chiefengineer'::"text", 'systemadmin'::"text", 'systemadministrator'::"text", 'administrator'::"text", 'admin'::"text"]))))))) WITH CHECK ((("hotel_id" = 'c81ad01a-7a9f-4880-ac1c-5e849f30bad6'::"uuid") AND (EXISTS ( SELECT 1
   FROM ("public"."profiles" "p"
     JOIN "public"."hotel_members" "hm" ON (("hm"."user_id" = "p"."id")))
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."active" = true) AND ("hm"."hotel_id" = "user_feedback"."hotel_id") AND ("hm"."active" = true) AND ("regexp_replace"("lower"("p"."role"), '[^a-z]'::"text", ''::"text", 'g'::"text") = ANY (ARRAY['engineer'::"text", 'chiefengineer'::"text", 'systemadmin'::"text", 'systemadministrator'::"text", 'administrator'::"text", 'admin'::"text"])))))));



ALTER TABLE "public"."user_profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "user_profiles_member_access" ON "public"."user_profiles" USING ("public"."is_hotel_member"("hotel_id")) WITH CHECK ("public"."is_hotel_member"("hotel_id"));



ALTER TABLE "public"."vendor_contacts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "vendor_contacts_member_access" ON "public"."vendor_contacts" USING ("public"."is_hotel_member"("hotel_id")) WITH CHECK ("public"."is_hotel_member"("hotel_id"));



ALTER TABLE "public"."vendor_proposals" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "vendor_proposals_member_access" ON "public"."vendor_proposals" USING ("public"."is_hotel_member"("hotel_id")) WITH CHECK ("public"."is_hotel_member"("hotel_id"));



ALTER TABLE "public"."vendors" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "vendors_member_access" ON "public"."vendors" USING ("public"."is_hotel_member"("hotel_id")) WITH CHECK ("public"."is_hotel_member"("hotel_id"));



ALTER TABLE "public"."work_order_creator_audit" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."work_order_items" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "work_order_items_member_access" ON "public"."work_order_items" USING ("public"."is_hotel_member"("hotel_id")) WITH CHECK ("public"."is_hotel_member"("hotel_id"));



ALTER TABLE "public"."work_order_sources" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "work_order_sources_member_access" ON "public"."work_order_sources" USING ("public"."is_hotel_member"("hotel_id")) WITH CHECK ("public"."is_hotel_member"("hotel_id"));



ALTER TABLE "public"."work_orders" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "work_orders_member_access" ON "public"."work_orders" USING ("public"."is_hotel_member"("hotel_id")) WITH CHECK ("public"."is_hotel_member"("hotel_id"));





ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";


GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";






















































































































































GRANT ALL ON FUNCTION "public"."can_manage_hotel"("target_hotel_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."can_manage_hotel"("target_hotel_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."can_manage_hotel"("target_hotel_id" "uuid") TO "service_role";



GRANT ALL ON TABLE "public"."cmpri_enseo_assignments" TO "service_role";



REVOKE ALL ON FUNCTION "public"."cmpri_apply_enseo_moves"("p_hotel_id" "uuid", "p_actor_user_id" "uuid", "p_moves" "jsonb", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."cmpri_apply_enseo_moves"("p_hotel_id" "uuid", "p_actor_user_id" "uuid", "p_moves" "jsonb", "p_reason" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."cmpri_assign_work_order_display_id"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."cmpri_assign_work_order_display_id"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."cmpri_audit_pool_log"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."cmpri_audit_pool_log"() TO "service_role";



GRANT ALL ON FUNCTION "public"."cmpri_bump_work_order_revision"() TO "anon";
GRANT ALL ON FUNCTION "public"."cmpri_bump_work_order_revision"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."cmpri_bump_work_order_revision"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."cmpri_check_work_order_submitter"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."cmpri_check_work_order_submitter"() TO "service_role";



GRANT ALL ON FUNCTION "public"."cmpri_pm_proposal_stamp"() TO "anon";
GRANT ALL ON FUNCTION "public"."cmpri_pm_proposal_stamp"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."cmpri_pm_proposal_stamp"() TO "service_role";



GRANT ALL ON FUNCTION "public"."cmpri_remember_work_order_technician"() TO "anon";
GRANT ALL ON FUNCTION "public"."cmpri_remember_work_order_technician"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."cmpri_remember_work_order_technician"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."cmpri_replace_room_operations"("p_hotel_id" "uuid", "p_report_date" "date", "p_actor_id" "uuid", "p_actor_name" "text", "p_source_type" "text", "p_rows" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."cmpri_replace_room_operations"("p_hotel_id" "uuid", "p_report_date" "date", "p_actor_id" "uuid", "p_actor_name" "text", "p_source_type" "text", "p_rows" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."cmpri_resolve_technician_view_notifications"() TO "anon";
GRANT ALL ON FUNCTION "public"."cmpri_resolve_technician_view_notifications"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."cmpri_resolve_technician_view_notifications"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."cmpri_stamp_pool_log"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."cmpri_stamp_pool_log"() TO "service_role";



GRANT ALL ON FUNCTION "public"."is_hotel_member"("target_hotel_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."is_hotel_member"("target_hotel_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_hotel_member"("target_hotel_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."protect_work_order_creator"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."protect_work_order_creator"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."purge_cmpri_user"("target_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."purge_cmpri_user"("target_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "service_role";


















GRANT ALL ON TABLE "public"."asset_inventory_compatibility" TO "anon";
GRANT ALL ON TABLE "public"."asset_inventory_compatibility" TO "authenticated";
GRANT ALL ON TABLE "public"."asset_inventory_compatibility" TO "service_role";



GRANT ALL ON TABLE "public"."assets" TO "anon";
GRANT ALL ON TABLE "public"."assets" TO "authenticated";
GRANT ALL ON TABLE "public"."assets" TO "service_role";



GRANT ALL ON TABLE "public"."cmpri_asset_inventory_compatibility" TO "service_role";



GRANT ALL ON TABLE "public"."cmpri_email_events" TO "anon";
GRANT ALL ON TABLE "public"."cmpri_email_events" TO "authenticated";
GRANT ALL ON TABLE "public"."cmpri_email_events" TO "service_role";



GRANT ALL ON TABLE "public"."cmpri_enseo_assignment_history" TO "service_role";



GRANT ALL ON TABLE "public"."cmpri_enseo_tickets" TO "anon";
GRANT ALL ON TABLE "public"."cmpri_enseo_tickets" TO "authenticated";
GRANT ALL ON TABLE "public"."cmpri_enseo_tickets" TO "service_role";



GRANT ALL ON TABLE "public"."cmpri_gss_reports" TO "anon";
GRANT ALL ON TABLE "public"."cmpri_gss_reports" TO "authenticated";
GRANT ALL ON TABLE "public"."cmpri_gss_reports" TO "service_role";



GRANT ALL ON TABLE "public"."cmpri_inventory_items" TO "service_role";



GRANT ALL ON TABLE "public"."cmpri_inventory_movements" TO "service_role";



GRANT ALL ON TABLE "public"."cmpri_mcp_oauth_clients" TO "service_role";



GRANT ALL ON TABLE "public"."cmpri_mcp_oauth_codes" TO "service_role";



GRANT ALL ON TABLE "public"."cmpri_mcp_oauth_tokens" TO "service_role";



GRANT ALL ON TABLE "public"."cmpri_order_ideas" TO "service_role";



GRANT ALL ON TABLE "public"."cmpri_personal_mcp_links" TO "service_role";



GRANT ALL ON TABLE "public"."cmpri_pm_proposals" TO "authenticated";
GRANT ALL ON TABLE "public"."cmpri_pm_proposals" TO "service_role";



GRANT ALL ON TABLE "public"."cmpri_pool_log_history" TO "anon";
GRANT ALL ON TABLE "public"."cmpri_pool_log_history" TO "authenticated";
GRANT ALL ON TABLE "public"."cmpri_pool_log_history" TO "service_role";



GRANT ALL ON TABLE "public"."cmpri_purchase_shipments" TO "anon";
GRANT ALL ON TABLE "public"."cmpri_purchase_shipments" TO "authenticated";
GRANT ALL ON TABLE "public"."cmpri_purchase_shipments" TO "service_role";



GRANT ALL ON TABLE "public"."cmpri_purchases" TO "anon";
GRANT ALL ON TABLE "public"."cmpri_purchases" TO "authenticated";
GRANT ALL ON TABLE "public"."cmpri_purchases" TO "service_role";



GRANT ALL ON TABLE "public"."room_operations" TO "anon";
GRANT ALL ON TABLE "public"."room_operations" TO "authenticated";
GRANT ALL ON TABLE "public"."room_operations" TO "service_role";



GRANT ALL ON TABLE "public"."cmpri_room_operations" TO "authenticated";
GRANT ALL ON TABLE "public"."cmpri_room_operations" TO "service_role";



GRANT ALL ON TABLE "public"."cmpri_supplier_followups" TO "anon";
GRANT ALL ON TABLE "public"."cmpri_supplier_followups" TO "authenticated";
GRANT ALL ON TABLE "public"."cmpri_supplier_followups" TO "service_role";



GRANT ALL ON TABLE "public"."cmpri_vendor_contacts" TO "service_role";



GRANT ALL ON TABLE "public"."cmpri_vendor_proposals" TO "service_role";



GRANT ALL ON TABLE "public"."cmpri_vendors" TO "service_role";



GRANT ALL ON TABLE "public"."cmpri_warranty_cases" TO "anon";
GRANT ALL ON TABLE "public"."cmpri_warranty_cases" TO "authenticated";
GRANT ALL ON TABLE "public"."cmpri_warranty_cases" TO "service_role";



GRANT ALL ON TABLE "public"."cmpri_work_order_drafts" TO "anon";
GRANT ALL ON TABLE "public"."cmpri_work_order_drafts" TO "authenticated";
GRANT ALL ON TABLE "public"."cmpri_work_order_drafts" TO "service_role";



GRANT ALL ON TABLE "public"."cmpri_work_order_items" TO "service_role";



GRANT ALL ON TABLE "public"."cmpri_work_order_technician_views" TO "service_role";



GRANT ALL ON TABLE "public"."corporate_pm_reports" TO "anon";
GRANT ALL ON TABLE "public"."corporate_pm_reports" TO "authenticated";
GRANT ALL ON TABLE "public"."corporate_pm_reports" TO "service_role";



GRANT ALL ON TABLE "public"."documents" TO "anon";
GRANT ALL ON TABLE "public"."documents" TO "authenticated";
GRANT ALL ON TABLE "public"."documents" TO "service_role";



GRANT ALL ON TABLE "public"."hotel_members" TO "anon";
GRANT ALL ON TABLE "public"."hotel_members" TO "authenticated";
GRANT ALL ON TABLE "public"."hotel_members" TO "service_role";



GRANT ALL ON TABLE "public"."hotels" TO "anon";
GRANT ALL ON TABLE "public"."hotels" TO "authenticated";
GRANT ALL ON TABLE "public"."hotels" TO "service_role";



GRANT ALL ON TABLE "public"."inventory_items" TO "anon";
GRANT ALL ON TABLE "public"."inventory_items" TO "authenticated";
GRANT ALL ON TABLE "public"."inventory_items" TO "service_role";



GRANT ALL ON TABLE "public"."inventory_movements" TO "anon";
GRANT ALL ON TABLE "public"."inventory_movements" TO "authenticated";
GRANT ALL ON TABLE "public"."inventory_movements" TO "service_role";



GRANT ALL ON TABLE "public"."locations" TO "anon";
GRANT ALL ON TABLE "public"."locations" TO "authenticated";
GRANT ALL ON TABLE "public"."locations" TO "service_role";



GRANT ALL ON TABLE "public"."maintenance_documents" TO "anon";
GRANT ALL ON TABLE "public"."maintenance_documents" TO "authenticated";
GRANT ALL ON TABLE "public"."maintenance_documents" TO "service_role";



GRANT ALL ON TABLE "public"."manual_ingestion_runs" TO "anon";
GRANT ALL ON TABLE "public"."manual_ingestion_runs" TO "authenticated";
GRANT ALL ON TABLE "public"."manual_ingestion_runs" TO "service_role";



GRANT ALL ON TABLE "public"."operational_log_entries" TO "anon";
GRANT ALL ON TABLE "public"."operational_log_entries" TO "authenticated";
GRANT ALL ON TABLE "public"."operational_log_entries" TO "service_role";



GRANT ALL ON TABLE "public"."operational_log_templates" TO "anon";
GRANT ALL ON TABLE "public"."operational_log_templates" TO "authenticated";
GRANT ALL ON TABLE "public"."operational_log_templates" TO "service_role";



GRANT ALL ON TABLE "public"."pm_completions" TO "anon";
GRANT ALL ON TABLE "public"."pm_completions" TO "authenticated";
GRANT ALL ON TABLE "public"."pm_completions" TO "service_role";



GRANT ALL ON TABLE "public"."pm_opportunities" TO "anon";
GRANT ALL ON TABLE "public"."pm_opportunities" TO "authenticated";
GRANT ALL ON TABLE "public"."pm_opportunities" TO "service_role";



GRANT ALL ON TABLE "public"."pm_plans" TO "anon";
GRANT ALL ON TABLE "public"."pm_plans" TO "authenticated";
GRANT ALL ON TABLE "public"."pm_plans" TO "service_role";



GRANT ALL ON TABLE "public"."pool_chemical_orders" TO "anon";
GRANT ALL ON TABLE "public"."pool_chemical_orders" TO "authenticated";
GRANT ALL ON TABLE "public"."pool_chemical_orders" TO "service_role";



GRANT ALL ON TABLE "public"."pool_chemical_price_checks" TO "anon";
GRANT ALL ON TABLE "public"."pool_chemical_price_checks" TO "authenticated";
GRANT ALL ON TABLE "public"."pool_chemical_price_checks" TO "service_role";



GRANT ALL ON TABLE "public"."pool_chemical_usage" TO "anon";
GRANT ALL ON TABLE "public"."pool_chemical_usage" TO "authenticated";
GRANT ALL ON TABLE "public"."pool_chemical_usage" TO "service_role";



GRANT ALL ON TABLE "public"."pool_chemicals" TO "anon";
GRANT ALL ON TABLE "public"."pool_chemicals" TO "authenticated";
GRANT ALL ON TABLE "public"."pool_chemicals" TO "service_role";



GRANT ALL ON TABLE "public"."pool_compliance_requirements" TO "anon";
GRANT ALL ON TABLE "public"."pool_compliance_requirements" TO "authenticated";
GRANT ALL ON TABLE "public"."pool_compliance_requirements" TO "service_role";



GRANT ALL ON TABLE "public"."pool_daily_logs" TO "anon";
GRANT ALL ON TABLE "public"."pool_daily_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."pool_daily_logs" TO "service_role";



GRANT ALL ON TABLE "public"."pool_documents" TO "anon";
GRANT ALL ON TABLE "public"."pool_documents" TO "authenticated";
GRANT ALL ON TABLE "public"."pool_documents" TO "service_role";



GRANT ALL ON TABLE "public"."pool_equipment" TO "anon";
GRANT ALL ON TABLE "public"."pool_equipment" TO "authenticated";
GRANT ALL ON TABLE "public"."pool_equipment" TO "service_role";



GRANT ALL ON TABLE "public"."pool_facilities" TO "anon";
GRANT ALL ON TABLE "public"."pool_facilities" TO "authenticated";
GRANT ALL ON TABLE "public"."pool_facilities" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT ALL ON TABLE "public"."role_permissions" TO "anon";
GRANT ALL ON TABLE "public"."role_permissions" TO "authenticated";
GRANT ALL ON TABLE "public"."role_permissions" TO "service_role";



GRANT ALL ON TABLE "public"."technicians" TO "anon";
GRANT ALL ON TABLE "public"."technicians" TO "authenticated";
GRANT ALL ON TABLE "public"."technicians" TO "service_role";



GRANT ALL ON TABLE "public"."troubleshooting_cache" TO "anon";
GRANT ALL ON TABLE "public"."troubleshooting_cache" TO "authenticated";
GRANT ALL ON TABLE "public"."troubleshooting_cache" TO "service_role";



GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."user_feedback" TO "authenticated";
GRANT ALL ON TABLE "public"."user_feedback" TO "service_role";



GRANT UPDATE("status") ON TABLE "public"."user_feedback" TO "authenticated";



GRANT UPDATE("reviewed_at") ON TABLE "public"."user_feedback" TO "authenticated";



GRANT UPDATE("resolved_at") ON TABLE "public"."user_feedback" TO "authenticated";



GRANT ALL ON TABLE "public"."user_profiles" TO "anon";
GRANT ALL ON TABLE "public"."user_profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."user_profiles" TO "service_role";



GRANT ALL ON TABLE "public"."vendor_contacts" TO "anon";
GRANT ALL ON TABLE "public"."vendor_contacts" TO "authenticated";
GRANT ALL ON TABLE "public"."vendor_contacts" TO "service_role";



GRANT ALL ON TABLE "public"."vendor_proposals" TO "anon";
GRANT ALL ON TABLE "public"."vendor_proposals" TO "authenticated";
GRANT ALL ON TABLE "public"."vendor_proposals" TO "service_role";



GRANT ALL ON TABLE "public"."vendors" TO "anon";
GRANT ALL ON TABLE "public"."vendors" TO "authenticated";
GRANT ALL ON TABLE "public"."vendors" TO "service_role";



GRANT ALL ON TABLE "public"."work_order_creator_audit" TO "anon";
GRANT ALL ON TABLE "public"."work_order_creator_audit" TO "authenticated";
GRANT ALL ON TABLE "public"."work_order_creator_audit" TO "service_role";



GRANT ALL ON TABLE "public"."work_order_items" TO "anon";
GRANT ALL ON TABLE "public"."work_order_items" TO "authenticated";
GRANT ALL ON TABLE "public"."work_order_items" TO "service_role";



GRANT ALL ON TABLE "public"."work_order_sources" TO "anon";
GRANT ALL ON TABLE "public"."work_order_sources" TO "authenticated";
GRANT ALL ON TABLE "public"."work_order_sources" TO "service_role";



GRANT ALL ON TABLE "public"."work_orders" TO "anon";
GRANT ALL ON TABLE "public"."work_orders" TO "authenticated";
GRANT ALL ON TABLE "public"."work_orders" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";
































-- Prod has explicitly revoked these default Supabase table privileges; mirror them so replays match prod.
revoke delete on table "public"."cmpri_asset_inventory_compatibility" from "anon";

revoke insert on table "public"."cmpri_asset_inventory_compatibility" from "anon";

revoke references on table "public"."cmpri_asset_inventory_compatibility" from "anon";

revoke select on table "public"."cmpri_asset_inventory_compatibility" from "anon";

revoke trigger on table "public"."cmpri_asset_inventory_compatibility" from "anon";

revoke truncate on table "public"."cmpri_asset_inventory_compatibility" from "anon";

revoke update on table "public"."cmpri_asset_inventory_compatibility" from "anon";

revoke delete on table "public"."cmpri_asset_inventory_compatibility" from "authenticated";

revoke insert on table "public"."cmpri_asset_inventory_compatibility" from "authenticated";

revoke references on table "public"."cmpri_asset_inventory_compatibility" from "authenticated";

revoke select on table "public"."cmpri_asset_inventory_compatibility" from "authenticated";

revoke trigger on table "public"."cmpri_asset_inventory_compatibility" from "authenticated";

revoke truncate on table "public"."cmpri_asset_inventory_compatibility" from "authenticated";

revoke update on table "public"."cmpri_asset_inventory_compatibility" from "authenticated";

revoke delete on table "public"."cmpri_enseo_assignment_history" from "anon";

revoke insert on table "public"."cmpri_enseo_assignment_history" from "anon";

revoke references on table "public"."cmpri_enseo_assignment_history" from "anon";

revoke select on table "public"."cmpri_enseo_assignment_history" from "anon";

revoke trigger on table "public"."cmpri_enseo_assignment_history" from "anon";

revoke truncate on table "public"."cmpri_enseo_assignment_history" from "anon";

revoke update on table "public"."cmpri_enseo_assignment_history" from "anon";

revoke delete on table "public"."cmpri_enseo_assignment_history" from "authenticated";

revoke insert on table "public"."cmpri_enseo_assignment_history" from "authenticated";

revoke references on table "public"."cmpri_enseo_assignment_history" from "authenticated";

revoke select on table "public"."cmpri_enseo_assignment_history" from "authenticated";

revoke trigger on table "public"."cmpri_enseo_assignment_history" from "authenticated";

revoke truncate on table "public"."cmpri_enseo_assignment_history" from "authenticated";

revoke update on table "public"."cmpri_enseo_assignment_history" from "authenticated";

revoke delete on table "public"."cmpri_enseo_assignments" from "anon";

revoke insert on table "public"."cmpri_enseo_assignments" from "anon";

revoke references on table "public"."cmpri_enseo_assignments" from "anon";

revoke select on table "public"."cmpri_enseo_assignments" from "anon";

revoke trigger on table "public"."cmpri_enseo_assignments" from "anon";

revoke truncate on table "public"."cmpri_enseo_assignments" from "anon";

revoke update on table "public"."cmpri_enseo_assignments" from "anon";

revoke delete on table "public"."cmpri_enseo_assignments" from "authenticated";

revoke insert on table "public"."cmpri_enseo_assignments" from "authenticated";

revoke references on table "public"."cmpri_enseo_assignments" from "authenticated";

revoke select on table "public"."cmpri_enseo_assignments" from "authenticated";

revoke trigger on table "public"."cmpri_enseo_assignments" from "authenticated";

revoke truncate on table "public"."cmpri_enseo_assignments" from "authenticated";

revoke update on table "public"."cmpri_enseo_assignments" from "authenticated";

revoke delete on table "public"."cmpri_inventory_items" from "anon";

revoke insert on table "public"."cmpri_inventory_items" from "anon";

revoke references on table "public"."cmpri_inventory_items" from "anon";

revoke select on table "public"."cmpri_inventory_items" from "anon";

revoke trigger on table "public"."cmpri_inventory_items" from "anon";

revoke truncate on table "public"."cmpri_inventory_items" from "anon";

revoke update on table "public"."cmpri_inventory_items" from "anon";

revoke delete on table "public"."cmpri_inventory_items" from "authenticated";

revoke insert on table "public"."cmpri_inventory_items" from "authenticated";

revoke references on table "public"."cmpri_inventory_items" from "authenticated";

revoke select on table "public"."cmpri_inventory_items" from "authenticated";

revoke trigger on table "public"."cmpri_inventory_items" from "authenticated";

revoke truncate on table "public"."cmpri_inventory_items" from "authenticated";

revoke update on table "public"."cmpri_inventory_items" from "authenticated";

revoke delete on table "public"."cmpri_inventory_movements" from "anon";

revoke insert on table "public"."cmpri_inventory_movements" from "anon";

revoke references on table "public"."cmpri_inventory_movements" from "anon";

revoke select on table "public"."cmpri_inventory_movements" from "anon";

revoke trigger on table "public"."cmpri_inventory_movements" from "anon";

revoke truncate on table "public"."cmpri_inventory_movements" from "anon";

revoke update on table "public"."cmpri_inventory_movements" from "anon";

revoke delete on table "public"."cmpri_inventory_movements" from "authenticated";

revoke insert on table "public"."cmpri_inventory_movements" from "authenticated";

revoke references on table "public"."cmpri_inventory_movements" from "authenticated";

revoke select on table "public"."cmpri_inventory_movements" from "authenticated";

revoke trigger on table "public"."cmpri_inventory_movements" from "authenticated";

revoke truncate on table "public"."cmpri_inventory_movements" from "authenticated";

revoke update on table "public"."cmpri_inventory_movements" from "authenticated";

revoke delete on table "public"."cmpri_mcp_oauth_clients" from "anon";

revoke insert on table "public"."cmpri_mcp_oauth_clients" from "anon";

revoke references on table "public"."cmpri_mcp_oauth_clients" from "anon";

revoke select on table "public"."cmpri_mcp_oauth_clients" from "anon";

revoke trigger on table "public"."cmpri_mcp_oauth_clients" from "anon";

revoke truncate on table "public"."cmpri_mcp_oauth_clients" from "anon";

revoke update on table "public"."cmpri_mcp_oauth_clients" from "anon";

revoke delete on table "public"."cmpri_mcp_oauth_clients" from "authenticated";

revoke insert on table "public"."cmpri_mcp_oauth_clients" from "authenticated";

revoke references on table "public"."cmpri_mcp_oauth_clients" from "authenticated";

revoke select on table "public"."cmpri_mcp_oauth_clients" from "authenticated";

revoke trigger on table "public"."cmpri_mcp_oauth_clients" from "authenticated";

revoke truncate on table "public"."cmpri_mcp_oauth_clients" from "authenticated";

revoke update on table "public"."cmpri_mcp_oauth_clients" from "authenticated";

revoke delete on table "public"."cmpri_mcp_oauth_codes" from "anon";

revoke insert on table "public"."cmpri_mcp_oauth_codes" from "anon";

revoke references on table "public"."cmpri_mcp_oauth_codes" from "anon";

revoke select on table "public"."cmpri_mcp_oauth_codes" from "anon";

revoke trigger on table "public"."cmpri_mcp_oauth_codes" from "anon";

revoke truncate on table "public"."cmpri_mcp_oauth_codes" from "anon";

revoke update on table "public"."cmpri_mcp_oauth_codes" from "anon";

revoke delete on table "public"."cmpri_mcp_oauth_codes" from "authenticated";

revoke insert on table "public"."cmpri_mcp_oauth_codes" from "authenticated";

revoke references on table "public"."cmpri_mcp_oauth_codes" from "authenticated";

revoke select on table "public"."cmpri_mcp_oauth_codes" from "authenticated";

revoke trigger on table "public"."cmpri_mcp_oauth_codes" from "authenticated";

revoke truncate on table "public"."cmpri_mcp_oauth_codes" from "authenticated";

revoke update on table "public"."cmpri_mcp_oauth_codes" from "authenticated";

revoke delete on table "public"."cmpri_mcp_oauth_tokens" from "anon";

revoke insert on table "public"."cmpri_mcp_oauth_tokens" from "anon";

revoke references on table "public"."cmpri_mcp_oauth_tokens" from "anon";

revoke select on table "public"."cmpri_mcp_oauth_tokens" from "anon";

revoke trigger on table "public"."cmpri_mcp_oauth_tokens" from "anon";

revoke truncate on table "public"."cmpri_mcp_oauth_tokens" from "anon";

revoke update on table "public"."cmpri_mcp_oauth_tokens" from "anon";

revoke delete on table "public"."cmpri_mcp_oauth_tokens" from "authenticated";

revoke insert on table "public"."cmpri_mcp_oauth_tokens" from "authenticated";

revoke references on table "public"."cmpri_mcp_oauth_tokens" from "authenticated";

revoke select on table "public"."cmpri_mcp_oauth_tokens" from "authenticated";

revoke trigger on table "public"."cmpri_mcp_oauth_tokens" from "authenticated";

revoke truncate on table "public"."cmpri_mcp_oauth_tokens" from "authenticated";

revoke update on table "public"."cmpri_mcp_oauth_tokens" from "authenticated";

revoke delete on table "public"."cmpri_order_ideas" from "anon";

revoke insert on table "public"."cmpri_order_ideas" from "anon";

revoke references on table "public"."cmpri_order_ideas" from "anon";

revoke select on table "public"."cmpri_order_ideas" from "anon";

revoke trigger on table "public"."cmpri_order_ideas" from "anon";

revoke truncate on table "public"."cmpri_order_ideas" from "anon";

revoke update on table "public"."cmpri_order_ideas" from "anon";

revoke delete on table "public"."cmpri_order_ideas" from "authenticated";

revoke insert on table "public"."cmpri_order_ideas" from "authenticated";

revoke references on table "public"."cmpri_order_ideas" from "authenticated";

revoke select on table "public"."cmpri_order_ideas" from "authenticated";

revoke trigger on table "public"."cmpri_order_ideas" from "authenticated";

revoke truncate on table "public"."cmpri_order_ideas" from "authenticated";

revoke update on table "public"."cmpri_order_ideas" from "authenticated";

revoke delete on table "public"."cmpri_personal_mcp_links" from "anon";

revoke insert on table "public"."cmpri_personal_mcp_links" from "anon";

revoke references on table "public"."cmpri_personal_mcp_links" from "anon";

revoke select on table "public"."cmpri_personal_mcp_links" from "anon";

revoke trigger on table "public"."cmpri_personal_mcp_links" from "anon";

revoke truncate on table "public"."cmpri_personal_mcp_links" from "anon";

revoke update on table "public"."cmpri_personal_mcp_links" from "anon";

revoke delete on table "public"."cmpri_personal_mcp_links" from "authenticated";

revoke insert on table "public"."cmpri_personal_mcp_links" from "authenticated";

revoke references on table "public"."cmpri_personal_mcp_links" from "authenticated";

revoke select on table "public"."cmpri_personal_mcp_links" from "authenticated";

revoke trigger on table "public"."cmpri_personal_mcp_links" from "authenticated";

revoke truncate on table "public"."cmpri_personal_mcp_links" from "authenticated";

revoke update on table "public"."cmpri_personal_mcp_links" from "authenticated";

revoke delete on table "public"."cmpri_pm_proposals" from "anon";

revoke insert on table "public"."cmpri_pm_proposals" from "anon";

revoke references on table "public"."cmpri_pm_proposals" from "anon";

revoke select on table "public"."cmpri_pm_proposals" from "anon";

revoke trigger on table "public"."cmpri_pm_proposals" from "anon";

revoke truncate on table "public"."cmpri_pm_proposals" from "anon";

revoke update on table "public"."cmpri_pm_proposals" from "anon";

revoke delete on table "public"."cmpri_vendor_contacts" from "anon";

revoke insert on table "public"."cmpri_vendor_contacts" from "anon";

revoke references on table "public"."cmpri_vendor_contacts" from "anon";

revoke select on table "public"."cmpri_vendor_contacts" from "anon";

revoke trigger on table "public"."cmpri_vendor_contacts" from "anon";

revoke truncate on table "public"."cmpri_vendor_contacts" from "anon";

revoke update on table "public"."cmpri_vendor_contacts" from "anon";

revoke delete on table "public"."cmpri_vendor_contacts" from "authenticated";

revoke insert on table "public"."cmpri_vendor_contacts" from "authenticated";

revoke references on table "public"."cmpri_vendor_contacts" from "authenticated";

revoke select on table "public"."cmpri_vendor_contacts" from "authenticated";

revoke trigger on table "public"."cmpri_vendor_contacts" from "authenticated";

revoke truncate on table "public"."cmpri_vendor_contacts" from "authenticated";

revoke update on table "public"."cmpri_vendor_contacts" from "authenticated";

revoke delete on table "public"."cmpri_vendor_proposals" from "anon";

revoke insert on table "public"."cmpri_vendor_proposals" from "anon";

revoke references on table "public"."cmpri_vendor_proposals" from "anon";

revoke select on table "public"."cmpri_vendor_proposals" from "anon";

revoke trigger on table "public"."cmpri_vendor_proposals" from "anon";

revoke truncate on table "public"."cmpri_vendor_proposals" from "anon";

revoke update on table "public"."cmpri_vendor_proposals" from "anon";

revoke delete on table "public"."cmpri_vendor_proposals" from "authenticated";

revoke insert on table "public"."cmpri_vendor_proposals" from "authenticated";

revoke references on table "public"."cmpri_vendor_proposals" from "authenticated";

revoke select on table "public"."cmpri_vendor_proposals" from "authenticated";

revoke trigger on table "public"."cmpri_vendor_proposals" from "authenticated";

revoke truncate on table "public"."cmpri_vendor_proposals" from "authenticated";

revoke update on table "public"."cmpri_vendor_proposals" from "authenticated";

revoke delete on table "public"."cmpri_vendors" from "anon";

revoke insert on table "public"."cmpri_vendors" from "anon";

revoke references on table "public"."cmpri_vendors" from "anon";

revoke select on table "public"."cmpri_vendors" from "anon";

revoke trigger on table "public"."cmpri_vendors" from "anon";

revoke truncate on table "public"."cmpri_vendors" from "anon";

revoke update on table "public"."cmpri_vendors" from "anon";

revoke delete on table "public"."cmpri_vendors" from "authenticated";

revoke insert on table "public"."cmpri_vendors" from "authenticated";

revoke references on table "public"."cmpri_vendors" from "authenticated";

revoke select on table "public"."cmpri_vendors" from "authenticated";

revoke trigger on table "public"."cmpri_vendors" from "authenticated";

revoke truncate on table "public"."cmpri_vendors" from "authenticated";

revoke update on table "public"."cmpri_vendors" from "authenticated";

revoke delete on table "public"."cmpri_work_order_items" from "anon";

revoke insert on table "public"."cmpri_work_order_items" from "anon";

revoke references on table "public"."cmpri_work_order_items" from "anon";

revoke select on table "public"."cmpri_work_order_items" from "anon";

revoke trigger on table "public"."cmpri_work_order_items" from "anon";

revoke truncate on table "public"."cmpri_work_order_items" from "anon";

revoke update on table "public"."cmpri_work_order_items" from "anon";

revoke delete on table "public"."cmpri_work_order_items" from "authenticated";

revoke insert on table "public"."cmpri_work_order_items" from "authenticated";

revoke references on table "public"."cmpri_work_order_items" from "authenticated";

revoke select on table "public"."cmpri_work_order_items" from "authenticated";

revoke trigger on table "public"."cmpri_work_order_items" from "authenticated";

revoke truncate on table "public"."cmpri_work_order_items" from "authenticated";

revoke update on table "public"."cmpri_work_order_items" from "authenticated";

revoke delete on table "public"."cmpri_work_order_technician_views" from "anon";

revoke insert on table "public"."cmpri_work_order_technician_views" from "anon";

revoke references on table "public"."cmpri_work_order_technician_views" from "anon";

revoke select on table "public"."cmpri_work_order_technician_views" from "anon";

revoke trigger on table "public"."cmpri_work_order_technician_views" from "anon";

revoke truncate on table "public"."cmpri_work_order_technician_views" from "anon";

revoke update on table "public"."cmpri_work_order_technician_views" from "anon";

revoke delete on table "public"."cmpri_work_order_technician_views" from "authenticated";

revoke insert on table "public"."cmpri_work_order_technician_views" from "authenticated";

revoke references on table "public"."cmpri_work_order_technician_views" from "authenticated";

revoke select on table "public"."cmpri_work_order_technician_views" from "authenticated";

revoke trigger on table "public"."cmpri_work_order_technician_views" from "authenticated";

revoke truncate on table "public"."cmpri_work_order_technician_views" from "authenticated";

revoke update on table "public"."cmpri_work_order_technician_views" from "authenticated";

revoke delete on table "public"."user_feedback" from "anon";

revoke insert on table "public"."user_feedback" from "anon";

revoke references on table "public"."user_feedback" from "anon";

revoke select on table "public"."user_feedback" from "anon";

revoke trigger on table "public"."user_feedback" from "anon";

revoke truncate on table "public"."user_feedback" from "anon";

revoke update on table "public"."user_feedback" from "anon";

revoke update on table "public"."user_feedback" from "authenticated";
