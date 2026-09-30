/** Accuracy database access and request-local atomic transaction context. */
import { AsyncLocalStorage } from "node:async_hooks";
import { sql } from "drizzle-orm";
import { db } from "@/lib/iegp/db";
import { ACCURACY_DDL, ACCURACY_MIGRATIONS } from "./schema";

type AccuracyDatabase = ReturnType<typeof db>;
type AccuracyTransaction = Parameters<Parameters<AccuracyDatabase["transaction"]>[0]>[0];
const transactionContext = new AsyncLocalStorage<AccuracyTransaction>();

/** Return the active transaction for this asynchronous request, or the pooled database. */
export function accuracyDb(): AccuracyDatabase | AccuracyTransaction {
  return transactionContext.getStore() ?? db();
}

/** Execute accuracy store calls atomically; nested calls join the existing transaction. */
export async function withAccuracyTransaction<T>(operation: () => Promise<T>): Promise<T> {
  await ensureAccuracySchema();
  if (transactionContext.getStore()) return operation();
  return db().transaction((tx) => transactionContext.run(tx, operation));
}

const globalAccuracy = globalThis as unknown as {
  accuracySchema?: Promise<void>;
  accuracyMigrated?: Promise<void>;
};

export async function ensureAccuracySchema(extra: string[] = []) {
  if (!globalAccuracy.accuracySchema) {
    globalAccuracy.accuracySchema = (async () => {
      const d = db();
      for (const stmt of [...ACCURACY_DDL, ...extra]) {
        await d.execute(sql.raw(stmt));
      }
    })();
  }
  await globalAccuracy.accuracySchema;
  if (!globalAccuracy.accuracyMigrated) {
    globalAccuracy.accuracyMigrated = (async () => {
      const d = db();
      for (const stmt of ACCURACY_MIGRATIONS) {
        await d.execute(sql.raw(stmt));
      }
    })();
  }
  await globalAccuracy.accuracyMigrated;
  if (extra.length) {
    const d = accuracyDb();
    for (const stmt of extra) {
      await d.execute(sql.raw(stmt));
    }
  }
}
