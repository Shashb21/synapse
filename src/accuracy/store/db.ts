import { sql } from "drizzle-orm";
import { db } from "@/lib/iegp/db";
import { ACCURACY_DDL } from "./schema";

export { db as accuracyDb };

const globalAccuracy = globalThis as unknown as { accuracySchema?: Promise<void> };

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
  if (extra.length) {
    const d = db();
    for (const stmt of extra) {
      await d.execute(sql.raw(stmt));
    }
  }
}
