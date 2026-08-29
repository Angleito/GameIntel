-- Materialized public article surface.
--
-- Published articles are read by the public role exclusively through this
-- table, which is written at publish time from toSafeArticle() (the same
-- sanitization the application uses): publicSafe + spoiler-safe body sections
-- only, HTML/link-stripped text, numbered citations instead of internal
-- source/claim references, and approved cover media only. Raw article rows,
-- including editorial-only fields and internal body sections, are never
-- readable by a public process.

CREATE TABLE public_article_records (
  article_id text PRIMARY KEY,
  collection_id text NOT NULL,
  slug text NOT NULL,
  title text NOT NULL,
  seo_title text NOT NULL,
  description text NOT NULL,
  body jsonb NOT NULL,
  status text NOT NULL,
  citations jsonb NOT NULL,
  cover_media jsonb,
  published_at timestamptz,
  updated_at timestamptz NOT NULL
);
CREATE INDEX public_article_records_collection ON public_article_records(collection_id, published_at DESC);
CREATE INDEX public_article_records_slug ON public_article_records(slug);

-- The previous public read functions returned the raw article row (a.*),
-- including editorial fields, internal body sections, and internal
-- source/claim references. They are replaced by functions that read only the
-- materialized public surface.
DROP FUNCTION IF EXISTS public_article_get(text);
DROP FUNCTION IF EXISTS public_article_list(text);

CREATE FUNCTION public_public_article_get(p_id_or_slug text) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog
AS $$
  SELECT jsonb_build_object(
    'id', t.article_id,
    'collectionId', t.collection_id,
    'slug', t.slug,
    'title', t.title,
    'seoTitle', t.seo_title,
    'description', t.description,
    'body', t.body,
    'status', t.status,
    'publishedAt', to_char(t.published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updatedAt', to_char(t.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'citations', t.citations,
    'coverMedia', t.cover_media
  )
  FROM public.public_article_records t
  WHERE t.article_id = p_id_or_slug OR t.slug = p_id_or_slug
  LIMIT 1
$$;

CREATE FUNCTION public_public_article_list(p_collection_id text) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', t.article_id,
    'collectionId', t.collection_id,
    'slug', t.slug,
    'title', t.title,
    'seoTitle', t.seo_title,
    'description', t.description,
    'body', t.body,
    'status', t.status,
    'publishedAt', to_char(t.published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updatedAt', to_char(t.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'citations', t.citations,
    'coverMedia', t.cover_media
  )), '[]'::jsonb)
  FROM public.public_article_records t
  WHERE t.collection_id = p_collection_id
$$;

REVOKE ALL ON FUNCTION public_public_article_get(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public_public_article_list(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_public_article_get(text) TO gameintel_public;
GRANT EXECUTE ON FUNCTION public_public_article_list(text) TO gameintel_public;

-- Rate limits are trusted database configuration, not untrusted caller
-- parameters: a compromised public client can no longer disable abuse limits
-- by supplying enormous values.
DROP FUNCTION IF EXISTS public_submission_submit(text, text, text, text, text, text, jsonb, jsonb, text, integer, integer, integer, integer, integer);

CREATE FUNCTION public_submission_submit(
  p_collection_id text,
  p_submitter_account_id text,
  p_submitter_session_hash text,
  p_submitter_ip_hash text,
  p_title text,
  p_report text,
  p_urls jsonb,
  p_media_refs jsonb,
  p_content_hash text,
  p_retention_days integer
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  v_submission_id text;
  v_duplicate_id text;
  v_global_count integer;
  v_ip_count integer;
  v_session_count integer;
  v_account_count integer;
BEGIN
  IF p_submitter_session_hash !~ '^[a-f0-9]{64}$' OR p_submitter_ip_hash !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'Submission identity hashes must be SHA-256 digests';
  END IF;
  IF p_retention_days < 1 OR p_retention_days > 90 THEN
    RAISE EXCEPTION 'Submission retention must be between 1 and 90 days';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.games WHERE id = p_collection_id) THEN
    RAISE EXCEPTION 'Collection not found';
  END IF;

  SELECT id INTO v_duplicate_id FROM public.public_submissions
    WHERE collection_id = p_collection_id
      AND submitter_session_hash = p_submitter_session_hash
      AND content_hash = p_content_hash
      AND created_at >= now() - interval '24 hours'
    LIMIT 1;
  IF v_duplicate_id IS NOT NULL THEN
    RETURN jsonb_build_object('id', v_duplicate_id, 'duplicate', true);
  END IF;

  SELECT COUNT(*)::int INTO v_global_count FROM public.public_submissions WHERE created_at >= now() - interval '1 minute';
  SELECT COUNT(*)::int INTO v_ip_count FROM public.public_submissions WHERE submitter_ip_hash = p_submitter_ip_hash AND created_at >= now() - interval '1 minute';
  SELECT COUNT(*)::int INTO v_session_count FROM public.public_submissions WHERE submitter_session_hash = p_submitter_session_hash AND created_at >= now() - interval '1 minute';
  SELECT COUNT(*)::int INTO v_account_count FROM public.public_submissions WHERE submitter_account_id = p_submitter_account_id AND created_at >= now() - interval '1 day';
  IF v_global_count >= 300 OR v_ip_count >= 5 OR v_session_count >= 3 OR (p_submitter_account_id IS NOT NULL AND v_account_count >= 20) THEN
    RAISE EXCEPTION 'Submission rate limit exceeded' USING ERRCODE = 'SR001';
  END IF;

  v_submission_id := 'sub_' || replace(gen_random_uuid()::text, '-', '');
  INSERT INTO public.public_submissions (
    id, collection_id, submitter_account_id, submitter_session_hash, submitter_ip_hash,
    title, report, urls, media_refs, content_hash, retention_until,
    state, promoted_source_item_id, content_purged_at, created_at, updated_at
  ) VALUES (
    v_submission_id, p_collection_id, NULLIF(p_submitter_account_id, ''), p_submitter_session_hash, p_submitter_ip_hash,
    NULLIF(p_title, ''), p_report, COALESCE(p_urls, '[]'::jsonb), COALESCE(p_media_refs, '[]'::jsonb), p_content_hash,
    now() + make_interval(days => p_retention_days),
    'quarantined', NULL, NULL, now(), now()
  );

  INSERT INTO public.submission_moderation_actions (id, submission_id, actor_id, action, notes, created_at)
  VALUES ('subact_' || replace(gen_random_uuid()::text, '-', ''), v_submission_id, 'system', 'submitted', 'Submission entered quarantine', now());

  INSERT INTO public.audit_log (id, actor_id, action, target_type, target_id, reason, created_at)
  VALUES ('audit_' || replace(gen_random_uuid()::text, '-', ''), 'system', 'submission.quarantined', 'public_submission', v_submission_id, 'Unverified public submission', now());

  RETURN jsonb_build_object('id', v_submission_id, 'duplicate', false);
END
$$;

REVOKE ALL ON FUNCTION public_submission_submit(text, text, text, text, text, text, jsonb, jsonb, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_submission_submit(text, text, text, text, text, text, jsonb, jsonb, text, integer) TO gameintel_public;