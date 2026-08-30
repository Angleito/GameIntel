import { describe, expect, test } from "bun:test";
import { hashText } from "@gameintel/core";
import { createAnalysisRun, createArticleDraft, createQuarantinedSubmission, ensureGame, ensureSource, enqueueSourceIngestJob, getArticle, getPublicArticle, insertClaim, insertSourceItem, listArticles, listPublicArticles, materializePublicArticle, setCoverMedia, closeDb, createDb, type Db } from "./index.ts";

// Privilege-boundary tests for the local reference deployment. They assert
// that the capability roles enforce the plan's hard rule: a public-facing
// process cannot possess storage permissions that allow it to directly
// approve evidence or publish content. Requires a migrated database and the
// three API logins (GAMEINTEL_TEST_POSTGRES=true); skipped by default so
// `bun test` runs without Docker or a database.

const enabled = process.env.GAMEINTEL_TEST_POSTGRES === "true";

function denied(run: () => Promise<unknown>): Promise<void> {
  return run().then(
    () => Promise.reject(new Error("Expected the database to deny this operation")),
    (error: unknown) => {
      const code = (error as { code?: string })?.code;
      // 42501: insufficient privilege; 42703: unprivileged column hidden as
      // nonexistent by PostgreSQL's privilege-aware column visibility.
      if (code !== "42501" && code !== "42703") throw error;
    },
  );
}

describe("PostgreSQL capability role privileges", () => {
  if (!enabled) {
    test("skipped; set GAMEINTEL_TEST_POSTGRES=true to run against the reference PostgreSQL deployment", () => {});
    return;
  }

  const publicUrl = process.env.PUBLIC_DATABASE_URL;
  const operatorUrl = process.env.OPERATOR_DATABASE_URL;
  const runtimeUrl = process.env.DATABASE_URL;
  const migrationUrl = process.env.MIGRATION_DATABASE_URL ?? runtimeUrl;
  if (!publicUrl || !operatorUrl || !runtimeUrl || !migrationUrl) {
    test("skipped; PUBLIC_DATABASE_URL, OPERATOR_DATABASE_URL, DATABASE_URL, and MIGRATION_DATABASE_URL are required", () => {});
    return;
  }

  async function cleanup(): Promise<void> {
    const db = createDb(migrationUrl);
    try {
      await db.begin(async (transaction) => {
        await transaction`
          DELETE FROM audit_log
          WHERE target_type = 'public_submission' AND target_id IN (SELECT id FROM public_submissions WHERE collection_id = 'privilege-test')
            OR (target_type = 'source' AND target_id = 'privilege-source')
            OR (target_type = 'article' AND target_id IN (SELECT id FROM articles WHERE game_id = 'privilege-test'))
        `;
        await transaction`DELETE FROM submission_moderation_actions WHERE submission_id IN (SELECT id FROM public_submissions WHERE collection_id = 'privilege-test')`;
        await transaction`DELETE FROM public_submissions WHERE collection_id = 'privilege-test'`;
        await transaction`DELETE FROM jobs WHERE payload::text LIKE '%privilege-test%'`;
        await transaction`DELETE FROM source_policy_reviews WHERE source_id = 'privilege-source'`;
        await transaction`DELETE FROM public_article_records WHERE collection_id = 'privilege-test'`;
        await transaction`DELETE FROM article_media WHERE article_id IN (SELECT id FROM articles WHERE game_id = 'privilege-test')`;
        await transaction`DELETE FROM article_sources WHERE article_id IN (SELECT id FROM articles WHERE game_id = 'privilege-test')`;
        await transaction`DELETE FROM article_revisions WHERE article_id IN (SELECT id FROM articles WHERE game_id = 'privilege-test')`;
        await transaction`DELETE FROM articles WHERE game_id = 'privilege-test'`;
        await transaction`DELETE FROM evidence WHERE source_item_id IN (SELECT id FROM source_items WHERE game_id = 'privilege-test')`;
        await transaction`
          DELETE FROM analysis_runs
          WHERE source_item_revision_id IN (SELECT id FROM source_item_revisions WHERE source_item_id IN (SELECT id FROM source_items WHERE game_id = 'privilege-test'))
        `;
        await transaction`DELETE FROM claims WHERE game_id = 'privilege-test'`;
        await transaction`DELETE FROM canonical_claims WHERE game_id = 'privilege-test'`;
        await transaction`DELETE FROM source_item_revisions WHERE source_item_id IN (SELECT id FROM source_items WHERE game_id = 'privilege-test')`;
        await transaction`DELETE FROM source_item_provenance WHERE source_item_id IN (SELECT id FROM source_items WHERE game_id = 'privilege-test')`;
        await transaction`DELETE FROM provenance_families WHERE collection_id = 'privilege-test'`;
        await transaction`DELETE FROM source_items WHERE game_id = 'privilege-test'`;
        await transaction`DELETE FROM media_assets WHERE game_id = 'privilege-test'`;
        await transaction`DELETE FROM sources WHERE id = 'privilege-source'`;
        await transaction`DELETE FROM games WHERE id = 'privilege-test'`;
      });
    } finally {
      await closeDb(db);
    }
  }

  async function setup(): Promise<void> {
    const db = createDb(migrationUrl);
    try {
      await ensureGame(db, {
        id: "privilege-test",
        canonicalName: "Privilege Test",
        aliases: [] as string[],
        version: "1",
        capabilities: { story: false, progression: false, onlineMode: false, map: false },
        categories: ["test"],
        spoilerSafeCategories: ["test"],
        defaultExploitMode: "intended_only",
        platforms: ["PC"],
        sourceQueries: [],
      });
    } finally {
      await closeDb(db);
    }
  }

  test("public role can submit a quarantined community report", async () => {
    await cleanup();
    await setup();
    const db = createDb(publicUrl);
    try {
      const result = await createQuarantinedSubmission(db, {
        submission: {
          collectionId: "privilege-test",
          title: "Privilege test report",
          report: "A community report used to prove the public intake surface.",
          urls: [],
          mediaRefs: [],
        },
        submitterSessionHash: "a".repeat(64),
        submitterIpHash: "b".repeat(64),
      });
      expect(result.id).toMatch(/^sub_/);
      expect(result.duplicate).toBe(false);
    } finally {
      await closeDb(db);
      await cleanup();
    }
  });

  test("public role reads only the sanitized public surface through the public-safe functions", async () => {
    const db = createDb(publicUrl);
    try {
      await denied(() => db`SELECT title FROM articles LIMIT 1`);
      await denied(() => db`SELECT title, body FROM articles WHERE status = 'draft' LIMIT 1`);
      await denied(() => db`SELECT id FROM article_sources LIMIT 1`);
      await denied(() => db`SELECT id FROM article_media LIMIT 1`);
      await denied(() => db`SELECT id FROM media_assets LIMIT 1`);
      await denied(() => db`SELECT id FROM public_article_records LIMIT 1`);
      const articles = await listPublicArticles(db, "privilege-test");
      expect(Array.isArray(articles)).toBe(true);
      const single = await getPublicArticle(db, "privilege-test");
      expect(single).toBeNull();
    } finally {
      await closeDb(db);
    }
  });

  test("public article functions expose only the sanitized public surface", async () => {
    await cleanup();
    await setup();
    const editor = createDb(runtimeUrl);
    let articleId = "";
    try {
      await ensureSource(editor, {
        id: "privilege-source",
        type: "operator-note",
        canonicalUrl: "urn:gameintelgg:source:privilege-source",
        publicCitationUrl: null,
        sourceStrength: "COMMUNITY",
        publicationMode: "evidence_only",
        policy: { accessMode: "manual", requestsPerMinute: 1, retainRawTextDays: 7, mayStoreFullText: false, attributionRequired: true, evidenceReview: { minimumApprovals: 1, preventSubmitterApproval: true } },
        enabled: true,
      });
      const surfaceItem = {
        sourceId: "privilege-source",
        collectionId: "privilege-test",
        externalId: "ext-surface",
        url: "urn:gameintelgg:manual:surface",
        title: "Surface item",
        text: "Surface text.",
        sourceStrength: "COMMUNITY" as const,
        publicationMode: "discussion_only" as const,
        discoveredAt: new Date().toISOString(),
        publishedAt: null,
        lineageId: null,
        inputKind: "pasted_text" as const,
        contentType: "text/plain",
        language: null,
        processingVersion: "1",
        claims: [],
      };
      const inserted = await insertSourceItem(editor, surfaceItem, hashText("surface"), "lineage-surface", {
        accessMode: "manual", requestsPerMinute: 1, retainRawTextDays: 7, mayStoreFullText: false, attributionRequired: true, termsReviewedAt: null, evidenceReview: { minimumApprovals: 1, preventSubmitterApproval: true },
      }, null);
      if (!inserted.revisionId) throw new Error("Expected a source revision");
      const run = await createAnalysisRun(editor, { sourceItemRevisionId: inserted.revisionId, versions: { normalizationVersion: "1", claimExtractorVersion: "1", confidenceModelVersion: "1" }, triggerReason: "privilege-test" });
      const claim = await insertClaim(editor, surfaceItem, inserted.id, inserted.revisionId, run.id, inserted.provenanceFamilyId, {
        subject: "Subject",
        predicate: "reports",
        value: "Value",
        qualifiers: {},
        spoilerTags: [],
        exploitClass: null,
        evidenceLevel: "suspected",
        attributionType: "community",
        statement: null,
        editorialAssessment: null,
        stance: "supports",
        evidenceType: "community_report",
        excerpt: "Surface excerpt.",
        startMs: null,
        endMs: null,
      }, "lineage-surface");
      const claimId = claim.claimId;
      articleId = await createArticleDraft(editor, {
        collectionId: "privilege-test",
        title: "Boundary article",
        description: "Boundary.",
        body: {
          summary: "Boundary summary.",
          sections: [
            { heading: "Public section", paragraphs: [{ text: "Public text.", evidenceLevel: "suspected", attributionType: "trusted_secondary", claimIds: [claimId], editorialAssessment: null }], publicSafe: true, spoilerTags: [] },
            { heading: "Internal note", paragraphs: [{ text: "Editorial-only detail.", evidenceLevel: "suspected", attributionType: "trusted_secondary", claimIds: [], editorialAssessment: null }], publicSafe: false, spoilerTags: [] },
            { heading: "Spoiler section", paragraphs: [{ text: "Spoiler detail.", evidenceLevel: "suspected", attributionType: "trusted_secondary", claimIds: [], editorialAssessment: null }], publicSafe: true, spoilerTags: ["spoiler"] },
          ],
          unknowns: [],
        },
        newsworthiness: 0.5,
        confidence: 0.5,
        sourceRefs: [{ sourceId: "privilege-source", claimId, citationLabel: "Privilege source", publicCitationUrl: "https://example.com/privilege-report" }],
      });
      await editor`INSERT INTO media_assets (id, game_id, collection, caption, alt_text, tags, spoiler_tags, attribution, source_url, source_page_url, original_key, display_key, public_url, content_type, width, height, checksum, review_status) VALUES ('media-privilege-cover', 'privilege-test', 'c', 'cap', 'alt', '[]', '[]', 'attr', 'https://example.com/src', 'https://example.com/page', 'o', 'd', 'https://media.example.com/cover', 'image/jpeg', 10, 10, 'sum', 'pending')`;
      await setCoverMedia(editor, articleId, "media-privilege-cover", "automatic");
      await editor`UPDATE articles SET status = 'published', approved_by = 'operator', approved_at = now(), published_at = now(), source_review_completed = true, editor_review_completed = true, article_sources_complete = true WHERE id = ${articleId}`;
      const article = await getArticle(editor, articleId);
      if (!article) throw new Error("Boundary article not found");
      await materializePublicArticle(editor, article);

      const raw = await editor`SELECT body, approved_by FROM articles WHERE id = ${articleId}`;
      expect(JSON.stringify(raw[0].body)).toContain("Internal note");
      expect(raw[0].approved_by).toBe("operator");

      const pub = createDb(publicUrl);
      try {
        const rows = await pub`SELECT public_public_article_get(${articleId}) AS article`;
        const record = rows[0]?.article as Record<string, unknown> | null;
        expect(record).not.toBeNull();
        const text = JSON.stringify(record ?? {});
        expect(text).not.toContain("Internal note");
        expect(text).not.toContain("Spoiler section");
        expect(text).not.toContain("approvedBy");
        expect(text).not.toContain("approved_by");
        expect(text).not.toContain("privilege-source");
        expect(record!.coverMedia).toBeNull();
        expect((record!.citations as Array<{ number: number; label: string; url: string }>)).toEqual([{ number: 1, label: "Privilege source", url: "https://example.com/privilege-report" }]);
        const viaAdapter = await getPublicArticle(pub, articleId);
        expect(viaAdapter?.body.sections.map((section) => section.heading)).toEqual(["Public section"]);
        const listed = await listPublicArticles(pub, "privilege-test");
        expect(listed).toHaveLength(1);
        const missing = await pub`SELECT public_public_article_get('no-such-article') AS article`;
        expect(missing[0].article).toBeNull();
      } finally {
        await closeDb(pub);
      }
    } finally {
      await closeDb(editor);
      await cleanup();
    }
  });

  test("public role cannot forge intake, moderation, or audit records", async () => {
    const db = createDb(publicUrl);
    try {
      await denied(() => db`INSERT INTO public_submissions (id, collection_id, submitter_session_hash, submitter_ip_hash, report, content_hash, state, created_at, updated_at) VALUES ('x', 'privilege-test', 'a', 'b', 'forged promoted report', 'c', 'promoted', now(), now())`);
      await denied(() => db`INSERT INTO public_submissions (id, collection_id, submitter_session_hash, submitter_ip_hash, report, content_hash, state, created_at, updated_at) VALUES ('x', 'privilege-test', 'a', 'b', 'forged rejected report', 'c', 'rejected', now(), now())`);
      await denied(() => db`INSERT INTO submission_moderation_actions (id, submission_id, actor_id, action, notes) VALUES ('x', 'y', 'attacker', 'promoted', 'forged')`);
      await denied(() => db`INSERT INTO audit_log (id, actor_id, action, target_type, target_id, reason) VALUES ('x', 'attacker', 'submission.promoted', 'public_submission', 'y', 'forged')`);
      await denied(() => db`UPDATE public_submissions SET state = 'promoted' WHERE id = 'none'`);
    } finally {
      await closeDb(db);
    }
  });

  test("public role cannot approve evidence, review articles, publish, or enqueue", async () => {
    const db = createDb(publicUrl);
    try {
      await denied(() => db`INSERT INTO evidence_reviews (id, evidence_id, source_item_revision_id, reviewer_id, decision) VALUES ('x', 'y', 'z', 'operator', 'approved')`);
      await denied(() => db`INSERT INTO reviews (id, target_type, target_id, reviewer_id, decision) VALUES ('x', 'article', 'y', 'operator', 'approved')`);
      await denied(() => db`UPDATE articles SET status = 'published' WHERE id = 'none'`);
      await denied(() => db`UPDATE public_submissions SET state = 'promoted' WHERE id = 'none'`);
      await denied(() => db`INSERT INTO jobs (job_key, job_type, status, payload) VALUES ('x', 'source_ingest', 'queued', '{}')`);
      await denied(() => db`INSERT INTO source_items (id, source_id, game_id, external_id, url, title, text_excerpt, raw_hash, lineage_id) VALUES ('x', 'y', 'privilege-test', 'z', 'u', 't', 'e', 'h', 'l')`);
    } finally {
      await closeDb(db);
    }
  });

  test("operator role can enqueue durable ingestion jobs", async () => {
    await cleanup();
    const db = createDb(operatorUrl);
    try {
      const result = await enqueueSourceIngestJob(db, {
        collectionId: "privilege-test",
        sourceId: "privilege-source",
        url: "https://example.com/privilege",
        profileId: "privilege-test",
      });
      expect(result.jobKey).toMatch(/^source_ingest_/);
      expect(result.duplicate).toBe(false);
    } finally {
      await closeDb(db);
      await cleanup();
    }
  });

  test("operator role cannot create evidence reviews, article reviews, policy reviews, or media approvals", async () => {
    const db = createDb(operatorUrl);
    try {
      await denied(() => db`INSERT INTO evidence_reviews (id, evidence_id, source_item_revision_id, reviewer_id, decision) VALUES ('x', 'y', 'z', 'operator', 'approved')`);
      await denied(() => db`INSERT INTO reviews (id, target_type, target_id, reviewer_id, decision) VALUES ('x', 'article', 'y', 'operator', 'approved')`);
      await denied(() => db`INSERT INTO source_policy_reviews (id, source_id, reviewer_id, decision) VALUES ('x', 'y', 'operator', 'approved')`);
      await denied(() => db`INSERT INTO media_assets (id, game_id, collection, caption, review_status) VALUES ('x', 'privilege-test', 'c', 'cap', 'approved')`);
      await denied(() => db`UPDATE media_assets SET review_status = 'approved' WHERE id = 'none'`);
    } finally {
      await closeDb(db);
    }
  });

  test("public role cannot read internal knowledge-base tables or submission identity columns", async () => {
    const db = createDb(publicUrl);
    try {
      await denied(() => db`SELECT report FROM public_submissions LIMIT 1`);
      await denied(() => db`SELECT submitter_session_hash FROM public_submissions LIMIT 1`);
      await denied(() => db`SELECT submitter_ip_hash FROM public_submissions LIMIT 1`);
      await denied(() => db`SELECT submitter_account_id FROM public_submissions LIMIT 1`);
      await denied(() => db`SELECT title FROM source_items LIMIT 1`);
      await denied(() => db`SELECT id FROM source_item_revisions LIMIT 1`);
      await denied(() => db`SELECT id FROM claims LIMIT 1`);
      await denied(() => db`SELECT id FROM evidence LIMIT 1`);
      await denied(() => db`SELECT id FROM evidence_reviews LIMIT 1`);
      await denied(() => db`SELECT id FROM article_revisions LIMIT 1`);
      await denied(() => db`SELECT id FROM provenance_families LIMIT 1`);
      await denied(() => db`SELECT id FROM source_item_provenance LIMIT 1`);
      await denied(() => db`SELECT id FROM submission_moderation_actions LIMIT 1`);
      await denied(() => db`SELECT id FROM audit_log LIMIT 1`);
      await denied(() => db`SELECT id FROM events LIMIT 1`);
    } finally {
      await closeDb(db);
    }
  });

  test("public role cannot read public_submissions directly, even through the intake functions' table", async () => {
    const db = createDb(publicUrl);
    try {
      await denied(() => db`SELECT id FROM public_submissions LIMIT 1`);
      await denied(() => db`SELECT content_hash FROM public_submissions LIMIT 1`);
    } finally {
      await closeDb(db);
    }
  });

  test("operator role can read articles including drafts for the operator listing", async () => {
    const db = createDb(operatorUrl);
    try {
      const rows = await db`SELECT id, status FROM articles WHERE game_id = 'privilege-test' LIMIT 1`;
      expect(Array.isArray(rows)).toBe(true);
    } finally {
      await closeDb(db);
    }
  });

  test("operator role cannot create or mutate articles or bypass the publication boundary", async () => {
    const db = createDb(operatorUrl);
    try {
      await denied(() => db`UPDATE articles SET status = 'published' WHERE id = 'none'`);
      await denied(() => db`UPDATE articles SET published_at = now() WHERE id = 'none'`);
      await denied(() => db`UPDATE articles SET confidence = 1 WHERE id = 'none'`);
      await denied(() => db`INSERT INTO articles (id, game_id, slug, title, seo_title, description, body, status, newsworthiness, confidence) VALUES ('x', 'privilege-test', 's', 't', 't', 'd', '{}', 'draft', 0, 0)`);
      await denied(() => db`INSERT INTO article_revisions (id, article_id, revision_number, body, change_summary) VALUES ('x', 'y', 1, '{}', '')`);
      await denied(() => db`INSERT INTO article_sources (id, article_id, source_id, citation_label, public_citation_url) VALUES ('x', 'y', 'z', 'l', 'https://example.com')`);
      await denied(() => db`INSERT INTO article_media (article_id, media_id, role, selection_source, review_status) VALUES ('x', 'y', 'cover', 'automatic', 'pending')`);
    } finally {
      await closeDb(db);
    }
  });

  test("bootstrap logins are members of exactly one capability group", async () => {
    const appUsername = new URL(runtimeUrl).username;
    const operatorUsername = new URL(operatorUrl).username;
    const publicUsername = new URL(publicUrl).username;
    const db = createDb(migrationUrl);
    try {
      const memberships = await db`
        SELECT pg_roles.rolname AS member, member_of.rolname AS group_role
        FROM pg_auth_members
        JOIN pg_roles pg_roles ON pg_roles.oid = pg_auth_members.member
        JOIN pg_roles member_of ON member_of.oid = pg_auth_members.roleid
        WHERE member_of.rolname IN ('gameintel_runtime', 'gameintel_operator', 'gameintel_public')
          AND pg_roles.rolname IN (${appUsername}, ${operatorUsername}, ${publicUsername})
      `;
      const groupsOf = (username: string) => memberships.filter((row) => row.member === username).map((row) => row.group_role as string);
      expect(groupsOf(publicUsername)).toEqual(["gameintel_public"]);
      expect(groupsOf(operatorUsername)).toEqual(["gameintel_operator"]);
      const appGroups = groupsOf(appUsername);
      if (appGroups.length > 0) expect(appGroups).toEqual(["gameintel_runtime"]);
      const grouped = new Map<string, string[]>();
      for (const row of memberships) {
        const member = row.member as string;
        grouped.set(member, [...(grouped.get(member) ?? []), row.group_role as string]);
      }
      for (const groups of grouped.values()) expect(groups).toHaveLength(1);
      const capabilityGroups = new Set(["gameintel_runtime", "gameintel_operator", "gameintel_public"]);
      for (const group of memberships.map((row) => row.group_role as string)) {
        expect(capabilityGroups.has(group)).toBe(true);
      }
      for (const username of [appUsername, operatorUsername, publicUsername]) {
        expect(capabilityGroups.has(username)).toBe(false);
      }
    } finally {
      await closeDb(db);
    }
  });

  test("capability group roles are never application logins", async () => {
    const db = createDb(migrationUrl);
    try {
      const roles = await db`
        SELECT rolname, rolcanlogin
        FROM pg_roles
        WHERE rolname IN ('gameintel_runtime', 'gameintel_operator', 'gameintel_public')
      `;
      expect(roles).toHaveLength(3);
      for (const role of roles) {
        expect(role.rolcanlogin).toBe(false);
      }
    } finally {
      await closeDb(db);
    }
  });

  test("runtime role retains editorial write access", async () => {
    await cleanup();
    const db = createDb(runtimeUrl);
    try {
      await ensureSource(db, {
        id: "privilege-source",
        type: "operator-note",
        canonicalUrl: "urn:gameintelgg:source:privilege-source",
        publicCitationUrl: null,
        sourceStrength: "COMMUNITY",
        publicationMode: "evidence_only",
        policy: { accessMode: "manual", requestsPerMinute: 1, retainRawTextDays: 7, mayStoreFullText: false, attributionRequired: true, evidenceReview: { minimumApprovals: 1, preventSubmitterApproval: true } },
        enabled: true,
      });
      await db`INSERT INTO source_policy_reviews (id, source_id, reviewer_id, decision, notes) VALUES ('privilege-policy-review', 'privilege-source', 'operator', 'approved', '')`;
      await db`DELETE FROM source_policy_reviews WHERE id = 'privilege-policy-review'`;
    } finally {
      await closeDb(db);
      await cleanup();
    }
  });
});
