import { z } from "zod";
import { normalizePredicate } from "@gameintel/core";
import type { GameIntelPersistence } from "@gameintel/contracts";

// Guides are operator-authored projections of canonical knowledge: a query
// over entities and their relationships, materialized as a claim set. The
// spec stays declarative; rendering is a follow-up concern. Publishing
// remains the human review boundary (see publishGuide in the adapters).
export const GuideSpecSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  query: z.object({
    subjectType: z.string().min(1),
    properties: z.record(z.string(), z.string()).default({}),
    predicate: z.string().optional(),
    minState: z.enum(["unverified", "supported", "contested", "confirmed"]).default("supported"),
    build: z.string().nullable().default(null),
  }),
  sections: z.array(z.object({
    heading: z.string(),
    text: z.string(),
  })).default([]),
}).strict();
export type GuideSpec = z.infer<typeof GuideSpecSchema>;

const STATE_RANK: Record<string, number> = { unverified: 0, supported: 1, contested: 2, confirmed: 3 };

export async function generateGuide(
  persistence: GameIntelPersistence,
  spec: GuideSpec,
  collectionId: string,
): Promise<{ guideId: string; claimCount: number }> {
  const entities = await persistence.findEntities({
    collectionId,
    type: spec.query.subjectType,
    properties: spec.query.properties,
  });
  const entityIds = new Set(entities.map((entity) => entity.id));
  const relationships = await persistence.findRelationships({
    collectionId,
    subjectType: spec.query.subjectType,
    predicate: spec.query.predicate,
    build: spec.query.build,
  });
  const minRank = STATE_RANK[spec.query.minState];
  const claimRefs = relationships
    .filter((relationship) => entityIds.has(relationship.subject?.id ?? "") && STATE_RANK[relationship.state] >= minRank)
    .map((relationship) => relationship.claimId);
  if (!claimRefs.length) throw new Error(`Guide query matched no claims (${spec.query.subjectType}${spec.query.predicate ? ` ${normalizePredicate(spec.query.predicate)}` : ""}, minState ${spec.query.minState})`);
  const guideId = await persistence.createGuideDraft({
    collectionId,
    title: spec.title,
    description: spec.description,
    spec: spec as unknown as Record<string, unknown>,
    claimRefs,
  });
  return { guideId, claimCount: claimRefs.length };
}
