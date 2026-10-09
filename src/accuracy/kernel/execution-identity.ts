/** Fingerprints of executed source and prompts, retained through ordinary run steps. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { RunStep } from "./contracts";

export type ExecutionIdentity = {
  schema_version: "execution-identity-v1";
  status: "available" | "unavailable";
  git_commit: string | null;
  worktree: "clean" | "dirty" | "unknown";
  source_fingerprint: string | null;
  prompt_sources_fingerprint: string | null;
  build_id: string | null;
  deployment_id: string | null;
};
export type CompletionIdentity = {
  completion_id: string;
  purpose: string;
  system_fingerprint: string;
  user_fingerprint: string;
  provider_id: string;
  configured_model: string;
  temperature: number;
  max_tokens: number;
  response_model: string | null;
  provider_revision: string | null;
  status: "started" | "succeeded" | "failed";
};
export type ExecutionEvidence = {
  status: "available" | "unavailable";
  identities: ExecutionIdentity[];
  completions: CompletionIdentity[];
};
const identifier = z.string().trim().min(1);
const executionIdentitySchema: z.ZodType<ExecutionIdentity> = z.strictObject({
  schema_version: z.literal("execution-identity-v1"), status: z.enum(["available", "unavailable"]),
  git_commit: identifier.nullable(), worktree: z.enum(["clean", "dirty", "unknown"]),
  source_fingerprint: identifier.nullable(), prompt_sources_fingerprint: identifier.nullable(),
  build_id: identifier.nullable(), deployment_id: identifier.nullable(),
}).refine(row => row.status !== "available" || !!(row.source_fingerprint || row.build_id || row.deployment_id));
const completionIdentitySchema: z.ZodType<CompletionIdentity> = z.strictObject({
  completion_id: identifier, purpose: identifier, system_fingerprint: identifier, user_fingerprint: identifier,
  provider_id: identifier, configured_model: identifier, temperature: z.number().finite(), max_tokens: z.number().int().nonnegative(),
  response_model: identifier.nullable(), provider_revision: identifier.nullable(), status: z.enum(["started", "succeeded", "failed"]),
});

export function executionFingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Hash source bytes, including uncommitted files, without reading credentials or generated output. */
export function captureExecutionIdentity(root = process.cwd()): ExecutionIdentity {
  const files: string[] = [];
  const visit = (relative: string) => {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && /\.(?:[cm]?[jt]sx?|json|css|sql)$/.test(entry.name)) files.push(path);
    }
  };
  let source_fingerprint: string | null = null;
  let prompt_sources_fingerprint: string | null = null;
  try {
    if (existsSync(join(root, "src"))) visit("src");
    for (const name of ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "tsconfig.json", "next.config.ts", "next.config.js", "next.config.mjs"]) {
      if (existsSync(join(root, name))) files.push(name);
    }
    const hashFiles = (paths: string[]) => {
      const hash = createHash("sha256");
      for (const path of paths.sort()) {
        const contents = readFileSync(join(root, path));
        hash.update(JSON.stringify([path, contents.length])); hash.update(contents);
      }
      return hash.digest("hex");
    };
    if (files.some(path => path.startsWith("src/"))) source_fingerprint = hashFiles(files);
    // Includes inline prompt renderers as well as declared prompt modules; rendered inputs are separate.
    const prompts = files.filter(path => path.startsWith("src/accuracy/modules/") || path.startsWith("src/modules/"));
    if (prompts.length) prompt_sources_fingerprint = hashFiles(prompts);
  } catch { /* A partial/unreadable source tree cannot identify executed source. */ }
  const git = (...args: string[]) => {
    try { return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim(); }
    catch { return null; }
  };
  const git_commit = git("rev-parse", "HEAD");
  const changes = git_commit ? git("status", "--porcelain", "--untracked-files=all", "--", "src", "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "tsconfig.json", "next.config.ts", "next.config.js", "next.config.mjs") : null;
  let build_id: string | null = null;
  try { build_id = readFileSync(join(root, process.env.E2E_NEXT_DIST_DIR || ".next", "BUILD_ID"), "utf8").trim() || null; }
  catch { /* Dev runs or source-only checkouts need not have a Next build. */ }
  // Next may inline false when no deployment ID is configured.
  const deploymentId = process.env.NEXT_DEPLOYMENT_ID;
  const deployment_id = typeof deploymentId === "string" ? deploymentId.trim() || null : null;
  return { schema_version: "execution-identity-v1", status: source_fingerprint || build_id || deployment_id ? "available" : "unavailable",
    git_commit, worktree: changes === null ? "unknown" : changes ? "dirty" : "clean",
    source_fingerprint, prompt_sources_fingerprint, build_id, deployment_id };
}

/** Preserve all prepared/retried identities and interrupted completions; never fill historical gaps. */
export function executionEvidenceFromSteps(steps: RunStep[] | unknown): ExecutionEvidence {
  let malformed = false;
  const rows = (Array.isArray(steps) ? steps : []).filter((row): row is Pick<RunStep, "name" | "data"> => {
    if (!row || typeof row !== "object" || Array.isArray(row) || typeof row.name !== "string") {
      malformed = true;
      return false;
    }
    return true;
  });
  const identities = rows.filter(row => row.name === "execution:identity").flatMap(row => {
    const parsed = executionIdentitySchema.safeParse(row.data);
    if (!parsed.success) { malformed = true; return []; }
    return [parsed.data];
  });
  const byId = new Map<string, CompletionIdentity>();
  for (const row of rows) {
    if (!["llm:completion:started", "llm:completion:finished"].includes(row.name)) continue;
    const parsed = completionIdentitySchema.safeParse(row.data);
    if (!parsed.success) { malformed = true; continue; }
    const identity = parsed.data;
    byId.set(identity.completion_id, identity);
  }
  const rawCompletions = rows.filter(row => row.name.startsWith("llm:") && !row.name.startsWith("llm:completion:")).length;
  // Restoring legacy preparation into a new recorder must not invent identity for the old paid calls.
  if (rawCompletions > byId.size) malformed = true;
  return { status: !malformed && identities.length && identities.every(row => row.status === "available") ? "available" : "unavailable",
    identities, completions: [...byId.values()] };
}

/** Condition compatibility excludes dynamic prompt hashes, completion IDs, counts and round numbers. */
export function executionCompatibility(evidence?: ExecutionEvidence | null): unknown {
  if (!evidence || evidence.status !== "available" || !evidence.identities.length
    || evidence.identities.some(row => !executionIdentitySchema.safeParse(row).success || row.status !== "available")
    || evidence.completions.some(row => !completionIdentitySchema.safeParse(row).success)) return null;
  const unique = (rows: unknown[]) => [...new Set(rows.map(row => JSON.stringify(row)))].sort().map(row => JSON.parse(row));
  return { identities: unique(evidence.identities), completion_configuration: unique(evidence.completions.map(row => ({
    purpose: row.purpose.replace(/:(?:r|a|b)\d+/g, ""),
    provider_id: row.provider_id, configured_model: row.configured_model, temperature: row.temperature, max_tokens: row.max_tokens,
    response_model: row.response_model, provider_revision: row.provider_revision,
  }))) };
}
