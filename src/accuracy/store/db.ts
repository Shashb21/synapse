import { sql } from "drizzle-orm";
import { sharedDb as db } from "@/lib/iegp/db";
import { ACCURACY_DDL, ACCURACY_MIGRATIONS } from "./schema";

export { db as accuracyDb };

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
    const d = db();
    for (const stmt of extra) {
      await d.execute(sql.raw(stmt));
    }
  }
}
