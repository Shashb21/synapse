import { expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { sharedDb, ensurePlatformSchema } from "@/modules/kernel/db";
import {
  claimRevisionBatch,
  refreshRevisionBatch,
  sealRevisionBatch,
  releaseSealedBatch,
} from "@/modules/kernel/revision-attempts";
import { newId } from "@/modules/kernel/ids";

it("KAN-265 serializes claims and fences a stalled worker without discarding a scored regression", async () => {
  await ensurePlatformSchema();
  const workspace = "fixture-" + newId("ws"),
    revision = newId("prv");
  const results = await Promise.allSettled([
    claimRevisionBatch(workspace, revision),
    claimRevisionBatch(workspace, revision),
  ]);
  const successful = results.filter((r) => r.status === "fulfilled");
  expect(successful).toHaveLength(1);
  const first = successful[0].value;
  if (!("attempt" in first)) throw new Error("Expected a new claim");
  await sharedDb().execute(
    sql`update prompt_revision_attempts set lease_until=now()-interval '1 minute' where revision_id=${revision}`,
  );
  const retry = await claimRevisionBatch(workspace, revision);
  if (!("attempt" in retry)) throw new Error("Expected the interrupted batch to retry");
  await expect(refreshRevisionBatch(first.attempt)).rejects.toThrow("lost its claim");
  await refreshRevisionBatch(retry.attempt, { case_id: "fictional-case", repeat: 0 });
  await sharedDb().execute(
    sql`update prompt_revision_attempts set lease_until=now()-interval '1 minute' where revision_id=${revision}`,
  );
  await expect(claimRevisionBatch(workspace, revision)).rejects.toThrow("regressed");
});

it("KAN-265 returns the unchanged terminal observations to the next worker after postflight fails", async () => {
  await ensurePlatformSchema();
  const workspace = newId("ws"),
    revision = newId("prv");
  const first = await claimRevisionBatch(workspace, revision);
  if (!("attempt" in first)) throw new Error("Expected an initial worker");
  const sealed = {
    calls: [],
    observations: [],
    failures: ["unscored model answer"],
    interrupted: false,
    disqualified: false,
  };
  await sealRevisionBatch(first.attempt, sealed);
  await releaseSealedBatch(first.attempt);
  const second = await claimRevisionBatch(workspace, revision);
  expect(second).toMatchObject({ sealed });
  if (!("attempt" in second)) throw new Error("Expected a finalization worker");
  await expect(sealRevisionBatch(second.attempt, { ...sealed, failures: [] })).rejects.toThrow("lost its claim");
});
