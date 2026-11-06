begin;
alter table public.cmpri_resource_signals drop constraint cmpri_resource_signals_topic_check;
alter table public.cmpri_resource_signals add constraint cmpri_resource_signals_topic_check
 check(topic in ('orders','inbox','pool','rooms','feedback','session','reference'));

-- Content-free invalidations only. Existing API authorization still controls reads.
-- Both public compatibility views are backed by this consolidated table.
create trigger resource_assets_and_manuals after insert or update or delete on public.cmpri_assets_and_pdfs for each row execute function cmpri_private.signal_resource('reference');
create trigger resource_knowledge after insert or update or delete on public.troubleshooting_cache for each row execute function cmpri_private.signal_resource('reference');
create trigger resource_locations after insert or update or delete on public.locations for each row execute function cmpri_private.signal_resource('rooms');
create trigger resource_history after insert or update or delete on public.cmpri_work_order_history for each row execute function cmpri_private.signal_resource('orders');
create trigger resource_purchases after insert or update or delete on public.cmpri_purchases for each row execute function cmpri_private.signal_resource('orders');
create trigger resource_enseo after insert or update or delete on public.cmpri_enseo_tickets for each row execute function cmpri_private.signal_resource('orders');
create trigger resource_warranties after insert or update or delete on public.cmpri_warranty_cases for each row execute function cmpri_private.signal_resource('orders');
create trigger resource_followups after insert or update or delete on public.cmpri_supplier_followups for each row execute function cmpri_private.signal_resource('orders');
create trigger resource_push_test after insert or update or delete on public.cmpri_web_push_tests for each row execute function cmpri_private.signal_resource('inbox');

-- Shipment rows inherit hotel ownership from the purchase; there is no hotel_id column.
create function cmpri_private.signal_shipment_resource() returns trigger
language plpgsql security definer set search_path='' as $$
declare item jsonb; h uuid;
begin
 item=case when tg_op='DELETE' then to_jsonb(old) else to_jsonb(new) end;
 select hotel_id into h from public.cmpri_purchases where id=(item->>'purchase_id')::uuid;
 insert into public.cmpri_resource_signals(hotel_id,recipient_user_id,topic)
 select distinct h,m.user_id,'orders' from public.hotel_members m join public.profiles p on p.id=m.user_id
 where h is not null and m.hotel_id=h and m.active and p.active
 on conflict(hotel_id,recipient_user_id,topic) do update set revision=cmpri_resource_signals.revision+1;
 return null;
end $$;
revoke all on function cmpri_private.signal_shipment_resource() from public,anon,authenticated;
create trigger resource_shipments after insert or update or delete on public.cmpri_purchase_shipments for each row execute function cmpri_private.signal_shipment_resource();

-- Photos have no application metadata table. Watch only committed ticket-photo paths,
-- excluding staging uploads and unrelated buckets. Never expose object names or URLs.
create function cmpri_private.signal_ticket_photo_resource() returns trigger
language plpgsql security definer set search_path='' as $$
declare item jsonb; h uuid; parts text[];
begin
 item=case when tg_op='DELETE' then to_jsonb(old) else to_jsonb(new) end;
 if item->>'bucket_id' <> 'asset-documentation' then return null; end if;
 parts=string_to_array(item->>'name','/');
 if array_length(parts,1)<>4 or parts[2]<>'work-orders'
 or parts[1] !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 or parts[3] !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 or parts[4] !~ '^[0-9a-f_-]+\.(jpg|jpeg|png|gif|webp|bmp|heic|heif|mp4|mov|webm)$' then return null; end if;
 select hotel_id into h from public.work_orders where id=parts[3]::uuid and hotel_id=parts[1]::uuid;
 insert into public.cmpri_resource_signals(hotel_id,recipient_user_id,topic)
 select distinct h,m.user_id,'orders' from public.hotel_members m join public.profiles p on p.id=m.user_id
 where h is not null and m.hotel_id=h and m.active and p.active
 on conflict(hotel_id,recipient_user_id,topic) do update set revision=cmpri_resource_signals.revision+1;
 return null;
end $$;
revoke all on function cmpri_private.signal_ticket_photo_resource() from public,anon,authenticated;
create trigger resource_ticket_photos after insert or update or delete on storage.objects for each row execute function cmpri_private.signal_ticket_photo_resource();
commit;
