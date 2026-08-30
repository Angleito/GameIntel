import { NORMALIZATION_VERSION, type GameProfile, type NormalizedSourceItem, type SourcePolicy } from "@gameintel/core";
import type { SourceInput } from "@gameintel/contracts";

export function testProfile(): GameProfile {
  return {
    id: "contract-test",
    canonicalName: "Contract Test Collection",
    aliases: ["ContractTest"],
    version: "1",
    capabilities: { story: true },
    categories: ["news"],
    spoilerSafeCategories: ["news"],
    platforms: [],
    sourceQueries: [],
  };
}

export function testPolicy(overrides: Partial<SourcePolicy> = {}): SourcePolicy {
  return {
    accessMode: "permitted_scrape",
    requestsPerMinute: 60,
    retainRawTextDays: 2,
    mayStoreFullText: false,
    attributionRequired: true,
    termsReviewedAt: null,
    evidenceReview: { minimumApprovals: 1, preventSubmitterApproval: true },
    ...overrides,
  };
}

export function testSourceInput(overrides: Partial<SourceInput> = {}): SourceInput {
  return {
    id: "contract-source",
    type: "permitted_scrape",
    canonicalUrl: "https://contract.example.com",
    publicCitationUrl: "https://contract.example.com/report",
    sourceStrength: "TRUSTED_SECONDARY",
    publicationMode: "normal",
    policy: testPolicy(),
    enabled: true,
    ...overrides,
  };
}

let sequence = 0;

export function testItem(sourceId = "contract-source", overrides: Partial<NormalizedSourceItem> = {}): NormalizedSourceItem {
  sequence += 1;
  const marker = `contract-${Date.now()}-${sequence}`;
  return {
    sourceId,
    collectionId: "contract-test",
    externalId: `external-${marker}`,
    url: `https://contract.example.com/items/${marker}`,
    title: `Contract test item ${marker}`,
    text: `Contract test item ${marker} describes an independently verified observation.`,
    sourceStrength: "TRUSTED_SECONDARY",
    publicationMode: "normal",
    discoveredAt: new Date().toISOString(),
    publishedAt: null,
    lineageId: `lineage-${marker}`,
    inputKind: "url",
    contentType: "text/html",
    language: "en",
    processingVersion: NORMALIZATION_VERSION,
    claims: [
      {
        subject: "Vehicle",
        predicate: "can spawn at",
        value: "the contract test location",
        qualifiers: {},
        spoilerTags: [],
        exploitClass: null,
        evidenceLevel: "suspected",
        attributionType: "trusted_secondary",
        statement: null,
        editorialAssessment: null,
        stance: "supports",
        evidenceType: "trusted_reporting",
        excerpt: "A verified observation at the contract test location.",
        startMs: null,
        endMs: null,
      },
    ],
    ...overrides,
  };
}