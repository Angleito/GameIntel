import postgres, { type Sql } from "postgres";

export type Db = Sql<{}>;

type TransactionRunner = {
  begin?: (callback: (transaction: unknown) => Promise<unknown>) => Promise<unknown>;
  savepoint?: (callback: (transaction: unknown) => Promise<unknown>) => Promise<unknown>;
};

export async function inTransaction<T>(db: Db, callback: (transaction: Db) => Promise<T>): Promise<T> {
  const runner = db as unknown as TransactionRunner;
  const run = async (transaction: unknown): Promise<unknown> => callback(transaction as Db);
  // postgres.js exposes savepoints on transaction handles; use one rather than
  // attempting to start a nested top-level transaction.
  if (typeof runner.savepoint === "function") return await runner.savepoint(run) as T;
  if (typeof runner.begin === "function") return await runner.begin(run) as T;
  throw new Error("Database handle does not support transactions");
}

export function createDb(url = process.env.DATABASE_URL): Db {
  if (!url) throw new Error("DATABASE_URL is required");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL");
  }
  if (!(["postgres:", "postgresql:"].includes(parsed.protocol)) || !parsed.username || !parsed.password) {
    throw new Error("DATABASE_URL must include PostgreSQL credentials");
  }
  return postgres(url, { max: 5, idle_timeout: 20 });
}

export async function closeDb(db: Db): Promise<void> {
  await db.end({ timeout: 2 });
}
