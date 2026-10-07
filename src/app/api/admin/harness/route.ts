import { NextResponse } from "next/server";
import "@/modules";
import { ownerGate } from "@/modules/auth/owner";
import { requestIdentity } from "@/modules/auth/request";
import { isAiSectionId } from "@/modules/kernel/ai-sections";
import { AiDisabledError } from "@/modules/kernel/ai-switch";
import { HarnessNoModelError, HarnessNotBuiltError, harnessPartialGaps, runHarness } from "@/modules/harness/harness";
import { EVIDENCE_DOMAINS, type EvidenceDomain } from "@/lib/iegp/enums";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** A live model run can take a while (propose, critique, judge). */
export const maxDuration = 300;

const NO_STORE = { "cache-control": "no-store" };

/** The sandbox's partially addressed gaps, for the split case's picker. Owner only. */
export async function GET() {
  const denied = await ownerGate();
  if (denied) return denied;
  try {
    return NextResponse.json({ partial_gaps: await harnessPartialGaps() }, { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

/** `{ case, mode, ...input }` runs one AI use case in the harness sandbox. Owner only. */
export async function POST(request: Request) {
  const denied = await ownerGate();
  if (denied) return denied;
  let body: Record<string, unknown> | null;
  try {
    body = (await request.json()) as Record<string, unknown> | null;
  } catch {
    return NextResponse.json({ error: "Invalid JSON", code: "invalid_json" }, { status: 400, headers: NO_STORE });
  }
  if (!body || typeof body !== "object" || !isAiSectionId(body.case)) {
    return NextResponse.json({ error: "Choose an AI use case." }, { status: 400 });
  }
  const text = (key: string) => (typeof body[key] === "string" ? (body[key] as string) : undefined);
  const domain = text("gap_domain");
  try {
    const identity = await requestIdentity(body);
    const result = await runHarness({
      case: body.case,
      actor: identity.actor,
      input: {
        mode: body.mode === "custom" ? "custom" : "sample",
        demo_id: text("demo_id"),
        title: text("title"),
        text: text("text"),
        gap_name: text("gap_name"),
        gap_statement: text("gap_statement"),
        gap_domain: domain && (EVIDENCE_DOMAINS as readonly string[]).includes(domain) ? (domain as EvidenceDomain) : undefined,
        gap_id: text("gap_id"),
      },
    });
    return NextResponse.json({ ok: true, result }, { headers: NO_STORE });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code =
      error instanceof HarnessNotBuiltError
        ? "not_built"
        : error instanceof HarnessNoModelError
          ? "no_model"
          : error instanceof AiDisabledError
            ? "ai_off"
            : "failed";
    return NextResponse.json({ error: message, code }, { status: code === "failed" ? 500 : 409, headers: NO_STORE });
  }
}
