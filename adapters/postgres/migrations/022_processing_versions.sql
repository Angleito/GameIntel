-- Processing versions (plan section 11): every source revision records the
-- parser/normalization/claim-extraction implementation version that produced
-- it. This lets GameIntel answer "why does this revision say what it says?"
-- and "would reprocessing produce a different result?" without refetching.
ALTER TABLE source_item_revisions ADD COLUMN IF NOT EXISTS processing_version text;