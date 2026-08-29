-- The operator promotion pipeline upserts provenance families
-- (INSERT ... ON CONFLICT DO UPDATE), which requires UPDATE on the table.
GRANT UPDATE ON provenance_families TO gameintel_operator;