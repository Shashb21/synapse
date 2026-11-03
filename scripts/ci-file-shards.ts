/** Run a native Playwright shard one selected file at a time. */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Parse Playwright's list output, rejecting anything unexpected. */
export function parseListing(output: string): Map<string, string[]> {
  const lines = output.trim().split(/\r?\n/);
  if (lines.shift() !== "Listing tests:") throw new Error("Invalid listing header");
  const footer = lines.pop()?.match(/^Total: (\d+) tests? in \d+ files?$/);
  if (!footer || Number(footer[1]) !== lines.length) throw new Error("Invalid listing total");
  const groups = new Map<string, string[]>();
  const seen = new Set<string>();
  for (const line of lines) {
    const match = line.match(/^  \[(setup|chromium)\] › (.+?):\d+:\d+ › (.+)$/);
    if (!match || seen.has(line)) throw new Error(`Invalid or duplicate test: ${line}`);
    seen.add(line);
    if (match[1] === "setup") continue;
    const tests = groups.get(match[2]) ?? [];
    tests.push(line.trim());
    groups.set(match[2], tests);
  }
  if (!groups.size) throw new Error("Shard has no chromium tests");
  return groups;
}

/** Run all groups unless interrupted, retaining any earlier failure. */
export async function runGroups(groups: Map<string, string[]>, run: (file: string, tests: string[], index: number) => Promise<number>, interrupted: () => boolean): Promise<number> {
  let failed = false;
  let index = 0;
  for (const [file, tests] of groups) {
    if (interrupted()) return 1;
    try { if (await run(file, tests, index++) !== 0) failed = true; }
    catch (error) { console.error(error); failed = true; }
  }
  return failed || interrupted() ? 1 : 0;
}

async function main() {
  const shard = process.argv[2];
  if (!/^(?:[1-9]|1[0-6])$/.test(shard ?? "")) throw new Error("Expected a shard number from 1 to 16");
  const verify = process.argv[3] === "--verify";
  if (process.argv.length > (verify ? 4 : 3)) throw new Error("Unexpected arguments");
  const temp = await mkdtemp(path.join(tmpdir(), "synapse-shard-"));
  let interrupted = false;
  let child: ReturnType<typeof spawn> | undefined;
  const onSignal = (signal: NodeJS.Signals) => { interrupted = true; child?.kill(signal); };
  const onInt = () => onSignal("SIGINT");
  const onTerm = () => onSignal("SIGTERM");
  process.on("SIGINT", onInt); process.on("SIGTERM", onTerm);
  const invoke = (args: string[], capture: boolean, env: Partial<NodeJS.ProcessEnv> = {}) => new Promise<{ status: number; output: string }>((resolve, reject) => {
    child = spawn(process.execPath, [path.resolve("node_modules/@playwright/test/cli.js"), "test", ...args], { env: { ...process.env, ...env }, stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit" });
    let output = "";
    child.stdout?.on("data", (chunk) => { output += chunk; });
    child.once("error", reject);
    child.once("close", (code) => { child = undefined; resolve({ status: code ?? 1, output }); });
  });
  try {
    const discovery = await invoke(["--list", `--shard=${shard}/16`], true);
    if (discovery.status !== 0 || interrupted) throw new Error("Shard discovery failed");
    const groups = parseListing(discovery.output);
    const status = await runGroups(groups, async (file, tests, index) => {
      const manifest = path.join(temp, `${index}.txt`);
      await writeFile(manifest, `${tests.join("\n")}\n`);
      if (interrupted) return 1;
      console.log(`Shard ${shard}: ${file} (${tests.length} tests)`);
      const args = [`--test-list=${manifest}`];
      if (verify) {
        const result = await invoke(["--list", ...args], true);
        if (result.status !== 0) throw new Error(`List failed for ${file}`);
        const actual = [...parseListing(result.output).values()].flat();
        if (actual.length !== tests.length || actual.some((test, i) => test !== tests[i])) throw new Error(`Selection mismatch for ${file}`);
        return 0;
      }
      const result = await invoke([...args, "--reporter=line", `--output=test-results/shard-${shard}-file-${index}`], false);
      return result.status;
    }, () => interrupted);
    if (status) process.exitCode = 1;
  } finally {
    process.off("SIGINT", onInt); process.off("SIGTERM", onTerm);
    await rm(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
