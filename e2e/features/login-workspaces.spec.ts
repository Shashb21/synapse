import { expect, test, type Page } from "@playwright/test";

/**
 * Login → workspaces → a workspace tag on every page. These specs start signed
 * out (no saved storage state) and sign in as a fresh demo user each time.
 */
test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: "serial", timeout: 180_000 });

const unique = () => Math.random().toString(36).slice(2, 8);

/**
 * Fills controlled inputs, refilling until the page has hydrated and the submit
 * button enables (a first compile can hydrate after the fill). Each field is
 * cleared first so React sees a change even when the text is the same.
 */
async function refill(field: ReturnType<Page["getByLabel"]>, value: string) {
  await field.fill("");
  await field.fill(value);
}

async function fillUntilEnabled(fill: () => Promise<void>, button: ReturnType<Page["getByRole"]>) {
  await expect(async () => {
    await fill();
    await expect(button).toBeEnabled({ timeout: 1_000 });
  }).toPass({ timeout: 60_000 });
}

/** Opens the workspace tag's menu, retrying until the page has hydrated. */
async function openWorkspaceMenu(page: Page) {
  await expect(async () => {
    const menu = page.getByRole("menu");
    if (await menu.isVisible()) return;
    await page.getByTestId("workspace-tag").click({ timeout: 5_000 });
    await expect(menu).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 60_000 });
}

/** Clicks until the URL changes (a click before hydration does nothing). */
async function clickUntilUrl(page: Page, target: ReturnType<Page["getByRole"]>, url: RegExp) {
  await expect(async () => {
    if (url.test(page.url())) return;
    await target.click({ timeout: 5_000 });
    await expect(page).toHaveURL(url, { timeout: 15_000 });
  }).toPass({ timeout: 90_000 });
}

async function demoSignInThroughLoginPage(page: Page, name: string, email?: string) {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Synapse IEGP" })).toBeVisible();
  const form = page.getByRole("form", { name: "Demo sign-in" });
  const submit = form.getByRole("button", { name: /continue as a demo user \(development only\)/i });
  await fillUntilEnabled(
    async () => {
      await refill(form.getByLabel("Your name"), name);
      if (email) await refill(form.getByLabel(/Email/), email);
    },
    submit,
  );
  await submit.click();
  await expect(page).toHaveURL(/\/workspaces/, { timeout: 60_000 });
}

async function createWorkspaceThroughUi(page: Page, name: string) {
  const form = page.getByRole("form", { name: "Create a workspace" });
  const submit = form.getByRole("button", { name: "Create workspace" });
  await fillUntilEnabled(() => refill(form.getByLabel("Workspace name"), name), submit);
  await submit.click();
  await expect(page).toHaveURL(/\/setup\?new=1/, { timeout: 90_000 });
}

test("signed out, every customer page and API sends you to sign in", async ({ page, request }) => {
  await page.goto("/timeline");
  await expect(page).toHaveURL(/\/login\?next=%2Ftimeline/);
  await expect(page.getByRole("button", { name: /continue as a demo user/i })).toBeVisible();

  const api = await request.post("/api/iegp", { data: { action: "reset" } });
  expect(api.status()).toBe(401);
});

test("first sign-in asks for a workspace; the tag shows it; switching changes the data", async ({ page }) => {
  const id = unique();
  const email = `ws.${id}@example.com`;
  await demoSignInThroughLoginPage(page, `Workspace Tester ${id}`, email);

  // A brand-new person has no workspaces, so they are asked to create one.
  await expect(page.getByRole("heading", { name: "Create your first workspace" })).toBeVisible();
  const alpha = `Alpha ${id}`;
  await createWorkspaceThroughUi(page, alpha);

  // The workspace tag names the open workspace.
  await page.goto("/gaps");
  await expect(page.getByTestId("workspace-tag-name")).toHaveText(alpha);

  // A gap created in Alpha…
  // The Gaps list shows each gap by name.
  const statement = `Only in ${alpha}`;
  const created = await page.request.post("/api/iegp", {
    data: {
      action: "create_gap",
      name: statement,
      statement: `${statement}: no head-to-head data versus standard of care.`,
      actor_name: "Workspace Tester",
      actor_function: "medical_affairs",
    },
  });
  expect(created.ok(), await created.text()).toBe(true);
  await page.reload();
  await expect(page.getByText(statement)).toBeVisible();

  // …is absent from Beta. "New workspace" from the tag, then create Beta.
  await openWorkspaceMenu(page);
  await page.getByRole("menuitem", { name: "New workspace" }).click();
  await expect(page).toHaveURL(/\/workspaces\?new=1/);
  const beta = `Beta ${id}`;
  await createWorkspaceThroughUi(page, beta);
  await page.goto("/gaps");
  await expect(page.getByTestId("workspace-tag-name")).toHaveText(beta);
  await expect(page.getByText(statement)).toHaveCount(0);

  // Switch back to Alpha from the tag: the gap is there again.
  await openWorkspaceMenu(page);
  await page.getByRole("menuitem", { name: new RegExp(alpha) }).click();
  await expect(page).toHaveURL(/\/(\?.*)?$/, { timeout: 60_000 });
  await expect(page.getByTestId("workspace-tag-name")).toHaveText(alpha);
  await page.goto("/gaps");
  await expect(page.getByText(statement)).toBeVisible();

  // Both workspaces are listed on the picker, with the current one marked.
  await page.goto("/workspaces");
  const rows = page.getByTestId("workspace-row");
  await expect(rows.filter({ hasText: alpha })).toContainText("Current");
  await expect(rows.filter({ hasText: beta })).toContainText("Owner");
});

test("an invite shows in members, and the invitee sees the workspace when they sign in", async ({ page }) => {
  const id = unique();
  await demoSignInThroughLoginPage(page, `Inviter ${id}`, `inviter.${id}@example.com`);
  const name = `Shared ${id}`;
  await createWorkspaceThroughUi(page, name);

  await page.goto("/workspaces");
  await page.getByRole("link", { name: `Settings for ${name}` }).click();
  const invitee = `invitee.${id}@example.com`;
  const invite = page.getByRole("button", { name: "Invite", exact: true });
  await fillUntilEnabled(() => refill(page.getByLabel("Invite by email"), invitee), invite);
  await invite.click();
  await expect(page.getByTestId("member-row").filter({ hasText: invitee })).toContainText("Member");

  // Sign out from the workspace tag, then sign in as the invitee.
  await page.goto("/gaps");
  await openWorkspaceMenu(page);
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);

  await demoSignInThroughLoginPage(page, `Invitee ${id}`, invitee);
  const row = page.getByTestId("workspace-row").filter({ hasText: name });
  await expect(row).toContainText("Member");
  await clickUntilUrl(page, row.getByRole("button", { name: `Open ${name}` }), /\/(\?.*)?$/);
  await expect(page.getByTestId("workspace-tag-name")).toHaveText(name);
});

test("the customer app shows no owner or lab tools", async ({ page }) => {
  const id = unique();
  await demoSignInThroughLoginPage(page, `Nav Tester ${id}`);
  await createWorkspaceThroughUi(page, `Nav ${id}`);
  await page.goto("/gaps");
  for (const href of ["/pipeline", "/runs", "/control", "/control-panel", "/evals", "/sdlc", "/catalog", "/docs"]) {
    await expect(page.locator(`aside a[href="${href}"]`)).toHaveCount(0);
  }
  await expect(page.locator('aside a[href^="/accuracy"]')).toHaveCount(0);
  const toggle = page.getByRole("group", { name: /prep or room mode/i }).first();
  await expect(toggle.getByRole("link", { name: "Room" })).toHaveAttribute("href", "/room");
});

test("email and password: sign up, your account, sign out, sign back in; a wrong password is generic", async ({ page }) => {
  const id = unique();
  const email = `signup.${id}@example.com`;
  const password = `lantern-harbour-${id}-9`;

  // The login page leads with the email form and links to sign-up.
  await page.goto("/login");
  const signIn = page.getByRole("form", { name: "Sign in with email" });
  await expect(signIn.getByLabel("Email")).toBeVisible();
  await clickUntilUrl(page, page.getByRole("link", { name: "Create an account" }), /\/signup/);

  const form = page.getByRole("form", { name: "Create an account" });
  const create = form.getByRole("button", { name: "Create account" });
  await fillUntilEnabled(async () => {
    await refill(form.getByLabel("Your name"), `Signup ${id}`);
    await refill(form.getByLabel("Work email"), email);
    await refill(form.getByLabel("Password", { exact: true }), password);
    await refill(form.getByLabel("Confirm password"), password);
  }, create);
  await create.click();
  await expect(page).toHaveURL(/\/workspaces/, { timeout: 60_000 });

  // A self sign-up is a contributor whose email is not verified yet.
  await page.goto("/account");
  const profile = page.getByTestId("account-profile");
  await expect(profile).toContainText(email);
  await expect(profile).toContainText("Contributing function");
  await expect(profile).toContainText("Email and password");
  await expect(profile).toContainText("Not yet");
  await expect(page.getByTestId("account-admin-link")).toHaveCount(0);

  await clickUntilUrl(page, page.getByRole("button", { name: /sign out/i }), /\/login/);

  const submit = signIn.getByRole("button", { name: "Sign in", exact: true });
  await fillUntilEnabled(async () => {
    await refill(signIn.getByLabel("Email"), email);
    await refill(signIn.getByLabel("Password"), "definitely-not-it");
  }, submit);
  await submit.click();
  await expect(page.getByTestId("login-error")).toHaveText("Email or password is incorrect.");

  await refill(signIn.getByLabel("Password"), password);
  await submit.click();
  await expect(page).toHaveURL(/\/workspaces/, { timeout: 60_000 });
});
