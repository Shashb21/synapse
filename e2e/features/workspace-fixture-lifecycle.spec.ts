/** Fresh-workspace fixtures release their own data without deleting other workspaces. */
import { expect, test } from "@playwright/test";
import { freshWorkspace, listWorkspaces } from "../support/session";

// The post-teardown assertion depends on the preceding fixture journey, including on retries.
test.describe.configure({ mode: "serial" });

let fixtureId: string;
let existingIds: string[];

test.describe("fresh workspace lifecycle", () => {
  test.beforeAll(async ({ request }) => {
    existingIds = (await listWorkspaces(request)).map(workspace => workspace.id);
  });
  const workspace = freshWorkspace({ name: "Lifecycle regression" });
  test("creates and selects a dedicated workspace", async ({ request }) => {
    fixtureId = workspace.id;
    expect((await listWorkspaces(request)).some(row => row.id === fixtureId)).toBe(true);
    expect(existingIds).not.toContain(fixtureId);
  });
});

test("removes the finished fixture and preserves pre-existing workspaces", async ({ request }) => {
  const remainingIds = (await listWorkspaces(request)).map(workspace => workspace.id);
  expect(fixtureId).toBeTruthy();
  expect(remainingIds).not.toContain(fixtureId);
  expect(remainingIds).toEqual(expect.arrayContaining(existingIds));
});
