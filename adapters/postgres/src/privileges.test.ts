import { describe, expect, test } from "bun:test";
import { createQuarantinedSubmission, ensureGame, ensureSource, enqueueSourceIngestJob, closeDb, createDb, type Db } from "./index.ts";

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
        `;
        await transaction`DELETE FROM submission_moderation_actions WHERE submission_id IN (SELECT id FROM public_submissions WHERE collection_id = 'privilege-test')`;
        await transaction`DELETE FROM public_submissions WHERE collection_id = 'privilege-test'`;
        await transaction`DELETE FROM jobs WHERE payload::text LIKE '%privilege-test%'`;
        await transaction`DELETE FROM source_policy_reviews WHERE source_id = 'privilege-source'`;
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

  test("public role can read published article surface", async () => {
    const db = createDb(publicUrl);
    try {
      const articles = await db`SELECT id FROM articles WHERE game_id = 'privilege-test' LIMIT 1`;
      expect(Array.isArray(articles)).toBe(true);
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