import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, poolSize, sharedDb, withWorkspaceTransaction, workspaceQueryCount } from "@/lib/iegp/db";
import * as t from "@/lib/iegp/schema";
import {
  allocateId,
  buildWorkspaceContents,
  createGap,
  loadState,
  persistState,
  resetBlank,
} from "@/lib/iegp/store";
import { createWorkspace, withWorkspace } from "@/modules/workspaces/store";

/**
 * KAN-14: schema DDL once per process, one snapshot read per load, no writes on render,
 * a configurable pool. KAN-15: multi-row writes are all or nothing; ids are never reissued.
 */
const ACTOR = { actor_name: "Integrity Tester", actor_function: "medical_affairs" as const };
let workspaceId = "";
const created: string[] = [];

const inWs = <T>(fn: () => Promise<T>) => withWorkspace(workspaceId, fn);

beforeAll(async () => {
  const ws = await createWorkspace({ name: "KAN-14/15 integrity", owner: `kan1415-${Date.now()}@example.com` });
  workspaceId = ws.id;
  created.push(ws.id);
  await inWs(() => resetBlank());
});

afterAll(async () => {
  for (const id of created) await sharedDb().execute(sql.raw(`DROP SCHEMA IF EXISTS "ws_${id}" CASCADE`));
});

const gap = (statement: string) =>
  createGap({ statement, domain: "safety", ...ACTOR });

describe("KAN-14 performance", () => {
  it("sizes pools from the environment, with defaults per platform", () => {
    expect(poolSize("workspace", { DATABASE_POOL_MAX: "7" })).toBe(7);
    expect(poolSize("platform", { DATABASE_PLATFORM_POOL_MAX: "3" })).toBe(3);
    expect(poolSize("workspace", { DATABASE_POOL_MAX: "0" })).toBe(10);
    expect(poolSize("workspace", { DATABASE_POOL_MAX: "lots" })).toBe(10);
    expect(poolSize("workspace", { VERCEL: "1" })).toBe(3);
    expect(poolSize("platform", { VERCEL: "1" })).toBe(2);
    expect(poolSize("workspace", { VITEST: "true" })).toBe(1);
  });

  it("loads a workspace with one read per table and no schema DDL once warm", async () => {
    await inWs(() => loadState());
    const before = workspaceQueryCount();
    await inWs(() => loadState());
    // 21 table reads plus begin/commit bookkeeping; the ~45 DDL statements are not repeated.
    expect(workspaceQueryCount() - before).toBeLessThanOrEqual(22);
  });

  it("pages render without writing: the need repair lives in the writes", () => {
    for (const page of ["src/app/page.tsx", "src/app/gaps/page.tsx", "src/app/gaps/[id]/page.tsx"]) {
      const source = readFileSync(path.join(process.cwd(), page), "utf8");
      expect(source).not.toMatch(/ensureAllLiveGapsHaveNeeds|ensureGapHasConstituentNeed/);
    }
  });

  it("older data with a needless gap is repaired once, on the first load, not on every render", async () => {
    // A fresh workspace no load has touched yet in this process.
    const ws = await createWorkspace({ name: "KAN-14 legacy", owner: `kan14-legacy-${Date.now()}@example.com` });
    created.push(ws.id);
    await withWorkspace(ws.id, async () => {
      const legacy = buildWorkspaceContents("blank");
      legacy.gaps = [
        {
          ...buildWorkspaceContents("demo").gaps[0]!,
          id: "GAP-900",
          number: 1,
          retired: false,
          parent_gap_id: null,
        },
      ];
      await persistState(legacy);
      const first = await loadState();
      expect(first.need_gap_links.filter((link) => link.gap_id === "GAP-900")).toHaveLength(1);
      const count = workspaceQueryCount();
      await loadState();
      expect(workspaceQueryCount() - count).toBeLessThanOrEqual(22);
    });
  });
});

describe("KAN-15 integrity", () => {
  it("rolls back every write in a failed transaction", async () => {
    await inWs(async () => {
      const before = (await loadState()).gaps.length;
      await expect(
        withWorkspaceTransaction(async () => {
          await gap("This gap must not survive the rollback.");
          expect((await loadState()).gaps.length).toBe(before + 1);
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect((await loadState()).gaps.length).toBe(before);
    });
  });

  it("a nested failure undoes only its own savepoint", async () => {
    await inWs(async () => {
      const before = (await loadState()).gaps.length;
      await withWorkspaceTransaction(async () => {
        await gap("Outer gap that commits.");
        await withWorkspaceTransaction(async () => {
          await gap("Inner gap that rolls back.");
          throw new Error("inner");
        }).catch(() => undefined);
      });
      const names = (await loadState()).gaps.map((g) => g.statement);
      expect(names).toContain("Outer gap that commits.");
      expect(names).not.toContain("Inner gap that rolls back.");
      expect(names.length).toBe(before + 1);
    });
  });

  it("work left running after a transaction ends does not use the finished transaction", async () => {
    await inWs(async () => {
      let late: Promise<unknown> = Promise.resolve();
      await withWorkspaceTransaction(async () => {
        late = new Promise((resolve) => setTimeout(resolve, 20)).then(() => loadState());
      });
      await expect(late).resolves.toBeTruthy();
    });
  });

  it("a reset that fails part-way leaves the old contents", async () => {
    await inWs(async () => {
      const gapId = await gap("Kept through a failed reset.");
      const broken = await loadState();
      // Two gaps with one id: the second insert fails after the wipe already ran.
      broken.gaps = [broken.gaps[0]!, { ...broken.gaps[0]! }];
      await expect(persistState(broken)).rejects.toThrow();
      expect((await loadState()).gaps.some((g) => g.id === gapId)).toBe(true);
    });
  });

  it("never reissues an id after a delete or a reset", async () => {
    await inWs(async () => {
      const first = await gap("Gap whose id is deleted.");
      const firstNumber = (await loadState()).gaps.find((g) => g.id === first)!.number;
      await db().delete(t.needGapLinks).where(eq(t.needGapLinks.gap_id, first));
      await db().delete(t.gaps).where(eq(t.gaps.id, first));
      const second = await gap("Gap made after the delete.");
      expect(second).not.toBe(first);
      expect((await loadState()).gaps.find((g) => g.id === second)!.number).toBeGreaterThan(firstNumber);

      await resetBlank();
      const third = await gap("Gap made after a reset.");
      expect([first, second]).not.toContain(third);
      expect(Number(third.slice(4))).toBeGreaterThan(Number(second.slice(4)));
    });
  });

  it("hands concurrent writers different ids", async () => {
    await inWs(async () => {
      const ids = await Promise.all(Array.from({ length: 8 }, () => allocateId("RES", [])));
      expect(new Set(ids).size).toBe(8);
    });
  });
});
