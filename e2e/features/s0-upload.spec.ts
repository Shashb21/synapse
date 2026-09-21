import { expect, test } from "@playwright/test";
import {
  DEMO_SOURCES,
  modulesState,
  resetWorkspace,
  runStage,
  runStageExpectingError,
} from "../support/synapse";

type UploadOutput = {
  files: { id: string; filename: string; checksum: string; bytes: number; mime: string }[];
  skipped: { filename: string; reason: string }[];
};

test.describe.configure({ mode: "serial" });

test.describe("S0 file upload", () => {
  test.beforeAll(async ({ request }) => {
    await resetWorkspace(request);
  });

  test("accepts files from the pipeline page and parses them on request", async ({ page }) => {
    await page.goto("/pipeline");
    await expect(page.getByRole("heading", { name: "S0 · Upload sources" })).toBeVisible();
    await expect(page.getByText("0 file(s) uploaded, 0 parsed")).toBeVisible();

    await page.getByRole("checkbox").first().check();
    await page.getByRole("button", { name: /^upload only$/i }).click();
    await expect(page.getByText(/1 file\(s\) uploaded/).first()).toBeVisible();
    await expect(page.getByText("1 file(s) uploaded, 0 parsed")).toBeVisible();
  });

  test("records checksum, size and mime, and leaves the domain untouched", async ({ request }) => {
    const upload = await runStage<UploadOutput>(request, "S0", { demo_ids: [DEMO_SOURCES[1]!] });
    expect(upload.output.files).toHaveLength(1);
    const file = upload.output.files[0]!;
    expect(file.checksum).toMatch(/^[0-9a-f]{32}$/);
    expect(file.bytes).toBeGreaterThan(200);
    expect(file.mime).toBe("text/plain");

    // S0 stores the file only; parsing is S1's job.
    const consolidated = await runStage<{ open: unknown[] }>(request, "S7");
    expect(consolidated.output.open).toHaveLength(0);
    expect(upload.evals.find((score) => score.name === "files_accepted")?.value).toBe(1);
  });

  test("refuses a byte-identical re-upload and names the file it matched", async ({ request }) => {
    const again = await runStage<UploadOutput>(request, "S0", { demo_ids: [DEMO_SOURCES[1]!] });
    expect(again.output.files).toHaveLength(0);
    expect(again.output.skipped[0]!.reason).toMatch(/identical to FILE-/);
  });

  test("rejects an upload with neither content nor a known demo id", async ({ request }) => {
    const empty = await runStage<UploadOutput>(request, "S0", {
      files: [
        {
          filename: "empty.txt",
          title: "Empty",
          source_type: "other_internal",
          stakeholder_function: "medical_affairs",
          text: "",
        },
      ],
    });
    expect(empty.output.files).toHaveLength(0);
    expect(empty.output.skipped[0]!.reason).toBe("empty file");

    const unknown = await runStageExpectingError(request, "S0", { demo_ids: ["not-a-demo"] });
    expect(unknown.status).toBe(400);
    expect(unknown.error).toMatch(/Unknown demo source/i);
  });

  test("is wired to the upload module and traced", async ({ request }) => {
    const state = await modulesState(request);
    const stage = state.wiring.find((row) => row.stage === "S0")!;
    expect(stage.active?.id).toBe("s0-upload.local-store");
    expect(state.runs.some((run) => run.stage === "S0" && run.status === "ok")).toBeTruthy();
  });
});
