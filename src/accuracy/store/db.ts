/** Accuracy database access and request-local atomic transaction context. */
import { AsyncLocalStorage } from "node:async_hooks";
import { sql } from "drizzle-orm";
import { sharedDb as db } from "@/lib/iegp/db";
import { ACCURACY_DDL, ACCURACY_MIGRATIONS } from "./schema";

type AccuracyDatabase = ReturnType<typeof db>;
type AccuracyTransaction = Parameters<Parameters<AccuracyDatabase["transaction"]>[0]>[0];
type AccuracyTransactionConfig = Parameters<AccuracyDatabase["transaction"]>[1];
const transactionContext = new AsyncLocalStorage<AccuracyTransaction>();

/** Typed failure for a transaction option that cannot be applied to a joined transaction. */
export class AccuracyTransactionError extends Error {
  constructor(readonly code: "nested_config_unsupported", message: string) {
    super(message);
    this.name = "AccuracyTransactionError";
  }
}

/** Return whether the current asynchronous request is already inside an accuracy transaction. */
export function accuracyTransactionActive(): boolean {
  return Boolean(transactionContext.getStore());
}

/** Return the active transaction for this asynchronous request, or the pooled database. */
export function accuracyDb(): AccuracyDatabase | AccuracyTransaction {
  return transactionContext.getStore() ?? db();
}

/** Execute accuracy store calls atomically; nested calls join the existing transaction. */
export async function withAccuracyTransaction<T>(
  operation: () => Promise<T>,
  config?: AccuracyTransactionConfig,
): Promise<T> {
  await ensureAccuracySchema();
  if (transactionContext.getStore()) {
    if (config && Object.keys(config).length > 0) {
      throw new AccuracyTransactionError(
        "nested_config_unsupported",
        "Cannot apply transaction configuration to an already active accuracy transaction.",
      );
    }
    return operation();
  }
  return db().transaction((tx) => transactionContext.run(tx, operation), config);
}

const globalAccuracy = globalThis as unknown as {
  accuracySchema?: Promise<void>;
  accuracyMigrated?: Promise<void>;
};

/** Runs `statements` once per process; a failure is forgotten so the next call retries. */
function once(key: "accuracySchema" | "accuracyMigrated", statements: string[]): Promise<void> {
  if (!globalAccuracy[key]) {
    const attempt = (async () => {
      const d = db();
      for (const stmt of statements) {
        await d.execute(sql.raw(stmt));
      }
    })();
    globalAccuracy[key] = attempt;
    attempt.catch(() => {
      if (globalAccuracy[key] === attempt) globalAccuracy[key] = undefined;
    });
  }
  return globalAccuracy[key]!;
}

export async function ensureAccuracySchema(extra: string[] = []) {
  await once("accuracySchema", [...ACCURACY_DDL, ...extra]);
  await once("accuracyMigrated", ACCURACY_MIGRATIONS);
  if (extra.length) {
    const d = accuracyDb();
    for (const stmt of extra) {
      await d.execute(sql.raw(stmt));
    }
  }
}
