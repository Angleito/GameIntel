import {
  CLAIM_EXTRACTOR_VERSION,
  canonicalClaimKey,
  trustClassificationFor,
  type NormalizedSourceItem,
  type SourceStrength,
} from "@gameintel/core";

export { CLAIM_EXTRACTOR_VERSION, canonicalClaimKey, canonicalizeClaimText } from "@gameintel/core";

export type ExtractedClaim = NormalizedSourceItem["claims"][number];

// Versioned claim extraction (plan section 1). Extraction is a pure function
// of the retained source content so that a stored source revision can be
// reprocessed by a later extractor version without refetching: the same
// versioned code runs for first ingestion, for reruns, and for explicit
// reprocessing. Bump CLAIM_EXTRACTOR_VERSION when the behavior changes.
//
// Extractors must keep qualifiers strictly semantic (time, platform, build,
// ...). Transport details such as input kind or review status belong on the
// source item and in evidence provenance; putting them in qualifiers would
// split semantically identical claims into separate canonical identities.
export function extractClaims(item: Pick<NormalizedSourceItem, "title" | "text" | "inputKind" | "claims">, sourceStrength: SourceStrength): ExtractedClaim[] {
  if (item.claims.length > 0) return item.claims as ExtractedClaim[];
  if (item.inputKind === "manual_fixture") return [];
  const trust = trustClassificationFor(sourceStrength);
  const value = item.text.split(/(?<=[.!?])\s+/, 1)[0].slice(0, 500) || item.text.slice(0, 500);
  if (!value) return [];
  return [{
    subject: item.title,
    predicate: "reports",
    value,
    qualifiers: {},
    spoilerTags: [],
    exploitClass: null,
    evidenceLevel: "suspected",
    attributionType: trust.attributionType,
    statement: null,
    editorialAssessment: null,
    stance: "supports",
    evidenceType: trust.evidenceType,
    excerpt: value,
    startMs: null,
    endMs: null,
  }];
}