import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";

/**
 * The admin account from `npm run create-admin` signs in with email and
 * password, opens the owner console and manages users at /admin/users.
 * Starts signed out; the command runs against the same DATABASE_URL as the
 * dev server.
 */
test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: "serial", timeout: 240_000 });

const id = Math.random().toString(36).slice(2, 8);
const ADMIN = { email: `admin.${id}@example.com`, password: `sapphire-orchard-${id}-41` };

function createAdmin(email: string, password: string, name?: string) {
  const args = ["run", "-s", "create-admin", "--", "--email", email, ...(name ? ["--name", name] : [])];
  return execFileSync("npm", args, { input: `${password}\n`, encoding: "utf8", env: process.env });
}

async function passwordSignIn(page: Page, email: string, password: string) {
  await page.goto("/login");
  const form = page.getByRole("form", { name: "Sign in with email" });
  const submit = form.getByRole("button", { name: "Sign in", exact: true });
  await expect(async () => {
    await form.getByLabel("Email").fill(email);
    await form.getByLabel("Password").fill(password);
    await expect(submit).toBeEnabled({ timeout: 1_000 });
  }).toPass({ timeout: 60_000 });
  await submit.click();
  await expect(page).toHaveURL(/\/workspaces/, { timeout: 60_000 });
}

test("create-admin, sign in, manage users; a created user signs in with the temporary password", async ({ page, browser }) => {
  const out = createAdmin(ADMIN.email, ADMIN.password, `Admin ${id}`);
  expect(out).toContain(`Created admin account ${ADMIN.email}`);
  expect(out).not.toContain(ADMIN.password);

  await passwordSignIn(page, ADMIN.email, ADMIN.password);
  await page.goto("/account");
  await expect(page.getByTestId("account-profile")).toContainText("Platform operator");
  await expect(page.getByTestId("account-admin-link")).toBeVisible();

  await page.goto("/admin/users");
  await expect(page.getByRole("heading", { name: "Users", level: 1 })).toBeVisible();
  const own = page.getByTestId("user-row").filter({ hasText: ADMIN.email });
  await expect(own).toContainText("(you)");
  await expect(own.getByRole("combobox")).toBeDisabled();
  await expect(own.getByRole("button", { name: "Disable" })).toHaveCount(0);

  const userEmail = `made.${id}@example.com`;
  const create = page.getByRole("form", { name: "Create a user" });
  const submit = create.getByRole("button", { name: "Create user" });
  await expect(async () => {
    await create.getByLabel("Email").fill(userEmail);
    await create.getByLabel("Name").fill(`Made ${id}`);
    await expect(submit).toBeEnabled({ timeout: 1_000 });
  }).toPass({ timeout: 60_000 });
  await submit.click();
  const secret = page.getByTestId("temporary-password");
  await expect(secret).toContainText(userEmail);
  const temp = (await secret.locator("code").textContent())?.trim() ?? "";
  expect(temp.length).toBeGreaterThanOrEqual(12);
  const row = page.getByTestId("user-row").filter({ hasText: userEmail });
  await expect(row).toContainText("Active");

  // The new user signs in (own browser context) and is not an owner.
  const other = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const userPage = await other.newPage();
  await passwordSignIn(userPage, userEmail, temp);
  const denied = await userPage.request.get("/api/admin/users");
  expect(denied.status()).toBe(403);
  await other.close();

  // Disable, then the user can't sign in.
  await row.getByRole("button", { name: "Disable" }).click();
  await expect(row).toContainText("Disabled");
  const blocked = await page.request.post("/api/auth/password/login", {
    data: { email: userEmail, password: temp },
    headers: { cookie: "" },
  });
  expect(blocked.status()).toBe(403);

  // Running create-admin again resets the admin's password.
  const reset = `${ADMIN.password}-new`;
  expect(createAdmin(ADMIN.email, reset)).toContain("password has been reset");
  // ...and signs the admin out everywhere.
  const stale = await page.request.post("/api/account/password", { data: { current: ADMIN.password, next: reset } });
  expect(stale.status()).toBe(401);
  await passwordSignIn(page, ADMIN.email, reset);
  expect((await page.request.get("/api/admin/users")).status()).toBe(200);
});
