-- Public records use numbered citations. Internal claim identifiers are not a
-- public API and must be removed from records materialized before that rule.
UPDATE public_article_records record
SET body = jsonb_build_object(
  'summary', record.body->'summary',
  'sections', COALESCE((
    SELECT jsonb_agg(
      jsonb_set(
        section.value,
        '{paragraphs}',
        COALESCE((
          SELECT jsonb_agg(paragraph.value - 'claimIds' ORDER BY paragraph.ordinality)
          FROM jsonb_array_elements(section.value->'paragraphs') WITH ORDINALITY AS paragraph(value, ordinality)
        ), '[]'::jsonb),
        true
      )
      ORDER BY section.ordinality
    )
    FROM jsonb_array_elements(record.body->'sections') WITH ORDINALITY AS section(value, ordinality)
  ), '[]'::jsonb),
  'unknowns', record.body->'unknowns'
)
WHERE record.body ? 'sections';
