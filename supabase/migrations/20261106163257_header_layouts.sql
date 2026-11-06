begin;
create table public.cmpri_header_layouts (
 hotel_id uuid not null,
 user_id uuid not null references public.profiles(id) on delete cascade,
 layout jsonb not null default '{}'::jsonb check (jsonb_typeof(layout) = 'object' and octet_length(layout::text) <= 40000),
 updated_at timestamptz not null default now(),
 primary key (hotel_id,user_id)
);
create index cmpri_header_layouts_user_idx on public.cmpri_header_layouts(user_id);
alter table public.cmpri_header_layouts enable row level security;
revoke all on public.cmpri_header_layouts from public,anon,authenticated;
grant select,insert,update on public.cmpri_header_layouts to authenticated;
grant all on public.cmpri_header_layouts to service_role;
create policy own_header_layout_read on public.cmpri_header_layouts for select to authenticated
using (user_id = (select auth.uid()) and cmpri_private.active_signal_member(hotel_id));
create policy own_header_layout_insert on public.cmpri_header_layouts for insert to authenticated
with check (user_id = (select auth.uid()) and cmpri_private.active_signal_member(hotel_id));
create policy own_header_layout_update on public.cmpri_header_layouts for update to authenticated
using (user_id = (select auth.uid()) and cmpri_private.active_signal_member(hotel_id))
with check (user_id = (select auth.uid()) and cmpri_private.active_signal_member(hotel_id));
commit;
