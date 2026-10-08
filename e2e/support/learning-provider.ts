/** Local HTTP provider and dedicated Next server for genuine browser evaluation/approval. */
import { fork, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { copyFile, cp, mkdir, mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const CANDIDATE_INSTRUCTION = "Candidate instruction: separate timing from importance.";
export type LearningProviderCall = { system: string; user: string; purpose: "prompt-revision" | "priority-critic" | "priority-suggester" };

/** Start a loopback-only provider; unrecognised prompts fail rather than inventing evidence. */
export async function startLearningBrowserServer(port: number) {
  const calls: LearningProviderCall[] = [];
  const provider = createServer(async (request, response) => {
    try {
      if (request.url !== "/v1/chat/completions" || request.headers.authorization !== "Bearer kan80-local-fixture") {
        throw new Error("Unexpected fixture provider request.");
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const system = body.messages.find((message: { role: string }) => message.role === "system").content as string;
      const user = body.messages.find((message: { role: string }) => message.role === "user").content as string;
      const payload = JSON.parse(user);
      let answer: unknown;
      let purpose: LearningProviderCall["purpose"];
      if (payload.stage === "S8" && Array.isArray(payload.lessons)) {
        purpose = "prompt-revision";
        answer = { instruction_text: CANDIDATE_INSTRUCTION };
      } else if (Array.isArray(payload.placements)) {
        purpose = "priority-critic";
        answer = { reviews: payload.placements.map((placement: { gap_id: string }) => ({ gap_id: placement.gap_id, verdict: "keep", confidence: 90, note: "Supported by fixture evidence." })) };
      } else if (Array.isArray(payload.gaps) && Array.isArray(payload.axes)) {
        purpose = "priority-suggester";
        answer = { gaps: payload.gaps.map((gap: { id: string }) => ({ gap_id: gap.id, scores: Object.fromEntries(payload.axes.map((axis: { id: string }) => [axis.id, system.includes(CANDIDATE_INSTRUCTION) ? 20 : 80])), rationale: "Evidence supports this placement." })) };
      } else {
        throw new Error("Unsupported learning fixture prompt.");
      }
      calls.push({ system, user, purpose });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(answer) } }] }));
    } catch (error) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : "Fixture response failed." } }));
    }
  });
  let projectDir: string | undefined;
  let child: ChildProcess | undefined;
  let logs = "";
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    try {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        const killTimer = setTimeout(() => child?.kill("SIGKILL"), 5_000);
        try { await exited; } finally { clearTimeout(killTimer); }
      }
    } finally {
      provider.closeAllConnections();
      try {
        if (provider.listening) await new Promise<void>((done, reject) => provider.close(error => error ? reject(error) : done()));
      } finally {
        if (projectDir) await rm(projectDir, { recursive: true, force: true });
      }
    }
  }
  try {
    // Next's custom dev bootstrap reloads next.config from disk. Give it a
    // disposable project/config, with copied source and its own generated files.
    const root = process.cwd();
    await mkdir(resolve(".next"), { recursive: true });
    projectDir = await mkdtemp(resolve(".next/kan80-browser-"));
    await cp(join(root, "src"), join(projectDir, "src"), { recursive: true });
    for (const name of ["public", "node_modules", "package.json", "postcss.config.mjs"]) {
      await symlink(join(root, name), join(projectDir, name));
    }
    await copyFile("tsconfig.json", join(projectDir, "tsconfig.json"));
    await writeFile(join(projectDir, "next.config.mjs"), `import config from ${JSON.stringify(pathToFileURL(join(root, "next.config.ts")).href)};
export default { ...config, turbopack: { ...config.turbopack, root: ${JSON.stringify(root)} } };
`);
    provider.listen(0, "127.0.0.1");
    await once(provider, "listening");
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("Fixture provider has no TCP address.");
    child = fork(resolve("e2e/support/learning-next-server.mjs"), [], {
      env: { ...process.env, NODE_ENV: "development", SYNAPSE_TEST_STUB_LLM: "0", KAN80_BROWSER_PORT: String(port), KAN80_PROJECT_DIR: projectDir,
        XAI_API_KEY: "kan80-local-fixture", XAI_BASE_URL: `http://127.0.0.1:${address.port}/v1`, XAI_MODELS: "grok-4",
        ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", GEMINI_API_KEY: "", OPENROUTER_API_KEY: "", },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    child.stdout?.on("data", chunk => { logs += String(chunk); });
    child.stderr?.on("data", chunk => { logs += String(chunk); });
    await new Promise<void>((ready, reject) => {
      const timer = setTimeout(() => reject(new Error(`Learning browser server startup timed out.\n${logs}`)), 90_000);
      child!.once("message", () => { clearTimeout(timer); ready(); });
      child!.once("exit", code => { clearTimeout(timer); reject(new Error(`Learning browser server exited (${code}).\n${logs}`)); });
      child!.once("error", error => { clearTimeout(timer); reject(error); });
    });
    return { url: `http://127.0.0.1:${port}`, calls, close, logs: () => logs };
  } catch (error) {
    await close();
    throw error;
  }
}
