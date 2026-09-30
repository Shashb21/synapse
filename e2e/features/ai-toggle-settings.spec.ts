import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { openRail } from "../support/rail";

/**
 * KAN-53: the Synapse admin turns AI on or off per section for every customer. Customers
 * have no AI switch; where a section is off they see its manual flow only.
 */
test.describe.configure({ mode: "serial", timeout: 180_000 });

async function control(request: APIRequestContext, data: Record<string, unknown>) {
  const res = await request.post("/api/control", { data });
  expect(res.ok(), `${JSON.stringify(data)} → ${res.status()} ${await res.text()}`).toBe(true);
}

async function openWorkspaceMenu(page: Page) {
  await expect(async () => {
    const menu = page.getByRole("menu");
    if (await menu.isVisible()) return;
    await page.getByTestId("workspace-tag").click({ timeout: 5_000 });
    await expect(menu).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 60_000 });
}

test.afterAll(async ({ request }) => {
  await control(request, { action: "set_ai_enabled", enabled: true, rationale: "e2e restore" });
  await control(request, { action: "set_ai_sections", enabled: true });
});

test("customers have no AI switch, and the old endpoint refuses changes", async ({ page, request }) => {
  await page.goto("/?place=gaps");
  await openRail(page);
  await openWorkspaceMenu(page);
  await expect(page.getByRole("menu").getByRole("switch")).toHaveCount(0);
  await expect(page.getByRole("menu")).not.toContainText("AI assistance");
  await page.keyboard.press("Escape");

  const list = (await (await request.get("/api/workspaces")).json()) as { workspaces: { id: string }[] };
  const res = await request.post(`/api/workspaces/${list.workspaces[0]!.id}/ai`, { data: { enabled: false } });
  expect(res.status()).toBe(403);
  expect(((await res.json()) as { error: string }).error).toMatch(/Synapse administrator/);
});

test("turning ingestion off removes Upload for customers; back on brings it back", async ({ page, request }) => {
  await control(request, { action: "set_ai_section", section: "ingestion", enabled: false });
  await page.goto("/?place=gaps");
  await openRail(page);
  const places = page.getByRole("navigation", { name: "Places" });
  await expect(places.getByRole("link", { name: /^upload/i })).toHaveCount(0);
  await page.goto("/?place=upload");
  await expect(page).toHaveURL(/place=gaps/);

  await control(request, { action: "set_ai_section", section: "ingestion", enabled: true });
  await page.goto("/?place=upload");
  await expect(page.getByRole("form", { name: "Add a source" })).toBeVisible();
});

test("turning ideation off hides only ideation's AI; other sections keep theirs", async ({ page, request }) => {
  await control(request, { action: "set_ai_section", section: "ideation", enabled: false });
  await page.goto("/ideation");
  await expect(page.getByRole("button", { name: /generate (more )?ideas/i })).toHaveCount(0);
  await expect(page.getByText("AI is off")).toHaveCount(0);
  // Prioritization is still on: its model placement is still offered.
  await page.goto("/?place=plan&setting=all");
  await expect(page.getByRole("heading", { name: /^prioritization matrix$/i })).toBeVisible();
  await expect(page.getByText(/land on the matrix as a first draft/i)).toBeVisible();

  await control(request, { action: "set_ai_section", section: "ideation", enabled: true });
  await page.goto("/ideation");
  await expect(page.getByRole("button", { name: /generate (more )?ideas/i }).first()).toBeVisible();
});

test("the master switch turns every section off", async ({ page, request }) => {
  await control(request, { action: "set_ai_enabled", enabled: false, rationale: "e2e" });
  await page.goto("/?place=plan&setting=all");
  await expect(page.getByText(/place each Open gap by hand/i)).toBeVisible();
  await page.goto("/ideation");
  await expect(page.getByRole("button", { name: /generate (more )?ideas/i })).toHaveCount(0);
  await control(request, { action: "set_ai_enabled", enabled: true, rationale: "e2e" });
});
