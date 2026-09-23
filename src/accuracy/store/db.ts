import { sql } from "drizzle-orm";
import { db } from "@/lib/iegp/db";
import { ACCURACY_DDL, ACCURACY_MIGRATIONS } from "./schema";

export { db as accuracyDb };

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
    const d = db();
    for (const stmt of extra) {
      await d.execute(sql.raw(stmt));
    }
  }
}
