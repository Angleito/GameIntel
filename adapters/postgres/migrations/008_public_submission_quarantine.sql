-- Public reports are intentionally isolated from source_items, claims, and
-- public output until an editorial workflow explicitly promotes them.
CREATE TABLE IF NOT EXISTS public_submissions (
  id text PRIMARY KEY,
  collection_id text NOT NULL REFERENCES games(id),
  submitter_account_id text,
  submitter_session_hash text NOT NULL,
  submitter_ip_hash text NOT NULL,
  title text,
  report text NOT NULL,
  urls jsonb NOT NULL DEFAULT '[]',
  media_refs jsonb NOT NULL DEFAULT '[]',
  content_hash text NOT NULL,
  state text NOT NULL DEFAULT 'quarantined' CHECK (state IN ('quarantined', 'under_review', 'rejected', 'promoted', 'blocked', 'expired')),
  retention_until timestamptz NOT NULL,
  content_purged_at timestamptz,
  promoted_source_item_id text REFERENCES source_items(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS submission_moderation_actions (
  id text PRIMARY KEY,
  submission_id text NOT NULL REFERENCES public_submissions(id),
  actor_id text NOT NULL,
  action text NOT NULL,
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS public_submissions_state_idx
  ON public_submissions (collection_id, state, created_at DESC);
CREATE INDEX IF NOT EXISTS public_submissions_session_rate_idx
  ON public_submissions (submitter_session_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS public_submissions_ip_rate_idx
  ON public_submissions (submitter_ip_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS public_submissions_account_rate_idx
  ON public_submissions (submitter_account_id, created_at DESC)
  WHERE submitter_account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS public_submissions_retention_idx
  ON public_submissions (retention_until)
  WHERE content_purged_at IS NULL;
CREATE INDEX IF NOT EXISTS submission_moderation_actions_submission_idx
  ON submission_moderation_actions (submission_id, created_at DESC);
