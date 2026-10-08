/** Deterministic external provider for browser proof. No production route or domain fallback. */
import { createServer, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { createAccount, deleteAccountsLike, revokeAccountSessions } from "../../src/modules/auth/accounts";

export const KAN83_PORT = Number(process.env.E2E_PORT || 43217) + 10;
export const KAN83_URL = `http://127.0.0.1:${KAN83_PORT}`;
export const KAN83_PROVIDER_URL = `http://127.0.0.1:${KAN83_PORT + 1}`;
export const KAN83_EMAIL = `kan83-fixture-${KAN83_PORT}@example.test`;
export const KAN83_PASSWORD = "BrowserFixture83!Review";
export const KAN83_SOURCE = [
  "GAP01: Need outcomes and comparative evidence for NSCLC.",
  "GAP02: Need outcomes and comparative evidence for the clean rollback group.",
  ...Array.from({ length: 25 }, (_, index) => `GAP${String(index + 3).padStart(2, "0")}: Need distinct evidence item ${index + 3} for NSCLC.`),
  "TACTIC1: A proposed outcomes publication needs approval.",
  "TACTIC2: A cancelled outcomes survey will not proceed.",
  "TACTIC3: An outcomes registry has unknown lifecycle.",
  "TACTIC4: A planned chart review covers outcomes; comparative evidence is missing.",
].join("\n\n");

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- external provider fixture covers several distinct JSON envelopes
type Json = Record<string, any>; // External HTTP fixture payloads vary by provider purpose.
const unknown = { state: "unknown", value: null, reason: "not_stated", provenance: [] };
function respond(system: string, user: string): unknown {
  let input: Json = {};
  try { input = JSON.parse(user); } catch { /* Extraction's existing prompt is text. */ }
  if (system.startsWith("You structure text")) return { units: input.units.map((unit: Json) => ({ unit: unit.unit, blocks: [{ text: unit.text, kind: "paragraph", heading: null }], dropped_reason: null })) };
  if (system.includes("stakeholder") && input.opening) return { stakeholder_function: "medical_affairs", rationale: "Fixture medical evidence planning source" };
  if (system.startsWith("Compare every source block")) return { checked_block_ids: input.blocks.map((block: Json) => block.id), suspected_omissions: [], prior_issue_resolutions: [] };
  if (system.includes("You extract evidence gaps") || system.includes("You extract tactics already")) {
    const source_file_id = /source_file_id=(\S+)/.exec(user)?.[1];
    const blocks = [...user.matchAll(/### block_id=(\S+)[^\n]*\n([\s\S]*?)(?=\n\n### block_id=|$)/g)].map(match => ({ id: match[1], text: match[2].trim() }));
    const span = (block: Json) => ({ source_file_id, block_id: block.id, quote: block.text });
    const known = (value: string, block: Json) => ({ state: "known", value, provenance: [span(block)] });
    if (system.includes("You extract evidence gaps")) return { gaps: blocks.filter(block => /^GAP\d+:/.test(block.text)).map(block => ({ statement: block.text.split(": ")[1], external_id: block.text.split(":")[0], provenance: [span(block)],
      structured: { version: 1, description: known(block.text.split(": ")[1], block), indication: block.text.includes("NSCLC") ? known("NSCLC", block) : unknown, disease_setting: unknown, category: unknown, rationale: unknown, supporting_documents: unknown, interview_quotes: unknown } })) };
    return { tactics: blocks.filter(block => /^TACTIC\d+:/.test(block.text)).map(block => {
      const index = Number(/TACTIC(\d+)/.exec(block.text)![1]), status = ["proposed", "cancelled", "unknown", "planned"][index - 1];
      return { name: block.text.split(": ")[1], external_id: `T${index}`, type: "chart_review", status, evidence_question: "Need outcomes and comparative evidence", origin: "inventory", provenance: [span(block)],
        structured: { version: 1, description: known(block.text.split(": ")[1], block), objective: unknown, owner: unknown, timing: unknown, outputs: unknown, lifecycle: status === "unknown" ? unknown : known(status, block) } };
    }) };
  }
  if (system.includes("same evidence gap") || system.includes("one decision per pair_id")) return { decisions: [...user.matchAll(/pair_id=(\S+)/g)].map(match => ({ pair_id: match[1], same: false, rationale: "Distinct fixture source item" })) };
  if (system.startsWith("You decide whether a tactic")) return { overall: input.tactic.name?.includes("planned chart review") && input.gap.statement?.includes("outcomes and comparative") ? "partial" : "limited", quote_block_ids: input.evidence_blocks.map((block: Json) => block.id), confidence: 0.9, rationale: "Fixture: outcomes overlap only; comparative evidence remains missing" };
  if (system.startsWith("You review a draft gap")) return { accept: true, issues: [] };
  if (system.includes("addressed child is the slice")) return { parent_gap_id: input.gap.id, addressed_name: "Outcomes evidence", addressed_statement: `Need outcome evidence from the planned chart review${input.gap.statement.includes("clean rollback") ? " for the clean rollback group" : ""}.`, open_name: "Comparative evidence", open_statement: `Need comparative evidence against standard care${input.gap.statement.includes("clean rollback") ? " for the clean rollback group" : ""}.`, addressed_tactic_ids: input.mapped_tactics.filter((row: Json) => row.counts_toward_addressing).map((row: Json) => row.id), uncovered_dimensions: ["comparator"], addressed_evidence: input.permitted_evidence, open_evidence: input.permitted_evidence.filter((span: Json) => span.quote.startsWith("GAP")), confidence: 90, rationale: "Fixture chart review supports outcomes only" };
  if (input.placements) return { reviews: input.placements.map((row: Json) => ({ gap_id: row.gap_id, verdict: "keep", confidence: 90, note: "Fixture scores reflect the missing evidence" })) };
  if (system.includes('"verdict":"keep"')) return { verdict: "keep", confidence: 90, note: "Fixture source supports the two distinct slices", issues: [] };
  if (system.includes('"verdict":"accept"')) return { verdict: "accept", confidence: 90, note: "Fixture evidence verified for each slice" };
  if (input.gaps && input.axes) return { gaps: input.gaps.map((gap: Json) => ({ gap_id: gap.id, scores: Object.fromEntries(input.axes.map((axis: Json) => [axis.id, axis.id === "effort_cost" ? 80 : 20])), rationale: "Fixture: comparator remains missing with low urgency" })) };
  throw new Error(`Unsupported fixture prompt: ${system.slice(0, 100)}`);
}

export async function startKan83Provider(): Promise<() => Promise<void>> {
  if (process.env.NODE_ENV === "production") throw new Error("Browser fixture cannot run in production");
  const originalTsconfigText = await readFile("tsconfig.json", "utf8");
  const originalTsconfig = JSON.parse(originalTsconfigText);
  await deleteAccountsLike(KAN83_EMAIL);
  const account = await createAccount({ email: KAN83_EMAIL, name: "KAN83 browser reviewer", password: KAN83_PASSWORD, role: "contributor", is_admin: true, email_verified: true, actor_function: "medical_affairs", created_by: "KAN83 browser fixture" });
  let failInventory = true, failPriority = false, child: ChildProcess | undefined, server: Server | undefined;
  const log = createWriteStream(`/private/tmp/kan83-browser-server-${KAN83_PORT}.log`);
  async function stop() {
    if (child && child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      const timer = setTimeout(() => child?.kill("SIGKILL"), 10_000);
      await exited; clearTimeout(timer);
    }
    if (server?.listening) await new Promise<void>(resolve => server!.close(() => resolve()));
    // Next adds this secondary server's type paths and reformats tsconfig.
    // Remove only fixture additions; retain any concurrent substantive edits.
    const currentTsconfig = JSON.parse(await readFile("tsconfig.json", "utf8"));
    const fixtureTypes = [".next/kan83-browser/types/**/*.ts", ".next/kan83-browser/dev/types/**/*.ts"];
    currentTsconfig.include = currentTsconfig.include.filter((path: string) => !fixtureTypes.includes(path) || originalTsconfig.include.includes(path));
    await writeFile("tsconfig.json", JSON.stringify(currentTsconfig) === JSON.stringify(originalTsconfig)
      ? originalTsconfigText : `${JSON.stringify(currentTsconfig, null, 2)}\n`);
    log.end(); await revokeAccountSessions(account.id); await deleteAccountsLike(KAN83_EMAIL);
    await (globalThis as unknown as { pg?: { end: () => Promise<void> } }).pg?.end();
  }
  try {
    server = createServer(async (request, response) => {
      try {
        if (request.url === "/fail-priority") { failPriority = true; response.end("ok"); return; }
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const system = body.messages.find((message: Json) => message.role === "system")?.content ?? "";
        const user = body.messages.find((message: Json) => message.role === "user")?.content ?? "";
        if ((failInventory && system.includes("You extract tactics already")) || (failPriority && system.startsWith("You place open evidence gaps"))) {
          if (system.includes("You extract tactics already")) failInventory = false; else failPriority = false;
          response.writeHead(400, { "content-type": "application/json" }); response.end(JSON.stringify({ error: { message: "Fixture provider refused this request", type: "invalid_request_error" } })); return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(respond(system, user)) } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      } catch (error) { response.writeHead(500); response.end(String(error)); }
    });
    await new Promise<void>(resolve => server!.listen(KAN83_PORT + 1, "127.0.0.1", resolve));
    child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", String(KAN83_PORT)], {
      env: { ...process.env, SYNAPSE_TEST_STUB_LLM: "0", SYNAPSE_TEST_ANON_API: "", E2E_NEXT_DIST_DIR: ".next/kan83-browser", XAI_API_KEY: "kan83-local-fixture", XAI_BASE_URL: `${KAN83_PROVIDER_URL}/v1`, ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", GEMINI_API_KEY: "", OPENROUTER_API_KEY: "" }, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.pipe(log); child.stderr!.pipe(log);
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error("KAN83 fixture Next server exited; inspect its log");
      try { const response = await fetch(`${KAN83_URL}/login`); if (response.ok) return stop; } catch { /* still starting */ }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error("KAN83 fixture Next server startup timed out");
  } catch (error) { await stop(); throw error; }
}
