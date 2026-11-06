-- Preserve private access and existing size limits; append supported video types only
-- where an explicit MIME allowlist already exists. NULL already allows all types.
UPDATE storage.buckets
SET allowed_mime_types = ARRAY(
  SELECT DISTINCT mime
  FROM unnest(allowed_mime_types || ARRAY['video/mp4','video/quicktime','video/webm']::text[]) AS mime
  ORDER BY mime
)
WHERE id = 'asset-documentation' AND allowed_mime_types IS NOT NULL;
