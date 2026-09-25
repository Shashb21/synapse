import { ownerGate } from "@/modules/auth/owner";
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { registerAccuracyStack } from "@/accuracy";
import { runAccuracyModule } from "@/accuracy/kernel/run";
import { AI_OFF_MESSAGE, aiEnabled } from "@/modules/kernel/ai-switch";
import { resolveParsePolicy } from "@/accuracy/modules/parse/parse-policy";
import { insertSourceFile } from "@/accuracy/store/source-store";
import { getWorkspace, getWorkspaceOrgId } from "@/accuracy/store/tenant";
import { mimeForFilename } from "@/lib/ingest/local-parse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

registerAccuracyStack();

const DOC_ROLES = new Set([
  "interview",
  "medical",
  "heor",
  "publications",
  "iis",
  "other",
]);

export async function POST(req: Request) {
  const denied = await ownerGate();
  if (denied) return denied;
  try {
    const form = await req.formData();
    const workspace_id = String(form.get("workspace_id") ?? "").trim();
    const doc_role_raw = String(form.get("doc_role") ?? "other").trim().toLowerCase();
    const doc_role = DOC_ROLES.has(doc_role_raw) ? doc_role_raw : "other";
    const file = form.get("file");

    if (!workspace_id) {
      return NextResponse.json({ ok: false, error: "workspace_id required" }, { status: 400 });
    }
    if (!(file instanceof File)) {
      return NextResponse.json({ ok: false, error: "file required" }, { status: 400 });
    }
    if (file.size === 0) {
      return NextResponse.json({ ok: false, error: "empty file" }, { status: 400 });
    }
    if (file.size > 40 * 1024 * 1024) {
      return NextResponse.json({ ok: false, error: "file too large (40MB max)" }, { status: 400 });
    }

    // With AI off there is no parser; gaps and tactics are entered by hand.
    if (!(await aiEnabled())) {
      return NextResponse.json({ ok: false, error: AI_OFF_MESSAGE, code: "ai_off" }, { status: 409 });
    }

    const workspace = await getWorkspace(workspace_id);
    if (!workspace) {
      return NextResponse.json({ ok: false, error: "Unknown workspace" }, { status: 404 });
    }
    const org_id = (await getWorkspaceOrgId(workspace_id)) ?? workspace.org_id;

    const filename = file.name || "upload.bin";
    const mime = file.type || mimeForFilename(filename);
    const policy = resolveParsePolicy({ filename, mime });

    const buffer = Buffer.from(await file.arrayBuffer());
    const checksum = createHash("sha256").update(buffer).digest("hex");

    const source = await insertSourceFile({
      workspace_id,
      org_id,
      filename,
      mime,
      checksum,
      doc_role,
    });

    let block_count = 0;
    let parser: string = policy.parser;
    let parse_error: string | null = null;

    // Parsing runs on the parse route's LLM, traced like any other module run.
    try {
      const result = await runAccuracyModule<{ parser: string; block_count: number }>({
        call_kind: "parse",
        agent_role: "proposer",
        input: {
          workspace_id,
          source_file_id: source.id,
          filename,
          mime,
          content_base64: buffer.toString("base64"),
        },
        actor: { name: "Source upload", function: "medical_affairs" },
        org_id,
        workspace_id,
      });
      parser = result.output.parser;
      block_count = result.output.block_count;
    } catch (error) {
      parse_error = error instanceof Error ? error.message : "Parse failed";
    }

    return NextResponse.json({
      ok: true,
      source_file_id: source.id,
      filename,
      mime,
      doc_role,
      parser,
      policy_reason: policy.reason,
      block_count,
      parse_error,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upload failed";
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
