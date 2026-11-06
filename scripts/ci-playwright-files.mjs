/**
 * @typedef {{ status: number | null, stdout?: string | null, signal?: string | null, error?: Error }} ChildResult
 * @callback ChildRunner
 * @param {string[]} args
 * @param {{ capture: boolean, env: NodeJS.ProcessEnv }} options
 * @returns {ChildResult}
 */

/** Run one CI shard with a fresh Playwright-owned server for every browser file. */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Validate discovery and group every assigned browser case into its exact file. */
export function parseDiscovery(json) {
  let report;
  try { report = JSON.parse(json); }
  catch { throw new Error("Invalid Playwright discovery JSON"); }
  if (!report || !Array.isArray(report.suites) || !Array.isArray(report.errors) ||
      report.errors.length || report.config?.workers !== 1 || report.config?.fullyParallel !== false) {
    throw new Error("Invalid Playwright discovery: expected error-free serial configuration");
  }
  const files = new Map();
  const ids = new Set();
  function visit(suite) {
    if (!suite || (suite.specs !== undefined && !Array.isArray(suite.specs)) ||
        (suite.suites !== undefined && !Array.isArray(suite.suites))) {
      throw new Error("Invalid discovery suite");
    }
    for (const spec of suite.specs ?? []) {
      if (!spec || typeof spec.id !== "string" || !spec.id ||
          typeof spec.file !== "string" || !spec.file ||
          /[\r\n:>›\\]/u.test(spec.file) || spec.file.trim() !== spec.file ||
          path.posix.isAbsolute(spec.file) || path.posix.normalize(spec.file) !== spec.file ||
          spec.file.startsWith("../") || !Array.isArray(spec.tests) || !spec.tests.length) {
        throw new Error("Invalid discovery case or unsafe test-list file path");
      }
      for (const test of spec.tests) {
        if (test?.projectName === "setup") continue;
        if (test?.projectName !== "chromium") throw new Error("Unsupported discovery browser project");
        if (ids.has(spec.id)) throw new Error("Duplicate browser case in discovery");
        ids.add(spec.id);
        if (!files.has(spec.file)) files.set(spec.file, { file: spec.file, ids: [] });
        files.get(spec.file).ids.push(spec.id);
      }
    }
    for (const child of suite.suites ?? []) visit(child);
  }
  for (const suite of report.suites) visit(suite);
  return [...files.values()];
}

/** Run the installed CLI directly, without a shell; wait for Playwright teardown. */
function runPlaywright(args, { capture, env }) {
  const require = createRequire(import.meta.url);
  return spawnSync(process.execPath, [require.resolve("@playwright/test/cli"), ...args], {
    encoding: "utf8", env, shell: false,
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    maxBuffer: 32 * 1024 * 1024,
  });
}

/**
 * Discover a shard, run each whole file sequentially, and aggregate failures.
 * @param {{ shard: string, artifactRoot?: string, runChild?: ChildRunner }} options
 * @returns {number} Nonzero if any browser file failed.
 */
export function runShard({ shard, artifactRoot, runChild = runPlaywright }) {
  const match = /^(\d+)\/(\d+)$/u.exec(shard ?? "");
  if (!match || Number(match[1]) < 1 || Number(match[1]) > Number(match[2])) {
    throw new Error("Expected a valid shard argument such as 1/8");
  }
  // A CI file must never attach to a previous invocation's server.
  const env = { ...process.env, E2E_REUSE: "0" };
  const discovered = runChild(["test", "--list", "--reporter=json", `--shard=${shard}`], { capture: true, env });
  if (discovered.status !== 0 || discovered.error || discovered.signal) {
    throw new Error("Playwright discovery process failed");
  }
  const files = parseDiscovery(discovered.stdout);
  const root = path.resolve(artifactRoot ?? `test-results/shard-${match[1]}-of-${match[2]}`);
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, "manifest.json"), JSON.stringify({ shard, files }, null, 2));
  console.log(`Shard ${shard}: ${files.length} files, ${files.reduce((sum, file) => sum + file.ids.length, 0)} browser cases`);
  let failed = false;
  for (const [index, file] of files.entries()) {
    const directory = path.join(root, `file-${String(index + 1).padStart(3, "0")}`);
    mkdirSync(directory, { recursive: true });
    const selection = path.join(directory, "selection.txt");
    // Native test-list compares literal relative paths, not CLI regular expressions.
    writeFileSync(selection, `[chromium] › ${file.file}\n`);
    console.log(`Running ${index + 1}/${files.length}: ${file.file}`);
    try {
      const result = runChild([
        "test", "--test-list", selection, "--workers=1", "--reporter=line,html",
        "--output", path.join(directory, "results"),
      ], { capture: false, env: {
        ...env, PLAYWRIGHT_HTML_OPEN: "never", PLAYWRIGHT_HTML_OUTPUT_DIR: path.join(directory, "report"),
      } });
      if (result.status !== 0 || result.error || result.signal) {
        failed = true;
        console.error(`File failed: ${file.file} (exit ${result.status}, signal ${result.signal ?? "none"})`);
      }
    } catch (error) {
      failed = true;
      console.error(`Could not run ${file.file}: ${error instanceof Error ? error.message : "unknown child error"}`);
    }
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error("Usage: node scripts/ci-playwright-files.mjs N/TOTAL");
    process.exitCode = runShard({ shard: process.argv[2] });
  } catch (error) {
    console.error(error instanceof Error ? error.message : "CI browser runner failed");
    process.exitCode = 1;
  }
}
