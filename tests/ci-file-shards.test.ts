import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parseListing, runGroups } from "../scripts/ci-file-shards";

const listing = `Listing tests:\n  [setup] › global.setup.ts:9:6 › setup\n  [chromium] › a.spec.ts:1:1 › first\n  [chromium] › b.spec.ts:2:1 › second\nTotal: 3 tests in 3 files\n`;

describe("file-scoped shard runner", () => {
  it("groups the exact selected descriptions by file", () => {
    const groups = parseListing(listing);
    expect([...groups.keys()]).toEqual(["a.spec.ts", "b.spec.ts"]);
    expect(groups.get("a.spec.ts")).toEqual(["[chromium] › a.spec.ts:1:1 › first"]);
  });

  it("rejects malformed, empty, and duplicate selections", () => {
    expect(() => parseListing(listing.replace("[chromium]", "[other]"))).toThrow();
    expect(() => parseListing("Listing tests:\nTotal: 0 tests in 0 files\n")).toThrow();
    expect(() => parseListing(listing.replace("  [chromium] › b.spec.ts:2:1 › second", "  [chromium] › a.spec.ts:1:1 › first"))).toThrow();
  });

  it("continues after a failure and reports it", async () => {
    const visited: string[] = [];
    const status = await runGroups(parseListing(listing), async (file: string) => {
      visited.push(file);
      return await new Promise<number>((resolve, reject) => {
        const child = spawn(process.execPath, ["-e", `process.exit(${file === "a.spec.ts" ? 1 : 0})`]);
        child.once("error", reject);
        child.once("close", (code) => resolve(code ?? 1));
      });
    }, () => false);
    expect(visited).toEqual(["a.spec.ts", "b.spec.ts"]);
    expect(status).toBe(1);
  });

  it("does not start another group after interruption", async () => {
    let calls = 0;
    const status = await runGroups(parseListing(listing), async () => { calls++; return 0; }, () => calls > 0);
    expect(calls).toBe(1);
    expect(status).toBe(1);
  });
});
