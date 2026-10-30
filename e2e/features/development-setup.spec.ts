/** Browser proof for private Development drafts, using the isolated test server. */
import { expect, test } from "@playwright/test";

test("owner creates, uploads, saves and reopens a private experiment", async ({
  page,
  request,
}) => {
  // Arrange: authenticated owner; the server uses a disposable database and stub parser.
  const name = `Development ${Date.now()}`;
  await page.goto("/admin/development");
  await expect(
    page.getByRole("heading", { name: "Development", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "Admin", exact: true })
      .getByRole("link", { name: "Development", exact: true }),
  ).toHaveAttribute("href", "/admin/development");
  // Act: create a private-only draft with the keyboard, then keep an unsaved name during upload.
  await page.getByLabel("New experiment name").fill(name);
  await page
    .getByRole("button", { name: "Create experiment", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Experiment name", { exact: true })).toHaveValue(
    name,
  );
  await page
    .getByLabel("Experiment name", { exact: true })
    .fill(`${name} saved`);
  await page.getByLabel("Private source file").setInputFiles({
    name: "source.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(
      "Need comparative survival evidence. Develop a comparative study.",
    ),
  });
  await page
    .getByRole("button", { name: "Upload source", exact: true })
    .click();
  await expect(page.getByText("source.txt", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Experiment name", { exact: true })).toHaveValue(
    `${name} saved`,
  );
  const experiments = await (
    await request.get("/api/admin/development")
  ).json();
  const draft = experiments.experiments.find(
    (item: { name: string }) => item.name === name,
  );
  const detail = await (
    await request.get(`/api/admin/development/${draft.id}`)
  ).json();
  const source = detail.experiment.documents.find(
    (item: { role: string }) => item.role === "source",
  );
  await page.getByLabel(`Associate source.txt`).check();
  await page.getByLabel("Structured reference JSON").setInputFiles({
    name: "reference.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        version: 1,
        section: "gap_extraction",
        source_document_ids: [source.id],
        expected_answers: [
          {
            id: "g1",
            statement: "Need comparative survival evidence",
            quote: "Need comparative survival evidence",
            source_document_id: source.id,
          },
        ],
      }),
    ),
  });
  await page
    .getByRole("button", { name: "Upload structured reference", exact: true })
    .click();
  await expect(page.getByText("reference.json", { exact: true })).toBeVisible();
  await page.getByLabel("Reference PDF", { exact: true }).setInputFiles({
    name: "expert.pdf",
    mimeType: "application/pdf",
    buffer: referencePdf(),
  });
  await page
    .getByRole("button", { name: "Upload reference PDF", exact: true })
    .click();
  await expect(page.getByText("expert.pdf", { exact: true })).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Saved documents" })
      .getByText(/Evaluator-only.*provisional/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Save name", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Saved");
  await page.reload();
  await page
    .getByRole("button", { name: `Open ${name} saved`, exact: true })
    .click();
  // Assert: source and evaluator-only reference survive a fresh read.
  await expect(page.getByLabel("Experiment name", { exact: true })).toHaveValue(
    `${name} saved`,
  );
  await expect(page.getByText("source.txt", { exact: true })).toBeVisible();
  await expect(page.getByText("reference.json", { exact: true })).toBeVisible();
  await expect(page.getByText(/Evaluator-only/).first()).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: ".superpowers/sdd/2026-10-30-kan-201/development-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: ".superpowers/sdd/2026-10-30-kan-201/development-mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("invalid upload and stale revision give recovery without losing edits", async ({
  page,
  request,
}) => {
  await page.goto("/admin/development");
  const name = `Recovery ${Date.now()}`;
  await page.getByLabel("New experiment name").fill(name);
  await page
    .getByRole("button", { name: "Create experiment", exact: true })
    .click();
  await expect(page.getByLabel("Experiment name", { exact: true })).toHaveValue(
    name,
  );
  await page.getByLabel("Private source file").setInputFiles({
    name: "bad.exe",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("invalid"),
  });
  await page
    .getByRole("button", { name: "Upload source", exact: true })
    .click();
  await expect(page.getByRole("main").getByRole("alert")).toBeVisible();
  const { experiments } = await (
    await request.get("/api/admin/development")
  ).json();
  const draft = experiments.find(
    (item: { name: string }) => item.name === name,
  );
  expect(
    (
      await request.patch(`/api/admin/development/${draft.id}`, {
        data: { name, revision: draft.revision },
      })
    ).ok(),
  ).toBe(true);
  await page
    .getByLabel("Experiment name", { exact: true })
    .fill(`${name} edited`);
  await page.getByRole("button", { name: "Save name", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    /reload/i,
  );
  await expect(page.getByLabel("Experiment name", { exact: true })).toHaveValue(
    `${name} edited`,
  );
  await page
    .getByRole("button", { name: "Reload saved draft", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("Reloaded");
  await expect(page.getByLabel("Experiment name", { exact: true })).toHaveValue(
    `${name} edited`,
  );
  await page.getByRole("button", { name: "Save name", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Saved");
});

/** Build a one-page text PDF without a paid provider or external fixture dependency. */
function referencePdf(): Buffer {
  const content =
    "BT /F1 12 Tf 40 700 Td (Need comparative survival evidence.) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n `)
    .join(
      "\n",
    )}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}

test("read failure provides a labelled recovery action", async ({ page }) => {
  await page.route("**/api/admin/development", (route) =>
    route.fulfill({
      status: 503,
      json: { error: "Unavailable", code: "unavailable" },
    }),
  );
  await page.goto("/admin/development");
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "Unable to load experiments",
  );
  await page.unroute("**/api/admin/development");
  await page.getByRole("button", { name: "Retry page load" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
  await expect(page.getByLabel("New experiment name")).toBeEnabled();
});

test("slow uploads disable competing writes and preserve the edited name", async ({
  page,
}) => {
  const name = `Serialized ${Date.now()}`;
  await page.goto("/admin/development");
  await page.getByLabel("New experiment name").fill(name);
  await page
    .getByRole("button", { name: "Create experiment", exact: true })
    .click();
  await expect(page.getByLabel("Experiment name", { exact: true })).toHaveValue(
    name,
  );
  await page
    .getByLabel("Experiment name", { exact: true })
    .fill(`${name} edited`);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requests = 0;
  await page.route("**/source-upload", async (route) => {
    requests += 1;
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response });
  });
  await page.getByLabel("Private source file").setInputFiles({
    name: "source.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Need evidence for comparative survival."),
  });
  await page
    .getByRole("button", { name: "Upload source", exact: true })
    .click();
  try {
    await expect(page.getByRole("status")).toContainText(
      "Uploading and parsing",
    );
    await expect(
      page.getByRole("button", { name: "Save name", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Reload saved draft", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Upload source", exact: true }),
    ).toBeDisabled();
  } finally {
    release();
  }
  await expect(page.getByText("source.txt", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Experiment name", { exact: true })).toHaveValue(
    `${name} edited`,
  );
  expect(requests).toBe(1);
});

test("creating another draft clears every pending file selection", async ({
  page,
}) => {
  const name = `File reset ${Date.now()}`;
  let uploads = 0;
  page.on("request", (request) => {
    if (/\/(source-upload|reference-upload)$/.test(request.url())) uploads += 1;
  });
  await page.goto("/admin/development");
  await page.getByLabel("New experiment name").fill(name);
  await page
    .getByRole("button", { name: "Create experiment", exact: true })
    .click();
  await expect(page.getByLabel("Experiment name", { exact: true })).toHaveValue(
    name,
  );
  await page.getByLabel("Private source file").setInputFiles({
    name: "old.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Old source"),
  });
  await page.getByLabel("Reference PDF", { exact: true }).setInputFiles({
    name: "old.pdf",
    mimeType: "application/pdf",
    buffer: referencePdf(),
  });
  await page.getByLabel("Structured reference JSON").setInputFiles({
    name: "old.json",
    mimeType: "application/json",
    buffer: Buffer.from("{}"),
  });
  await page.getByLabel("New experiment name").fill(`${name} second`);
  await page
    .getByRole("button", { name: "Create experiment", exact: true })
    .click();
  await expect(page.getByLabel("Experiment name", { exact: true })).toHaveValue(
    `${name} second`,
  );
  for (const label of [
    "Private source file",
    "Reference PDF",
    "Structured reference JSON",
  ]) {
    await expect(page.getByLabel(label, { exact: true })).toHaveValue("");
  }
  await expect(
    page.getByRole("button", { name: "Upload source", exact: true }),
  ).toBeDisabled();
  expect(uploads).toBe(0);
  // A fresh source enables only its own upload; references must still need fresh files.
  await page.getByLabel("Private source file").setInputFiles({
    name: "fresh.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Fresh evidence"),
  });
  await page
    .getByRole("button", { name: "Upload source", exact: true })
    .click();
  await page.getByLabel("Associate fresh.txt", { exact: true }).check();
  await expect(
    page.getByRole("button", { name: "Upload reference PDF", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", {
      name: "Upload structured reference",
      exact: true,
    }),
  ).toBeDisabled();
  expect(uploads).toBe(1);
});

test("created draft remains visible when source choices fail and retry only reads", async ({
  page,
  request,
}) => {
  const name = `Partial create ${Date.now()}`;
  let creates = 0;
  let reads = 0;
  page.on("request", (request) => {
    if (
      request.url().endsWith("/api/admin/development") &&
      request.method() === "POST"
    )
      creates += 1;
  });
  await page.route("**/api/admin/development/*/sources", async (route) => {
    reads += 1;
    if (reads === 1)
      await route.fulfill({
        status: 503,
        json: { error: "Source choices unavailable" },
      });
    else await route.continue();
  });
  await page.goto("/admin/development");
  await page.getByLabel("New experiment name").fill(name);
  await page
    .getByRole("button", { name: "Create experiment", exact: true })
    .click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "Source choices unavailable",
  );
  await expect(page.getByLabel("Experiment name", { exact: true })).toHaveValue(
    name,
  );
  await expect(page.getByLabel("New experiment name")).toHaveValue("");
  await page
    .getByRole("button", { name: "Retry loading sources", exact: true })
    .click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
  await expect(page.getByLabel("Experiment name", { exact: true })).toHaveValue(
    name,
  );
  expect(reads).toBe(2);
  expect(creates).toBe(1);
  const { experiments } = await (
    await request.get("/api/admin/development")
  ).json();
  expect(
    experiments.filter((item: { name: string }) => item.name === name),
  ).toHaveLength(1);
});

test("reopened draft shows saved documents when source choices fail", async ({
  page,
  request,
}) => {
  // Arrange: persist a source snapshot before a fresh page load.
  const name = `Partial reopen ${Date.now()}`;
  const created = await request.post("/api/admin/development", {
    data: { name, source_workspace_id: null },
  });
  expect(created.ok()).toBe(true);
  const { experiment } = await created.json();
  const uploaded = await request.post(
    `/api/admin/development/${experiment.id}/source-upload`,
    {
      data: {
        revision: experiment.revision,
        filename: "saved-source.txt",
        content_base64: Buffer.from("Saved comparative evidence").toString(
          "base64",
        ),
      },
    },
  );
  expect(uploaded.ok()).toBe(true);
  const saved = (await uploaded.json()).experiment;
  let sourceReads = 0;
  let detailReads = 0;
  let mutations = 0;
  page.on("request", (outgoing) => {
    if (!outgoing.url().includes("/api/admin/development")) return;
    if (outgoing.method() !== "GET") mutations += 1;
    if (outgoing.url().endsWith(`/api/admin/development/${experiment.id}`))
      detailReads += 1;
  });
  await page.route(
    `**/api/admin/development/${experiment.id}/sources`,
    async (route) => {
      sourceReads += 1;
      if (sourceReads === 1)
        await route.fulfill({
          status: 503,
          json: { error: "Source choices unavailable" },
        });
      else await route.continue();
    },
  );
  // Act: detail succeeds, optional source discovery fails, then retry discovery only.
  await page.goto("/admin/development");
  await page.getByRole("button", { name: `Open ${name}`, exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "Source choices unavailable",
  );
  await expect(page.getByLabel("Experiment name", { exact: true })).toHaveValue(
    name,
  );
  await expect(
    page
      .getByRole("region", { name: "Saved documents" })
      .getByText("saved-source.txt", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Retry loading sources", exact: true })
    .click();
  // Assert: immutable saved data remains available without another detail read or mutation.
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
  await expect(
    page.getByText("saved-source.txt", { exact: true }),
  ).toBeVisible();
  expect(sourceReads).toBe(2);
  expect(detailReads).toBe(1);
  expect(mutations).toBe(0);
  const reopened = await (
    await request.get(`/api/admin/development/${experiment.id}`)
  ).json();
  expect(reopened.experiment.revision).toBe(saved.revision);
  expect(reopened.experiment.documents).toEqual(saved.documents);
});
