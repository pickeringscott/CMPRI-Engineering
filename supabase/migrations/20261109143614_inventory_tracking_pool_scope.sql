create function public.cmpri_inventory_conversion(p_quantity numeric,p_from text,p_to text) returns numeric language sql immutable security invoker set search_path='' as $$
 select case when p_from=p_to then p_quantity
 when public.cmpri_unit_grams(p_from) is not null and public.cmpri_unit_grams(p_to) is not null then round((p_quantity*public.cmpri_unit_grams(p_from))::numeric(60,24)/public.cmpri_unit_grams(p_to),24)
 else round((p_quantity*(case p_from when 'GAL' then 3785.411784 when 'L' then 1000 when 'ML' then 1 when 'FLOZ' then 29.5735295625 end))::numeric(60,24)/
      (case p_to when 'GAL' then 3785.411784 when 'L' then 1000 when 'ML' then 1 when 'FLOZ' then 29.5735295625 end),24) end;
$$;
revoke all on function public.cmpri_inventory_conversion(numeric,text,text) from public,anon,authenticated;
grant execute on function public.cmpri_inventory_conversion(numeric,text,text) to service_role;

create or replace function public.cmpri_pool_chemical_usage() returns trigger
language plpgsql security invoker set search_path=public,pg_temp as $$
declare
 ledger jsonb := '[]'; commands jsonb; entry jsonb; prior jsonb; item public.cmpri_inventory_items;
 use_id uuid; item_id uuid; qty numeric; delta numeric; base text; unit text; remark text; line text; cleaned text := ''; seen jsonb := '{}'; desired integer; count_seen integer;
begin
 if TG_OP='UPDATE' then ledger=old.chemical_uses; end if;
 commands=new.chemical_uses;
 if commands=ledger then
  if ledger='[]'::jsonb then return new; end if;
  commands='[]'::jsonb;
 end if;
 if current_user not in ('service_role','postgres') then raise exception 'Chemical usage must be saved through the pool log'; end if;
 if jsonb_typeof(commands)<>'array' or jsonb_array_length(commands)>100 then raise exception 'Invalid chemical usage list'; end if;
 -- A stable order shares the existing inventory row locks with receiving and supply usage.
 for entry in select value from jsonb_array_elements(commands) order by value->>'item',value->>'id' loop
  use_id=(entry->>'id')::uuid; item_id=(entry->>'item')::uuid; qty=(entry->>'quantity')::numeric; unit=entry->>'unit';
  if use_id is null or item_id is null or qty is null or qty<=0 or qty>999999999 or qty<>round(qty,3) or qty::text in ('NaN','Infinity','-Infinity') or coalesce(trim(unit),'')='' then raise exception 'Invalid chemical usage'; end if;
  select value into prior from jsonb_array_elements(ledger) where value->>'id'=use_id::text;
  if found then
   if prior->>'item'<>item_id::text or (prior->>'quantity')::numeric<>qty or prior->>'unit'<>unit or prior->>'actor'<>new.updated_by::text then raise exception 'Chemical usage key already has different details'; end if;
   continue;
  end if;
  if new.updated_by is null then raise exception 'Chemical usage requires an operator'; end if;
  select * into item from public.cmpri_inventory_items where hotel_id=new.hotel_id and id=item_id and active=true for update;
  if not found then raise exception 'Active inventory item not found in this property'; end if;
  if item.item_type<>'Chemical' or not exists(select 1 from public.cmpri_inventory_settings s join public.locations l on l.hotel_id=s.hotel_id and l.id=s.pool_location_id and l.active where s.hotel_id=new.hotel_id and s.pool_location_id=item.storage_location_id) then raise exception 'Choose an active chemical stored in Pool Pump Room'; end if;
  base=case upper(item.unit_of_measure) when 'EACH' then 'EA' when 'POUND' then 'LB' when 'POUNDS' then 'LB' else upper(item.unit_of_measure) end;
  if unit=base or unit=item.unit_of_measure then delta=qty;
  else
   delta=public.cmpri_inventory_conversion(qty,unit,base);
   if delta is null then raise exception 'Usage unit does not match inventory'; end if;
  end if;
  if base='EA' and delta<>trunc(delta) then raise exception 'Each usage requires a whole count'; end if;
  if item.quantity_on_hand-item.quantity_reserved<delta then raise exception 'Insufficient available inventory for %',item.item_name; end if;
  remark='Chemical used: '||trim_scale(qty)::text||' '||unit||' '||item.item_name||'.';
  update public.cmpri_inventory_items set quantity_on_hand=quantity_on_hand-delta where id=item_id;
  insert into public.cmpri_inventory_movements(id,hotel_id,inventory_item_id,movement_type,quantity_change,direction,performed_by_user_id,notes,source_type,source_id,source_date)
   values(use_id,new.hotel_id,item_id,'Use',-delta,'out',new.updated_by,
    'Pool log '||new.log_date::text||' ('||new.id::text||'): '||remark||' On hand '||item.quantity_on_hand::text||' → '||(item.quantity_on_hand-delta)::text||' '||item.unit_of_measure,'Pool log',new.id,new.log_date);
  ledger=ledger||jsonb_build_array(jsonb_build_object('id',use_id,'item',item_id,'quantity',qty,'unit',unit,'stock_quantity',delta,
   'inventory_unit',item.unit_of_measure,'name',item.item_name,'before',item.quantity_on_hand,'after',item.quantity_on_hand-delta,
   'actor',new.updated_by,'recorded_at',now(),'remark',remark));
 end loop;
 -- Normalize generated lines in place. Preserve the saved Remarks prefix required by pool operators.
 for line in select unnest(string_to_array(coalesce(new.remarks,''),E'\n')) loop
  select count(*) into desired from jsonb_array_elements(ledger) e where e->>'remark'=line;
  count_seen=coalesce((seen->>line)::integer,0);
  if desired=0 or count_seen<desired then
   cleaned=concat_ws(E'\n',nullif(cleaned,''),line);
   if desired>0 then seen=jsonb_set(seen,array[line],to_jsonb(count_seen+1)); end if;
  end if;
 end loop;
 for entry in select value from jsonb_array_elements(ledger) loop
  remark=entry->>'remark';
  select count(*) into desired from jsonb_array_elements(ledger) e where e->>'remark'=remark;
  count_seen=coalesce((seen->>remark)::integer,0);
  if count_seen<desired then
   cleaned=concat_ws(E'\n',nullif(cleaned,''),remark);
   seen=jsonb_set(seen,array[remark],to_jsonb(count_seen+1));
  end if;
 end loop;
 if length(cleaned)>20000 then raise exception 'Remarks including chemical usage exceed 20000 characters'; end if;
 new.remarks=cleaned; new.chemical_uses=ledger;
 return new;
end $$;
