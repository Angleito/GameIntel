-- Completion of the public capability boundary.
--
-- Reads: the public role holds no SELECT on any article table. Published rows
-- are exposed only through SECURITY DEFINER read functions owned by the
-- migration role, so unpublished drafts, moderation data, and internal source
-- material are not directly reachable from a public process. (The operator
-- listing keeps the raw adapter query under gameintel_operator, which is why
-- the article-select SQL is duplicated in these functions.)
--
-- Writes: the public role holds no INSERT on intake, moderation, or audit
-- tables. Community intake goes through public_submission_submit, which
-- always forces the initial quarantined state and the fixed system action and
-- audit records.
REVOKE SELECT ON articles, article_sources, article_media, media_assets FROM gameintel_public;
REVOKE INSERT ON public_submissions, submission_moderation_actions, audit_log FROM gameintel_public;

CREATE FUNCTION public_article_get(p_id_or_slug text) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog
AS $$
  SELECT row_to_json(t)
  FROM (
    SELECT a.*, COALESCE(jsonb_agg(DISTINCT jsonb_build_object('sourceId', ass.source_id, 'claimId', ass.claim_id, 'citationLabel', ass.citation_label, 'publicCitationUrl', ass.public_citation_url)) FILTER (WHERE ass.article_id IS NOT NULL), '[]') AS source_refs,
      cover.cover_media
    FROM public.articles a
      LEFT JOIN public.article_sources ass ON ass.article_id = a.id
      LEFT JOIN LATERAL (
        SELECT jsonb_build_object(
          'id', ma.id,
          'caption', ma.caption,
          'altText', ma.alt_text,
          'collection', ma.collection,
          'tags', ma.tags,
          'spoilerTags', ma.spoiler_tags,
          'attribution', ma.attribution,
          'sourceUrl', ma.source_url,
          'publicUrl', ma.public_url,
          'selectionSource', am.selection_source,
          'reviewStatus', CASE
            WHEN am.review_status = 'approved' AND ma.review_status = 'approved' THEN 'approved'
            WHEN am.review_status = 'rejected' THEN 'rejected'
            ELSE 'pending'
          END
        ) AS cover_media
        FROM public.article_media am JOIN public.media_assets ma ON ma.id = am.media_id
        WHERE am.article_id = a.id AND am.role = 'cover'
        LIMIT 1
      ) cover ON true
    WHERE (a.id = p_id_or_slug OR a.slug = p_id_or_slug)
      AND a.status IN ('published', 'updated')
    GROUP BY a.id, cover.cover_media
    ORDER BY a.created_at DESC
    LIMIT 1
  ) t
$$;

CREATE FUNCTION public_article_list(p_collection_id text) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog
AS $$
  SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb)
  FROM (
    SELECT a.*, COALESCE(jsonb_agg(DISTINCT jsonb_build_object('sourceId', ass.source_id, 'claimId', ass.claim_id, 'citationLabel', ass.citation_label, 'publicCitationUrl', ass.public_citation_url)) FILTER (WHERE ass.article_id IS NOT NULL), '[]') AS source_refs,
      cover.cover_media
    FROM public.articles a
      LEFT JOIN public.article_sources ass ON ass.article_id = a.id
      LEFT JOIN LATERAL (
        SELECT jsonb_build_object(
          'id', ma.id,
          'caption', ma.caption,
          'altText', ma.alt_text,
          'collection', ma.collection,
          'tags', ma.tags,
          'spoilerTags', ma.spoiler_tags,
          'attribution', ma.attribution,
          'sourceUrl', ma.source_url,
          'publicUrl', ma.public_url,
          'selectionSource', am.selection_source,
          'reviewStatus', CASE
            WHEN am.review_status = 'approved' AND ma.review_status = 'approved' THEN 'approved'
            WHEN am.review_status = 'rejected' THEN 'rejected'
            ELSE 'pending'
          END
        ) AS cover_media
        FROM public.article_media am JOIN public.media_assets ma ON ma.id = am.media_id
        WHERE am.article_id = a.id AND am.role = 'cover'
        LIMIT 1
      ) cover ON true
    WHERE a.game_id = p_collection_id
      AND a.status IN ('published', 'updated')
    GROUP BY a.id, cover.cover_media
    ORDER BY COALESCE(a.published_at, a.created_at) DESC
  ) t
$$;

-- Fenced community intake: the public role executes this function instead of
-- holding INSERT privileges on intake, moderation, or audit tables. The
-- initial state is forced to 'quarantined' and the moderation/audit trail is
-- created with the fixed system actor. Rate-limit excess raises SQLSTATE
-- SR001, which the adapter maps to the application's rate-limit error.
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
  p_retention_days integer,
  p_limit_ip integer,
  p_limit_session integer,
  p_limit_account integer,
  p_limit_global integer
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
  IF v_global_count >= p_limit_global
    OR v_ip_count >= p_limit_ip
    OR v_session_count >= p_limit_session
    OR (p_submitter_account_id IS NOT NULL AND v_account_count >= p_limit_account) THEN
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

REVOKE ALL ON FUNCTION public_article_get(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public_article_list(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public_submission_submit(text, text, text, text, text, text, jsonb, jsonb, text, integer, integer, integer, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_article_get(text) TO gameintel_public;
GRANT EXECUTE ON FUNCTION public_article_list(text) TO gameintel_public;
GRANT EXECUTE ON FUNCTION public_submission_submit(text, text, text, text, text, text, jsonb, jsonb, text, integer, integer, integer, integer, integer) TO gameintel_public;