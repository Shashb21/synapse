/** Run a native Playwright shard with a fresh owned webServer for each spec file. */
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Validate native JSON listing and retain each Chromium scenario exactly once.
 * @param {unknown} listing Native Playwright JSON reporter output.
 * @returns {{file: string, ids: string[]}[]} Files in native selection order.
 * @throws {Error} If discovery is empty, malformed, or contains unsafe paths.
 */
export function selectSpecs(listing) {
  if (!listing || typeof listing !== "object" || !Array.isArray(listing.suites) ||
      !Array.isArray(listing.errors) || listing.errors.length) {
    throw new Error("Invalid Playwright listing or discovery errors");
  }
  const files = new Map();
  const ids = new Set();
  function visit(suites) {
    for (const suite of suites) {
      if (!suite || typeof suite !== "object" ||
          (suite.specs !== undefined && !Array.isArray(suite.specs)) ||
          (suite.suites !== undefined && !Array.isArray(suite.suites))) {
        throw new Error("Malformed Playwright suite");
      }
      for (const spec of suite.specs ?? []) {
        if (!spec || !Array.isArray(spec.tests) || !spec.tests.length) throw new Error("Malformed Playwright spec");
        for (const test of spec.tests) {
          if (test.projectName === "setup") continue;
          if (test.projectName !== "chromium") throw new Error("Unexpected Playwright project");
          const { file, id } = spec;
          if (typeof file !== "string" || file !== file.trim() || file.startsWith("#") ||
              !file.endsWith(".spec.ts") ||
              file.split("/").some(part => !part || part === "." || part === "..") ||
              /[\\\r\n>›]/u.test(file) || path.isAbsolute(file) ||
              typeof id !== "string" || !id || ids.has(id)) {
            throw new Error("Unsafe file path or duplicate/missing Chromium scenario ID");
          }
          ids.add(id);
          if (!files.has(file)) files.set(file, { file, ids: [] });
          files.get(file).ids.push(id);
        }
      }
      visit(suite.suites ?? []);
    }
  }
  visit(listing.suites);
  if (!files.size) throw new Error("Empty Chromium selection");
  return [...files.values()];
}

/** @typedef {{args: string[], cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal, capture?: boolean}} Command */
/** @typedef {{code: number, stdout: string}} Result */

/** Await Playwright's own exit so it can shut down its owned webServer. */
async function executePlaywright({ args, cwd, env, signal, capture }) {
  if (signal?.aborted) throw new Error("Playwright launch cancelled");
  const cli = path.join(path.dirname(createRequire(import.meta.url).resolve("playwright/package.json")), "cli.js");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "test", ...args], {
      cwd, env, stdio: ["inherit", capture ? "pipe" : "inherit", "inherit"],
    });
    let stdout = "";
    child.stdout?.on("data", data => { stdout += data.toString(); });
    // Playwright watches SIGINT to finish tasks and tear down its webServer.
    const interrupt = () => { child.kill("SIGINT"); };
    signal?.addEventListener("abort", interrupt, { once: true });
    // Close the small race between the initial cancellation check and registration.
    if (signal?.aborted) interrupt();
    child.once("error", error => {
      signal?.removeEventListener("abort", interrupt);
      reject(error);
    });
    child.once("close", code => {
      signal?.removeEventListener("abort", interrupt);
      resolve({ code: code ?? 1, stdout });
    });
  });
}

/**
 * Discover the unchanged native shard, then await one Playwright invocation per file.
 * Scenario failures continue to later files; discovery/launch failures fail closed.
 * @param {{shard: string, cwd?: string, signal?: AbortSignal, testList?: string, execute?: (command: Command) => Promise<Result>}} options Runner options.
 * @returns {Promise<number>} Zero only when every selected file passed.
 * @throws {Error} On invalid selection, discovery failure, or process launch failure.
 */
export async function runShard({ shard, cwd = process.cwd(), signal, testList, execute = executePlaywright }) {
  const match = /^(\d+)\/(\d+)$/u.exec(shard);
  if (!match || Number(match[1]) < 1 || Number(match[1]) > Number(match[2]) ||
      !Number.isSafeInteger(Number(match[2]))) throw new Error(`Invalid shard: ${shard}`);
  const root = path.join(cwd, "test-results", "per-spec", `shard-${match[1]}-of-${match[2]}`);
  await mkdir(path.join(root, "selections"), { recursive: true });
  const env = { ...process.env, E2E_REUSE: "0" };
  const discovered = await execute({
    args: ["--list", `--shard=${shard}`, "--reporter=json", ...(testList ? [`--test-list=${testList}`] : [])],
    cwd, env, signal, capture: true,
  });
  if (discovered.code !== 0) throw new Error(`Playwright discovery failed (${discovered.code})`);
  const specs = selectSpecs(JSON.parse(discovered.stdout));
  await writeFile(path.join(root, "selection.json"), JSON.stringify({ shard, specs }, null, 2));
  const outcomes = [];
  try {
    for (const [index, spec] of specs.entries()) {
      if (signal?.aborted) break;
      const label = `${String(index + 1).padStart(3, "0")}-${path.basename(spec.file, ".spec.ts")}`;
      const selection = path.join(root, "selections", `${label}.txt`);
      const output = path.join(root, label);
      await writeFile(selection, `${spec.file}\n`);
      console.log(`\n[per-spec ${shard}] ${index + 1}/${specs.length}: ${spec.file}`);
      try {
        const result = await execute({
          args: [`--test-list=${selection}`, "--project=chromium", "--reporter=line", `--output=${output}`],
          cwd, env, signal,
        });
        outcomes.push({ file: spec.file, code: result.code, output });
      } catch (error) {
        outcomes.push({ file: spec.file, error: error instanceof Error ? error.message : String(error), output });
        throw error;
      }
    }
  } finally {
    await writeFile(path.join(root, "outcomes.json"), JSON.stringify(outcomes, null, 2));
  }
  return !signal?.aborted && outcomes.length === specs.length && outcomes.every(result => result.code === 0) ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  const interrupt = signal => { controller.abort(signal); };
  const onInt = () => interrupt("SIGINT");
  const onTerm = () => interrupt("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  try {
    const args = process.argv.slice(2);
    if (!args.length || args.some(arg => !/^--(shard|test-list)=.+$/u.test(arg)) ||
        args.filter(arg => arg.startsWith("--shard=")).length !== 1 ||
        args.filter(arg => arg.startsWith("--test-list=")).length > 1) {
      throw new Error("Usage: node scripts/ci-playwright-specs.mjs --shard=N/T [--test-list=path]");
    }
    process.exitCode = await runShard({
      shard: args.find(arg => arg.startsWith("--shard=")).slice(8),
      testList: args.find(arg => arg.startsWith("--test-list="))?.slice(12),
      signal: controller.signal,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
  }
}
