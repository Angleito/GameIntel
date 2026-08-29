ALTER TABLE claims ADD COLUMN IF NOT EXISTS evidence_level text NOT NULL DEFAULT 'suspected';
ALTER TABLE claims ADD COLUMN IF NOT EXISTS attribution_type text NOT NULL DEFAULT 'trusted_secondary';
ALTER TABLE claims ADD COLUMN IF NOT EXISTS statement text;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS editorial_assessment text;
