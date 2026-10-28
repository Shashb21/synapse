/** Browser feedback and retry state; persistence behavior is covered by real-DB Vitest tests. */
import { expect, test, type APIRequestContext } from "@playwright/test";
import { workspaceUrl } from "../support/accuracy";

// A cold Next compilation may exceed the default 30 seconds.
test.setTimeout(90_000);

/** Seed only the blocks this UI scenario needs through the real workspace/manual-source APIs. */
async function seedSource(request: APIRequestContext, blockCount: number) {
  const slug = `extract-${crypto.randomUUID()}`;
  const workspaceResponse = await request.post("/api/accuracy/workspaces", {
    data: { name: "E2E extraction", slug },
  });
  expect(workspaceResponse.ok(), await workspaceResponse.text()).toBeTruthy();
  const { workspace_id } = await workspaceResponse.json() as { workspace_id: string };
  const sourceResponse = await request.post("/api/accuracy/sources/blocks", {
    data: { action: "manual_source", workspace_id, filename: "extraction-notes.txt",
      blocks: Array.from({ length: blockCount }, (_, index) => ({ text: `Evidence block ${index + 1}` })),
      rationale: "Browser extraction fixture",
    },
  });
  expect(sourceResponse.ok(), await sourceResponse.text()).toBeTruthy();
  const { source_file_id, block_ids } = await sourceResponse.json() as { source_file_id: string; block_ids: string[] };
  expect(block_ids).toHaveLength(blockCount);
  return { workspace_id, source_file_id };
}

test("source extraction continues from partial progress and retries the same failed continuation", async ({ page, request }) => {
  const seed = await seedSource(request, 81);
  const continuation = { workspace_id: seed.workspace_id, source_file_id: seed.source_file_id, snapshot: "browser-fixture", offset: 80, kinds: ["need"] };
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  let calls = 0;
  await page.route("**/api/accuracy/extract", async (route) => {
    const body = route.request().postDataJSON();
    calls += 1;
    expect(body.kinds).toEqual(["need"]);
    if (calls === 1) {
      expect(body.continuation).toBeUndefined();
      await route.fulfill({ json: { ok: true, status: "partial", complete: false, block_count: 81, blocks_used: 80, blocks_processed: 80, continuation, gaps_inserted: 0, tactics_inserted: 0, stub: true } });
    } else {
      expect(body.continuation).toEqual(continuation);
      if (calls === 2) await route.fulfill({ status: 400, json: { ok: false, status: "failed", error: "Provider unavailable. Try again.", continuation, blocks_processed: 80 } });
      else await route.fulfill({ json: { ok: true, status: "complete", complete: true, block_count: 81, blocks_used: 1, blocks_processed: 81, continuation: null, gaps_inserted: 1, tactics_inserted: 0, stub: true } });
    }
  });
  await page.goto(workspaceUrl("/admin/accuracy/sources", seed.workspace_id));
  await page.getByRole("button", { name: "Needs only", exact: true }).first().click();
  await expect.poll(() => calls, { message: `Extraction request must reach the route; page errors: ${pageErrors.join("; ")}` }).toBe(1);
  await expect(page.getByRole("status").filter({ hasText: "80 of 81" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "stub LLM" })).toBeVisible();
  await page.getByRole("button", { name: "Continue extraction", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Extraction failed" })).toContainText("Provider unavailable");
  await page.getByRole("button", { name: "Retry extraction", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Extraction complete" })).toContainText("81 of 81");
  await expect(page.getByRole("button", { name: "Continue extraction", exact: true })).toHaveCount(0);
});

test("source extraction retains retry state after transport and malformed JSON failures", async ({ page, request }) => {
  const seed = await seedSource(request, 1);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  let calls = 0;
  await page.route("**/api/accuracy/extract", async (route) => {
    calls += 1;
    if (calls === 1) await route.abort("failed");
    else if (calls === 2) await route.fulfill({ status: 200, contentType: "text/html", body: "Unavailable" });
    else await route.fulfill({ json: { ok: true, complete: true, block_count: 1, blocks_processed: 1, continuation: null, stub: true } });
  });
  await page.goto(workspaceUrl("/admin/accuracy/sources", seed.workspace_id));
  await page.getByRole("button", { name: "Inventory only", exact: true }).first().click();
  await expect.poll(() => calls, { message: `Extraction request must reach the route; page errors: ${pageErrors.join("; ")}` }).toBe(1);
  await expect(page.getByRole("alert").filter({ hasText: "Extraction failed" })).toContainText("Could not reach");
  await page.getByRole("button", { name: "Retry extraction", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Extraction failed" })).toContainText("Extract failed");
  await page.getByRole("button", { name: "Retry extraction", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Extraction complete" })).toBeVisible();
});
