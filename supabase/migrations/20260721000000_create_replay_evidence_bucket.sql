-- Public replay-evidence media embedded in GitHub issue comments.
--
-- Writes are performed only by the backend service role. Public access is
-- read-only through Supabase Storage's public-object endpoint; no insert,
-- update, or delete policies are granted to anon/authenticated roles.

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'sherlock-evidence',
  'sherlock-evidence',
  true,
  52428800,
  array['image/gif', 'video/mp4']::text[]
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
