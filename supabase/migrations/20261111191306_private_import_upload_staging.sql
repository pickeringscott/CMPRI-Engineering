-- Actor-scoped import sources use server-issued, write-only signed capabilities.
-- Never add authenticated/anon storage policies for this bucket. Existing import
-- routes enforce their own capability and recompute the actor/hotel path.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('import-upload-staging', 'import-upload-staging', false, 104857600,
        array['application/pdf', 'text/csv', 'application/json'])
on conflict (id) do nothing;
-- Fail closed rather than silently changing an existing bucket's access policy.
do $$
begin
  if not exists (select 1 from storage.buckets where id = 'import-upload-staging'
      and public = false and file_size_limit = 104857600
      and allowed_mime_types @> array['application/pdf', 'text/csv', 'application/json']) then
    raise exception 'Private import staging bucket configuration does not match the release';
  end if;
end $$;
