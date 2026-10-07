import { execFileSync } from "node:child_process";
import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * KAN-28: the owner sells a customer seats and assigns them at
 * /admin/customers. Signs in as a fresh `npm run create-admin` account (the
 * password goes on stdin and is never printed), creates a customer, assigns
 * seats one at a time and as a pasted list, hits the limit, and unassigns.
 */
test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: "serial", timeout: 240_000 });

const id = Math.random().toString(36).slice(2, 8);
const ADMIN = { email: `cust.admin.${id}@example.com`, password: `amber-quarry-${id}-73` };
const DOMAIN = `acme-${id}.example.com`;
const at = (who: string) => `${who}@${DOMAIN}`;

function createAdmin(email: string, password: string, name: string) {
  return execFileSync("npm", ["run", "-s", "create-admin", "--", "--email", email, "--name", name], {
    input: `${password}\n`,
    encoding: "utf8",
    env: process.env,
  });
}

/** Fills until the page has hydrated and the button enables (a first compile can hydrate late). */
async function fillUntilEnabled(fill: () => Promise<void>, button: Locator) {
  await expect(async () => {
    await fill();
    await expect(button).toBeEnabled({ timeout: 1_000 });
  }).toPass({ timeout: 60_000 });
}

async function passwordSignIn(page: Page, email: string, password: string) {
  await page.goto("/login");
  const form = page.getByRole("form", { name: "Sign in with email" });
  const submit = form.getByRole("button", { name: "Sign in", exact: true });
  await fillUntilEnabled(async () => {
    await form.getByLabel("Email").fill(email);
    await form.getByLabel("Password").fill(password);
  }, submit);
  await submit.click();
  // KAN-58: staff land on the admin console.
  await expect(page).toHaveURL(/\/admin(\?|$)/, { timeout: 60_000 });
}

test("create a customer, assign seats (one and pasted), hit the limit, unassign", async ({ page, browser }) => {
  const out = createAdmin(ADMIN.email, ADMIN.password, `Customers Admin ${id}`);
  expect(out).toContain(`Created admin account ${ADMIN.email}`);
  expect(out).not.toContain(ADMIN.password);
  await passwordSignIn(page, ADMIN.email, ADMIN.password);

  // The console nav leads to Customers.
  await page.goto("/admin");
  await page.getByRole("link", { name: "Customers" }).first().click();
  await expect(page).toHaveURL(/\/admin\/customers$/);
  await expect(page.getByRole("heading", { name: "Customers", level: 1 })).toBeVisible();

  // Create: 2 seats on one domain.
  const name = `Acme ${id}`;
  const create = page.getByRole("form", { name: "Create a customer" });
  const createButton = create.getByRole("button", { name: "Create customer" });
  await fillUntilEnabled(async () => {
    await create.getByLabel("Customer name").fill(name);
    await create.getByLabel(/Email domains/).fill(DOMAIN);
    await create.getByLabel("Seats").fill("2");
  }, createButton);
  await createButton.click();

  const row = page.getByTestId("customer-row").filter({ hasText: name });
  await expect(row).toContainText(DOMAIN);
  await expect(row.getByTestId("customer-seats")).toHaveText("0 / 2");
  const panel = page.getByTestId("customer-panel");
  await expect(panel.getByRole("heading", { name })).toBeVisible();
  await expect(panel.getByTestId("customer-seat-summary")).toHaveText("0 of 2 seats assigned · 2 remaining");

  const assignForm = panel.getByRole("form", { name: "Assign seats" });
  const emails = assignForm.getByRole("textbox");
  const assign = assignForm.getByRole("button", { name: "Assign seats" });

  // One email.
  await fillUntilEnabled(() => emails.fill(at("ana")), assign);
  await assign.click();
  await expect(panel.getByTestId("customer-notice")).toHaveText("Assigned 1 seat.");
  await expect(panel.getByTestId("seat-row")).toHaveCount(1);
  await expect(row.getByTestId("customer-seats")).toHaveText("1 / 2");

  // A pasted list that doesn't fit: refused, with how many remain, and nothing assigned.
  await emails.fill(`${at("bo")}, ${at("cy")}\n${at("di")}`);
  await assign.click();
  await expect(panel.getByTestId("seat-error")).toContainText("1 seat remaining");
  await expect(panel.getByTestId("seat-error")).toContainText("Nothing was assigned");
  await expect(panel.getByTestId("seat-row")).toHaveCount(1);

  // Off-domain is refused.
  await emails.fill(`stray@elsewhere-${id}.example.com`);
  await assign.click();
  await expect(panel.getByTestId("seat-error")).toContainText("email domains");

  // A paste that fits (one already has a seat).
  await emails.fill(`${at("ana")}\n${at("bo")}`);
  await assign.click();
  await expect(panel.getByTestId("customer-notice")).toHaveText("Assigned 1 seat. 1 already had one.");
  await expect(panel.getByTestId("seat-row")).toHaveCount(2);
  await expect(row.getByTestId("customer-seats")).toHaveText("2 / 2");
  await expect(panel.getByTestId("customer-seat-summary")).toContainText("0 remaining");

  // The limit: no seats left.
  await emails.fill(at("cy"));
  await assign.click();
  await expect(panel.getByTestId("seat-error")).toContainText("0 seats remaining");

  // Seats can't go below those assigned.
  const edit = panel.getByRole("form", { name: "Edit customer" });
  await edit.getByLabel("Seats sold").fill("1");
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(panel.getByTestId("edit-customer-error")).toContainText("can't go below 2");

  // Unassign one: the seat frees up.
  await panel.getByRole("button", { name: `Unassign ${at("ana")}` }).click();
  await expect(panel.getByTestId("customer-notice")).toContainText(`Unassigned ${at("ana")}`);
  await expect(panel.getByTestId("seat-row")).toHaveCount(1);
  await expect(panel.getByTestId("seat-row")).toContainText(at("bo"));
  await expect(row.getByTestId("customer-seats")).toHaveText("1 / 2");

  // Now lowering to 1 works; the list survives a reload.
  await edit.getByLabel("Seats sold").fill("1");
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(panel.getByTestId("customer-notice")).toHaveText("Saved.");
  await page.reload();
  const reloaded = page.getByTestId("customer-row").filter({ hasText: name });
  await expect(reloaded.getByTestId("customer-seats")).toHaveText("1 / 1");
  await reloaded.getByRole("button", { name: `Manage ${name}` }).click();
  await expect(page.getByTestId("customer-panel").getByTestId("seat-row")).toHaveCount(1);

  // Non-owners are refused by the API.
  const origin = new URL(page.url()).origin;
  const anon = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  await anon.addCookies([{ name: "synapse_test_as", value: "customer", url: origin }]);
  expect((await anon.request.get(`${origin}/api/admin/customers`)).status()).toBe(403);
  expect((await anon.request.post(`${origin}/api/admin/customers`, { data: { name: "Sneaky", seats: 5 } })).status()).toBe(403);
  await anon.close();
});
