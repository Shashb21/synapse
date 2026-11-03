/** Tests the CI runner's selected coverage, process ordering, and failure reporting. */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runShard, selectSpecs } from "../scripts/ci-playwright-specs.mjs";

const listing = (files = ["features/first.spec.ts", "features/second.spec.ts"]) => ({
  errors: [],
  suites: [{ specs: [{ file: "global.setup.ts", id: "setup", tests: [{ projectName: "setup" }] }], suites: files.map((file, i) => ({ specs: [{ file, id: `case-${i}`, tests: [{ projectName: "chromium" }] }] })) }],
});
const roots: string[] = [];
async function tempRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "ui3-runner-test-"));
  roots.push(root);
  return root;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("selectSpecs", () => {
  it("preserves selected file order and every chromium ID while excluding setup", () => {
    expect(selectSpecs(listing())).toEqual([
      { file: "features/first.spec.ts", ids: ["case-0"] },
      { file: "features/second.spec.ts", ids: ["case-1"] },
    ]);
  });
  it("retains multiple nested scenarios from a file without losing or repeating IDs", () => {
    const selection = listing();
    selection.suites[0].suites.push({ specs: [{ file: "features/first.spec.ts", id: "case-nested", tests: [{ projectName: "chromium" }] }] });
    const specs = selectSpecs(selection);
    expect(specs.map(spec => spec.file)).toEqual(["features/first.spec.ts", "features/second.spec.ts"]);
    expect(specs.flatMap(spec => spec.ids).sort()).toEqual(["case-0", "case-1", "case-nested"]);
  });
  it.each([
    {}, { errors: [], suites: [] }, { ...listing(), errors: [{ message: "load failed" }] },
    listing(["../escape.spec.ts"]), listing(["features/bad>name.spec.ts"]), listing([" features/trim.spec.ts"]), listing(["#ignored.spec.ts"]),
    { errors: [], suites: [{ specs: [{ file: "a.spec.ts", id: "a", tests: [{ projectName: "unknown" }] }] }] },
    { errors: [], suites: [{ specs: [{ file: "a.spec.ts", id: "a", tests: [{ projectName: "chromium" }] }, { file: "b.spec.ts", id: "a", tests: [{ projectName: "chromium" }] }] }] },
  ])("rejects empty, malformed, unsafe, or duplicated selection %#", value => {
    expect(() => selectSpecs(value)).toThrow();
  });
});

describe("runShard", () => {
  it("resolves the installed CLI and fails discovery in a directory with no tests", async () => {
    const cwd = await tempRoot();
    await expect(runShard({ cwd, shard: "1/1" })).rejects.toThrow("Empty Chromium selection");
  });
  it("awaits each file, preserves exact selection, and writes unique artifacts", async () => {
    const cwd = await tempRoot();
    const calls: string[][] = [];
    let active = 0;
    const result = await runShard({ cwd, shard: "5/12", execute: async ({ args, env }: { args: string[]; env: NodeJS.ProcessEnv }) => {
      calls.push(args);
      expect(env.E2E_REUSE).toBe("0");
      if (args.includes("--list")) return { code: 0, stdout: JSON.stringify(listing()) };
      expect(active++).toBe(0);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
      const selected = args.find(arg => arg.startsWith("--test-list="))!.slice(12);
      expect(await readFile(selected, "utf8")).toBe(`${listing().suites[0].suites[calls.length - 2].specs[0].file}\n`);
      return { code: 0, stdout: "" };
    } });
    expect(result).toBe(0);
    expect(calls[0]).toContain("--shard=5/12");
    expect(calls.slice(1).every(args => !args.some(arg => arg.startsWith("--shard=")))).toBe(true);
    expect(new Set(calls.slice(1).map(args => args.find(arg => arg.startsWith("--output=")))).size).toBe(2);
    const manifest = JSON.parse(await readFile(path.join(cwd, "test-results/per-spec/shard-5-of-12/selection.json"), "utf8"));
    expect(manifest.specs.flatMap((spec: { ids: string[] }) => spec.ids)).toEqual(["case-0", "case-1"]);
  });
  it("continues after scenario failure and returns a failing job status", async () => {
    const cwd = await tempRoot();
    let runs = 0;
    expect(await runShard({ cwd, shard: "1/12", execute: async ({ args }: { args: string[] }) => args.includes("--list")
      ? { code: 0, stdout: JSON.stringify(listing()) }
      : { code: ++runs === 1 ? 1 : 0, stdout: "" } })).toBe(1);
    expect(runs).toBe(2);
    const outcomes = JSON.parse(await readFile(path.join(cwd, "test-results/per-spec/shard-1-of-12/outcomes.json"), "utf8"));
    expect(outcomes.map((outcome: { code: number }) => outcome.code)).toEqual([1, 0]);
  });
  it("stops safely on launch failure and records it", async () => {
    const cwd = await tempRoot();
    let runs = 0;
    await expect(runShard({ cwd, shard: "1/12", execute: async ({ args }: { args: string[] }) => {
      if (args.includes("--list")) return { code: 0, stdout: JSON.stringify(listing()) };
      runs++;
      throw new Error("spawn ENOENT");
    } })).rejects.toThrow("spawn ENOENT");
    expect(runs).toBe(1);
    expect(await readFile(path.join(cwd, "test-results/per-spec/shard-1-of-12/outcomes.json"), "utf8")).toContain("spawn ENOENT");
  });
  it("awaits interrupted child cleanup and schedules no further files", async () => {
    const cwd = await tempRoot();
    const controller = new AbortController();
    let cleanedUp = false;
    let runs = 0;
    expect(await runShard({ cwd, shard: "1/12", signal: controller.signal, execute: async ({ args }: { args: string[] }) => {
      if (args.includes("--list")) return { code: 0, stdout: JSON.stringify(listing()) };
      runs++;
      controller.abort();
      await new Promise(resolve => setTimeout(resolve, 5));
      cleanedUp = true;
      return { code: 143, stdout: "" };
    } })).toBe(1);
    expect(cleanedUp).toBe(true);
    expect(runs).toBe(1);
  });
  it.each(["", "0/12", "13/12", "1/0", "1/12x"])("rejects invalid shard %s before launching", async shard => {
    const cwd = await tempRoot();
    await expect(runShard({ cwd, shard, execute: async () => { throw new Error("must not launch"); } })).rejects.toThrow("Invalid shard");
  });
  it.each([{ code: 1, stdout: "{}" }, { code: 0, stdout: "not JSON" }, { code: 0, stdout: JSON.stringify(listing([])) }])("fails a bad list before running scenarios %#", async response => {
    const cwd = await tempRoot();
    let calls = 0;
    await expect(runShard({ cwd, shard: "1/12", execute: async () => { calls++; return response; } })).rejects.toThrow();
    expect(calls).toBe(1);
  });
});
