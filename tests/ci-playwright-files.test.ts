/** Verify CI browser file isolation without starting browsers, servers, or a database. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseDiscovery, runShard } from "../scripts/ci-playwright-files.mjs";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const discovery = (files = ["a.spec.ts", "aXspec.ts"]) => ({
  config: { workers: 1, fullyParallel: false }, errors: [],
  suites: files.map((file, i) => ({ specs: [
    { file, id: `case-${i}`, tests: [{ projectName: "chromium" }] },
    { file, id: `case-${i}-two`, tests: [{ projectName: "chromium" }] },
  ] })).concat([{ specs: [{ file: "global.setup.ts", id: "setup", tests: [{ projectName: "setup" }] }] }]),
});
function workspace() { const dir = mkdtempSync(path.join(tmpdir(), "ci-playwright-files-")); dirs.push(dir); return dir; }

describe("per-file CI browser runner", () => {
  it("discovers the shard once and invokes each exact whole file without resharding", () => {
    const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const selections: string[] = [];
    const runChild = vi.fn((args: string[], options: { env: NodeJS.ProcessEnv }) => {
      calls.push({ args, env: options.env });
      if (args.includes("--list")) return { status: 0, stdout: JSON.stringify(discovery()) };
      selections.push(readFileSync(args[args.indexOf("--test-list") + 1], "utf8"));
      return { status: 0 };
    });
    expect(runShard({ shard: "3/8", artifactRoot: workspace(), runChild })).toBe(0);
    expect(calls[0].args).toEqual(["test", "--list", "--reporter=json", "--shard=3/8"]);
    expect(selections).toEqual(["[chromium] › a.spec.ts\n", "[chromium] › aXspec.ts\n"]);
    for (const call of calls.slice(1)) {
      expect(call.args.some(arg => arg.startsWith("--shard"))).toBe(false);
      expect(call.args).toContain("--workers=1");
      expect(call.args).not.toContain("--no-deps");
      expect(call.env.E2E_REUSE).toBe("0");
    }
  });

  it("continues after child failure and preserves separate artifact and report paths", () => {
    const outputs: string[] = [], reports: string[] = [];
    const runChild = vi.fn((args: string[], options: { env: NodeJS.ProcessEnv }) => {
      if (args.includes("--list")) return { status: 0, stdout: JSON.stringify(discovery()) };
      outputs.push(args[args.indexOf("--output") + 1]);
      reports.push(options.env.PLAYWRIGHT_HTML_OUTPUT_DIR!);
      return { status: outputs.length === 1 ? 1 : 0 };
    });
    expect(runShard({ shard: "1/8", artifactRoot: workspace(), runChild })).toBe(1);
    expect(outputs).toHaveLength(2);
    expect(new Set(outputs).size).toBe(2);
    expect(new Set(reports).size).toBe(2);
    expect(outputs.every(output => !reports.includes(output))).toBe(true);
  });

  it.each([{ status: null, signal: "SIGTERM" }, { status: null, error: new Error("spawn failed") }])(
    "propagates child execution failure and still runs the next file: %j", failure => {
      let runs = 0;
      const runChild = vi.fn((args: string[]) => {
        if (args.includes("--list")) return { status: 0, stdout: JSON.stringify(discovery()) };
        return ++runs === 1 ? failure : { status: 0 };
      });
      expect(runShard({ shard: "1/8", artifactRoot: workspace(), runChild })).toBe(1);
      expect(runs).toBe(2);
    },
  );

  it("accepts an empty shard without starting a server", () => {
    const runChild = vi.fn(() => ({ status: 0, stdout: JSON.stringify(discovery([])) }));
    expect(runShard({ shard: "8/8", artifactRoot: workspace(), runChild })).toBe(0);
    expect(runChild).toHaveBeenCalledTimes(1);
  });

  it.each([
    "not json", JSON.stringify({}), JSON.stringify({ ...discovery(), errors: [{ message: "load failed" }] }),
    JSON.stringify(discovery(["../escape.spec.ts"])), JSON.stringify(discovery(["bad›name.spec.ts"])),
    JSON.stringify(discovery(["same.spec.ts", "same.spec.ts"]).suites),
    JSON.stringify({ ...discovery(), config: { workers: 2, fullyParallel: false } }),
    JSON.stringify({ ...discovery(), suites: [{ specs: [{ file: "a.spec.ts", id: "x", tests: [{ projectName: "unknown" }] }] }] }),
  ])("rejects malformed or unsafe discovery before executing files: %s", json => {
    const runChild = vi.fn(() => ({ status: 0, stdout: json }));
    expect(() => runShard({ shard: "1/8", artifactRoot: workspace(), runChild })).toThrow();
    expect(runChild).toHaveBeenCalledTimes(1);
  });

  it("rejects duplicate case IDs instead of hiding duplicate assignment", () => {
    const report = discovery(); report.suites.push(report.suites[0]);
    expect(() => parseDiscovery(JSON.stringify(report))).toThrow(/duplicate/i);
  });

  it("fails closed on discovery process failure and invalid shard arguments", () => {
    const runChild = vi.fn(() => ({ status: 1, stdout: "{}" }));
    expect(() => runShard({ shard: "1/8", artifactRoot: workspace(), runChild })).toThrow(/discovery/i);
    expect(() => runShard({ shard: "0/8", artifactRoot: workspace(), runChild })).toThrow(/shard/i);
    expect(runChild).toHaveBeenCalledTimes(1);
  });
});
