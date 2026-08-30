import { describe, test } from "bun:test";
import { runPersistenceContract, runQueueContract } from "@gameintel/adapter-contract-tests";
import { closeDb, createDb, type Db } from "./index.ts";
import { PostgresJobQueue, PostgresPersistence } from "./adapter.ts";

// Conformance suite for the PostgreSQL reference adapter. Requires a migrated
// database (GAMEINTEL_TEST_POSTGRES=true); skipped by default so `bun test`
// runs without Docker or a database.

function cleanupContractData(db: Db): Promise<void> {
  return db.begin(async (transaction) => {
    await transaction`
      DELETE FROM audit_log
      WHERE (target_type = 'article' AND target_id IN (SELECT id FROM articles WHERE game_id = 'contract-test'))
        OR (target_type = 'public_submission' AND target_id IN (SELECT id FROM public_submissions WHERE collection_id = 'contract-test'))
        OR (target_type = 'evidence' AND target_id IN (SELECT e.id FROM evidence e JOIN source_items si ON si.id = e.source_item_id WHERE si.game_id = 'contract-test'))
        OR (target_type = 'source' AND target_id = 'contract-source')
    `;
    await transaction`DELETE FROM source_item_provenance WHERE source_item_id IN (SELECT id FROM source_items WHERE game_id = 'contract-test')`;
    await transaction`
      DELETE FROM provenance_relationships
      WHERE source_item_id IN (SELECT id FROM source_items WHERE game_id = 'contract-test')
        OR related_source_item_id IN (SELECT id FROM source_items WHERE game_id = 'contract-test')
    `;
    await transaction`DELETE FROM evidence_reviews WHERE evidence_id IN (SELECT e.id FROM evidence e JOIN source_items si ON si.id = e.source_item_id WHERE si.game_id = 'contract-test')`;
    await transaction`DELETE FROM article_media WHERE article_id IN (SELECT id FROM articles WHERE game_id = 'contract-test')`;
    await transaction`DELETE FROM article_sources WHERE article_id IN (SELECT id FROM articles WHERE game_id = 'contract-test')`;
    await transaction`DELETE FROM article_revisions WHERE article_id IN (SELECT id FROM articles WHERE game_id = 'contract-test')`;
    await transaction`DELETE FROM public_article_records WHERE collection_id = 'contract-test'`;
    await transaction`DELETE FROM articles WHERE game_id = 'contract-test'`;
    await transaction`DELETE FROM events WHERE game_id = 'contract-test'`;
    await transaction`DELETE FROM evidence WHERE source_item_id IN (SELECT id FROM source_items WHERE game_id = 'contract-test')`;
    await transaction`
      DELETE FROM analysis_runs
      WHERE source_item_revision_id IN (SELECT id FROM source_item_revisions WHERE source_item_id IN (SELECT id FROM source_items WHERE game_id = 'contract-test'))
    `;
    await transaction`DELETE FROM claims WHERE game_id = 'contract-test'`;
    await transaction`DELETE FROM canonical_claims WHERE game_id = 'contract-test'`;
    await transaction`DELETE FROM media_assets WHERE game_id = 'contract-test'`;
    await transaction`DELETE FROM submission_moderation_actions WHERE submission_id IN (SELECT id FROM public_submissions WHERE collection_id = 'contract-test')`;
    await transaction`DELETE FROM public_submissions WHERE collection_id = 'contract-test'`;
    await transaction`DELETE FROM source_item_revisions WHERE source_item_id IN (SELECT id FROM source_items WHERE game_id = 'contract-test')`;
    await transaction`DELETE FROM provenance_families WHERE collection_id = 'contract-test'`;
    await transaction`DELETE FROM source_items WHERE game_id = 'contract-test'`;
    await transaction`DELETE FROM source_policy_reviews WHERE source_id = 'contract-source'`;
    await transaction`DELETE FROM source_fetch_pacing WHERE source_id = 'contract-source'`;
    await transaction`DELETE FROM jobs WHERE payload::text LIKE '%contract-test%'`;
    await transaction`DELETE FROM ingestion_worker_heartbeats WHERE worker_id IN ('worker-a', 'worker-b', 'crashed-worker', 'replacement-worker')`;
    await transaction`DELETE FROM sources WHERE id = 'contract-source'`;
    await transaction`DELETE FROM games WHERE id = 'contract-test'`;
  });
}

describe("PostgreSQL adapter conformance", () => {
  const enabled = process.env.GAMEINTEL_TEST_POSTGRES === "true";

  if (!enabled) {
    test("skipped; set GAMEINTEL_TEST_POSTGRES=true to run against the reference PostgreSQL deployment", () => {});
    return;
  }

  async function factory() {
    const db = createDb();
    return {
      persistence: new PostgresPersistence(db),
      queue: new PostgresJobQueue(db),
      expireLease: (jobKey: string) => db`UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE job_key = ${jobKey}`.then(() => undefined),
      close: async () => {
        await cleanupContractData(db);
        await closeDb(db);
      },
    };
  }

  runPersistenceContract(factory);
  runQueueContract(factory);
});